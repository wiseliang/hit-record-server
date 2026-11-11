const crypto = require("crypto"),
  pool = require("../config/database"),
  model = require("../models/tasksV12"),
  school = require("./academicSchool"),
  worklog = require("./worklogSchool"),
  schedule = require("./worklogSchedule"),
  summary = require("./overviewSummary"),
  { AppError } = require("../utils/errors");
const running = new Map();
const kindOf = (k) => {
  if (!["academic", "worklog"].includes(k))
    throw new AppError(
      400,
      "INVALID_OVERVIEW_KIND",
      "请选择学情日志或工作日志",
    );
  return k;
};
async function connection(openid) {
  const [rows] = await pool.query(
    "SELECT connection_id,calendar FROM school_login_sessions WHERE openid=?",
    [openid],
  );
  return rows[0];
}
async function raw(id, openid) {
  const [rows] = await pool.query(
      "SELECT *,expires_at>UTC_TIMESTAMP() AS fresh FROM overview_snapshots WHERE id=? AND openid=?",
      [id, openid],
    ),
    conn = await connection(openid);
  if (
    !rows[0] ||
    !rows[0].fresh ||
    !conn ||
    rows[0].connection_id !== conn.connection_id
  )
    throw new AppError(
      404,
      "OVERVIEW_NOT_FOUND",
      "总览已过期或学校账号已变化，请重新读取",
    );
  const data = await require("./overviewStorage").hydrate(
    id,
    model.parse(rows[0].payload),
  );
  if (model.parse(conn.calendar)?.startDate !== data.calendar.startDate)
    throw new AppError(
      409,
      "OVERVIEW_TERM_CHANGED",
      "学期已变化，请重新读取当前学期",
    );
  return { ...data, id, connectionId: rows[0].connection_id };
}
async function prune(openid, kind, connectionId, currentId) {
  const [rows] = await pool.query(
    "SELECT id FROM overview_snapshots WHERE openid=? AND kind=? AND connection_id=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.state'))='ready' ORDER BY created_at DESC,id DESC LIMIT 2",
    [openid, kind, connectionId],
  );
  const keep = [...new Set([currentId, ...rows.map((r) => r.id)])];
  await pool.query(
    "DELETE FROM overview_snapshots WHERE openid=? AND kind=? AND connection_id=? AND id NOT IN (?) AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.state'))<>'scanning'",
    [openid, kind, connectionId, keep],
  );
}
async function save(id, data) {
  return require("./overviewStorage").save(id, data);
}
function result(data, options = {}) {
  const snapshotWeek = data.calendar.week;
  data = summary.atTime(data);
  if (data.state !== "ready")
    return {
      id: data.id,
      connectionId: data.connectionId,
      kind: data.kind,
      state: data.state,
      progress: data.progress,
      error: data.error,
      calendar: data.calendar,
    };
  const normalized = require("./overviewCache").compile(data, options);
  return {
    ...summary.page(normalized, options),
    id: data.id,
    connectionId: data.connectionId,
    kind: data.kind,
    state: data.state,
    calendar: data.calendar,
    profile: data.profile,
    readCompletedAt: data.readCompletedAt,
    dirtyWeeks: data.dirtyWeeks || [],
    reusedWeeks: data.reusedWeeks || [],
    refreshMode: data.refreshMode,
    stale:
      !!data.dirtyWeeks?.length ||
      Date.now() - Date.parse(data.readCompletedAt) > 30 * 60000 ||
      snapshotWeek !== data.calendar.week,
  };
}
async function get(id, openid, options) {
  return result(await raw(id, openid), options);
}
async function latest(openid, kind, options) {
  kindOf(kind);
  const conn = await connection(openid);
  if (!conn) return { snapshot: null };
  const [rows] = await pool.query(
    "SELECT id FROM overview_snapshots WHERE openid=? AND connection_id=? AND kind=? AND expires_at>UTC_TIMESTAMP() AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.state'))='ready' ORDER BY created_at DESC,id DESC LIMIT 1",
    [openid, conn.connection_id, kind],
  );
  return { snapshot: rows[0] ? await get(rows[0].id, openid, options) : null };
}
async function start(openid, kind, options = {}) {
  kindOf(kind);
  const session = await require("./schoolSession").getSession(openid),
    active = await model.active(openid);
  if (active)
    throw new AppError(
      409,
      "TASK_ACTIVE",
      "任务正在使用学校连接，可看已有总览，任务结束后再更新",
      { taskUuid: active.task_uuid },
    );
  if (
    session.busyPlan ||
    running.has(openid) ||
    require("../routes/auth").busy.has(openid)
  )
    throw new AppError(409, "SCAN_ACTIVE", "学校正在读取其他数据，请稍候");
  const id = crypto.randomUUID(),
    control = { id, cancelled: false };
  session.busyPlan = "overview-" + id;
  let handedOff = false;
  try {
    await require("./schoolSession").requireSchoolSession(session, {
      force: true,
    });
    const calendar = await require("./academicCalendar").syncSchoolCalendar(
      session.page,
    );
    await require("./schoolSession").persist(openid, session, {
      existingOnly: true,
    });
    const conn = await connection(openid);
    if (!conn?.connection_id)
      throw new AppError(401, "SCHOOL_AUTH_REQUIRED", "请重新连接学校");
    const [priorRows] = await pool.query(
      "SELECT id,payload FROM overview_snapshots WHERE openid=? AND kind=? AND connection_id=? AND expires_at>UTC_TIMESTAMP() ORDER BY created_at DESC,id DESC LIMIT 1",
      [openid, kind, conn.connection_id],
    );
    const prior = priorRows[0]
      ? await require("./overviewStorage").hydrate(
          priorRows[0].id,
          model.parse(priorRows[0].payload),
        )
      : {};
    const previous =
      prior.calendar?.startDate === calendar.startDate ? prior : {};
    const full = options.full !== false;
    const data = {
      id,
      refreshMode: full ? "full" : "incremental",
      reusedWeeks: [],
      dirtyWeeks: [],
      connectionId: conn.connection_id,
      kind,
      state: "scanning",
      calendar,
      profile: session.profile || "",
      progress: {
        processed: 0,
        total: kind === "academic" ? calendar.week : 0,
      },
      weeks: [],
    };
    await pool.query(
      "INSERT INTO overview_snapshots(id,openid,connection_id,kind,payload,expires_at) VALUES (?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 DAY))",
      [id, openid, conn.connection_id, kind, JSON.stringify(data)],
    );
    running.set(openid, control);
    handedOff = true;
    void require("../utils/executionMetrics")
      .run(id, "overview-" + kind, async () => {
        if (kind === "academic") {
          for (let week = 1; week <= calendar.week; week++) {
            if (control.cancelled)
              throw new AppError(409, "SCAN_CANCELLED", "已停止总览读取");
            try {
              const old = previous.weeks?.find((w) => w.week === week);
              if (
                require("./overviewFreshness").canReuse(
                  old,
                  week,
                  calendar,
                  previous.dirtyWeeks,
                  full,
                )
              ) {
                data.weeks.push(old);
                data.reusedWeeks.push(week);
                data.progress.processed = week;
                await save(id, data);
                continue;
              }
              const info = await school.roster(session.page, calendar, week);
              await require("../utils/readLimit").mapRead(
                info.students,
                async (s) => {
                  const records = [
                    ...(
                      await school.records(
                        session.page,
                        info,
                        s.studentId,
                        "talk",
                      )
                    ).map((r) => ({
                      id: String(r.id),
                      type: "talk",
                      recordedAt: r.thsj,
                      duration: Number(r.thsc),
                      method: r.thfs,
                    })),
                    ...(
                      await school.records(
                        session.page,
                        info,
                        s.studentId,
                        "companion",
                      )
                    ).map((r) => ({
                      id: String(r.id),
                      type: "companion",
                      recordedAt: r.cysj,
                    })),
                  ];
                  s.records = records;
                  s.recordCount = records.length;
                  s.anomalies = [];
                  for (const r of records) {
                    const time = schedule.stamp(r.recordedAt);
                    if (
                      !Number.isFinite(time) ||
                      (r.type === "talk" &&
                        (!Number.isFinite(r.duration) || r.duration <= 0))
                    )
                      s.anomalies.push("记录时间或时长无法核验");
                    else if (
                      time +
                        (r.type === "talk" ? r.duration * schedule.MIN : 0) >
                      Date.now()
                    )
                      s.anomalies.push("学校有未来时间记录");
                  }
                },
                { cancelled: () => control.cancelled },
              );
              if (control.cancelled)
                throw new AppError(409, "SCAN_CANCELLED", "已停止总览读取");
              info.readCompletedAt = new Date().toISOString();
              data.weeks.push(info);
            } catch (e) {
              if (
                [
                  "SCHOOL_AUTH_REQUIRED",
                  "SCAN_CANCELLED",
                  "SCHOOL_UNAVAILABLE",
                ].includes(e.code)
              )
                throw e;
              data.weeks.push({
                week,
                error: "该周学校数据未核实：" + e.message,
                students: [],
              });
            }
            data.progress.processed = week;
            await save(id, data);
          }
        } else {
          const source = await worklog.readSnapshot(session.page, calendar, {
            cancelled: () => control.cancelled,
            previous: full
              ? null
              : {
                  days: previous.days,
                  records: previous.records,
                  weekCheckedAt: previous.weekCheckedAt,
                },
            dirtyWeeks: previous.dirtyWeeks || [],
            onCheckpoint: async (source) => {
              data.days = source.days;
              data.records = source.records;
              data.weekCheckedAt = source.weekCheckedAt;
              await save(id, data);
            },
            onProgress: async (progress) => {
              data.progress = progress;
              await save(id, data);
            },
          });
          data.students = source.students;
          data.days = source.days;
          data.weekCheckedAt = source.weekCheckedAt;
          data.reusedWeeks = source.reusedWeeks;
          data.records = source.records.map(({ id, xh, thsj, thsc, thfs }) => ({
            id,
            xh,
            thsj,
            thsc,
            thfs,
          }));
          data.progress = {
            processed: source.totalWeeks,
            total: source.totalWeeks,
          };
        }
        if (control.cancelled)
          throw new AppError(409, "SCAN_CANCELLED", "已停止总览读取");
        data.state = "ready";
        data.readCompletedAt = new Date().toISOString();
        await save(id, data);
        await prune(openid, kind, data.connectionId, id);
        await pool.query(
          "DELETE FROM overview_snapshots WHERE openid=? AND expires_at<UTC_TIMESTAMP()",
          [openid],
        );
      })
      .catch(async (e) => {
        data.state = e.code === "SCAN_CANCELLED" ? "cancelled" : "failed";
        data.error = e.message;
        await save(id, data).catch(() => {});
        await prune(openid, kind, data.connectionId, id).catch(() => {});
      })
      .finally(() => {
        running.delete(openid);
        if (session.busyPlan === "overview-" + id) session.busyPlan = null;
        session._lastUsed = Date.now();
      });
    return { id, state: "scanning" };
  } finally {
    if (!handedOff && session.busyPlan === "overview-" + id)
      session.busyPlan = null;
  }
}
async function cancel(id, openid) {
  await raw(id, openid);
  const control = running.get(openid);
  if (control?.id === id) control.cancelled = true;
  return { state: control?.id === id ? "cancelling" : "stopped" };
}
async function detail(id, openid, studentId, options = {}) {
  const data = summary.atTime(await raw(id, openid));
  if (data.state !== "ready")
    throw new AppError(409, "OVERVIEW_NOT_READY", "请等待读取完成");
  const compiled =
      data.kind === "academic"
        ? summary.academic(data)
        : summary.worklog(data, Number(options.targetCount || 1)),
    student = compiled.students.find((s) => s.studentId === studentId);
  if (!student) throw new AppError(404, "STUDENT_NOT_FOUND", "不在该总览名单");
  if (data.kind === "academic")
    student.weeks = student.weeks.map((w) => ({
      ...w,
      records:
        data.weeks
          .find((x) => x.week === w.week)
          ?.students.find((s) => s.studentId === studentId)?.records || [],
    }));
  if (data.kind === "worklog")
    student.records = data.records
      .filter((r) => r.xh === studentId)
      .map((r) => ({
        id: r.id,
        recordedAt: r.thsj,
        duration: r.thsc,
        method: r.thfs,
        ...require("./recordValidity").inspect(r),
      }));
  return student;
}
async function selection(id, openid, options = {}) {
  const data = summary.atTime(await raw(id, openid));
  if (data.state !== "ready")
    throw new AppError(409, "OVERVIEW_NOT_READY", "请等待读取完成");
  const target = Number(options.targetCount || 1),
    compiled =
      data.kind === "academic"
        ? summary.academic(data)
        : summary.worklog(data, target);
  if (!compiled.summary.complete)
    throw new AppError(
      409,
      "OVERVIEW_INCOMPLETE",
      "有周次尚未核实，请更新学校记录后再从总览选择补录范围",
    );
  const selected = compiled.students.filter(
    (s) =>
      (data.kind === "academic" || !s.unknown) &&
      (data.kind === "academic"
        ? s.weeks.some(
            (w) =>
              (options.currentWeek ? w.current : !w.current) &&
              !w.complete &&
              !w.anomalies?.length,
          )
        : s.remaining > 0),
  );
  const weeks =
    data.kind === "academic"
      ? [
          ...new Set(
            selected.flatMap((s) =>
              s.weeks
                .filter(
                  (w) =>
                    (options.currentWeek ? w.current : !w.current) &&
                    !w.complete &&
                    !w.anomalies?.length &&
                    w.editable,
                )
                .map((w) => w.week),
            ),
          ),
        ]
      : [];
  const writable =
    data.kind === "academic"
      ? selected.filter((s) =>
          s.weeks.some(
            (w) =>
              weeks.includes(w.week) &&
              !w.complete &&
              !w.anomalies?.length &&
              w.editable,
          ),
        )
      : selected;
  if (!writable.length)
    throw new AppError(
      409,
      "NO_MISSING_ITEMS",
      "没有可补录的已核实项目；不可编辑或待核实项请先到学校核对",
    );
  return {
    kind: data.kind,
    overviewId: id,
    studentIds: writable.map((s) => s.studentId),
    weeks,
    targetCount: target,
    weekMembership:
      data.kind === "academic"
        ? Object.fromEntries(
            weeks.map((w) => [
              w,
              writable
                .filter((s) =>
                  s.weeks.some(
                    (x) =>
                      x.week === w &&
                      !x.complete &&
                      !x.anomalies?.length &&
                      x.editable,
                  ),
                )
                .map((s) => s.studentId),
            ]),
          )
        : undefined,
  };
}
async function recover() {
  await pool.query(
    "UPDATE overview_snapshots SET payload=JSON_SET(payload,'$.state','interrupted','$.error','服务已重启，请更新学校记录') WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.state'))='scanning'",
  );
}
module.exports = {
  get,
  latest,
  start,
  cancel,
  detail,
  selection,
  recover,
  running,
  result,
  prune,
};
