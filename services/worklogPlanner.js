const crypto = require("crypto"),
  pool = require("../config/database"),
  model = require("../models/tasksV12"),
  school = require("./worklogSchool"),
  schedule = require("./worklogSchedule");
const { AppError } = require("../utils/errors"),
  { pendingLogins } = require("./login"),
  { requireSchoolSession } = require("./schoolSession");
const scans = new Map();
async function rawSnapshot(
  id,
  openid,
  { allowExpired = false, connection = pool } = {},
) {
  const [rows] = await connection.query(
    "SELECT *, (expires_at>UTC_TIMESTAMP()) AS fresh,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),expires_at) AS ttl FROM worklog_snapshots WHERE id=? AND openid=?",
    [id, openid],
  );
  if (!rows.length)
    throw new AppError(404, "SNAPSHOT_NOT_FOUND", "没有这份工作日志名单");
  if (!allowExpired && !rows[0].fresh)
    throw new AppError(409, "SNAPSHOT_EXPIRED", "名单次数已过期，请重新读取");
  return {
    ...model.parse(rows[0].payload),
    id,
    expiresAt: new Date(Date.now() + rows[0].ttl * 1000).toISOString(),
  };
}
function publicSnapshot(s) {
  const dense = schoolDensity(s.records || []);
  return {
    id: s.id,
    state: s.state,
    error: s.error,
    progress: s.progress,
    calendar: s.calendar,
    students: s.students || [],
    checkedAt: s.checkedAt,
    expiresAt: s.expiresAt,
    totalWeeks: s.totalWeeks,
    futureRecords: s.futureRecords || 0,
    existingDenseWindows: dense,
    editableWeeks: [
      ...new Set((s.days || []).filter((d) => d.editable).map((d) => d.week)),
    ],
    source: s.source,
  };
}
function schoolDensity(records) {
  const times = records
    .map((r) => schedule.stamp(r.thsj))
    .sort((a, b) => a - b);
  let count = 0;
  for (let i = 2; i < times.length; i++)
    if (times[i] - times[i - 2] <= 10 * schedule.MIN) count++;
  return count;
}
async function getSnapshot(id, openid) {
  return publicSnapshot(await rawSnapshot(id, openid, { allowExpired: true }));
}
async function persist(id, value) {
  await pool.query("UPDATE worklog_snapshots SET payload=? WHERE id=?", [
    JSON.stringify(value),
    id,
  ]);
}
async function startScan(openid) {
  const session = await require("./schoolSession").getSession(openid);
  if (!session)
    throw new AppError(401, "SCHOOL_AUTH_REQUIRED", "请先验证学校登录");
  if (
    session.busyPlan ||
    scans.has(openid) ||
    require("../routes/auth").busy.has(openid)
  )
    throw new AppError(
      409,
      "SCAN_ACTIVE",
      "当前有学校操作正在进行，请等待或取消后再读取",
    );
  const id = crypto.randomUUID(),
    control = { id, cancelled: false };
  session.busyPlan = "worklog-" + id;
  scans.set(openid, control);
  try {
    await requireSchoolSession(session, { force: true });
    if (await model.active(openid))
      throw new AppError(409, "TASK_ACTIVE", "请先结束当前录入任务");
    session.calendar = await require("./academicCalendar").syncSchoolCalendar(
      session.page,
    );
    const calendar = session.calendar;
    if (!calendar?.verified)
      throw new AppError(409, "CALENDAR_REQUIRED", "请先核验学校学期");
    const state = {
      state: "scanning",
      calendar,
      progress: { processed: 0, total: 0 },
    };
    await pool.query(
      "INSERT INTO worklog_snapshots(id,openid,payload,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 MINUTE))",
      [id, openid, JSON.stringify(state)],
    );
    void school
      .readSnapshot(session.page, calendar, {
        cancelled: () => control.cancelled,
        onProgress: async (progress) => {
          state.progress = progress;
          await persist(id, state);
        },
      })
      .then(async (snapshot) => {
        if (control.cancelled)
          throw new AppError(409, "SCAN_CANCELLED", "读取已取消");
        await persist(id, {
          ...snapshot,
          state: "ready",
          progress: {
            processed: snapshot.totalWeeks,
            total: snapshot.totalWeeks,
          },
        });
      })
      .catch(async (e) => {
        try {
          await persist(id, {
            ...state,
            state: e.code === "SCAN_CANCELLED" ? "cancelled" : "failed",
            error: e.message,
          });
        } catch (writeError) {
          require("../utils/logger").error(writeError.message);
        }
      })
      .finally(() => {
        scans.delete(openid);
        if (session.busyPlan === "worklog-" + id) session.busyPlan = null;
        session._lastUsed = Date.now();
      });
    return { snapshotId: id, state: "scanning" };
  } catch (e) {
    session.busyPlan = null;
    scans.delete(openid);
    throw e;
  }
}
async function cancelScan(id, openid) {
  const snapshot = await rawSnapshot(id, openid, { allowExpired: true }),
    control = scans.get(openid);
  if (control?.id === id) {
    control.cancelled = true;
    return { state: "cancelling" };
  }
  return { state: snapshot.state };
}
async function preview(openid, body) {
  const snapshot = await rawSnapshot(body.snapshotId, openid);
  if (snapshot.state !== "ready")
    throw new AppError(
      409,
      "SNAPSHOT_NOT_READY",
      "请先完成本学期名单和次数读取",
    );
  const session = await require("./schoolSession").getSession(openid);
  if (session.busyPlan || (await model.active(openid)))
    throw new AppError(409, "SCAN_ACTIVE", "学校正在处理其他操作，请稍候");
  await requireSchoolSession(session, { force: true });
  if (session?.calendar?.startDate !== snapshot.calendar.startDate)
    throw new AppError(409, "CALENDAR_CHANGED", "学期已变化，请重新读取");
  const request = schedule.normalize(body, snapshot.calendar),
    result = schedule.build(snapshot, request),
    id = crypto.randomUUID();
  if (!result.operations.length)
    throw new AppError(400, "EMPTY_PLAN", "没有可预览的学生");
  request.weeks = [...new Set(result.operations.map((o) => o.week))].sort(
    (a, b) => a - b,
  );
  const plan = {
    id,
    kind: "worklog-talk",
    state: "ready",
    request: { ...request, snapshotId: body.snapshotId },
    calendar: snapshot.calendar,
    ...result,
    processed: result.operations.length,
    total: result.operations.length,
    revision: 1,
    requiresActualConfirmation: true,
    checkedAt: snapshot.checkedAt,
    existingDenseWindows: schoolDensity(snapshot.records),
  };
  await pool.query(
    "INSERT INTO task_plans(id,openid,body_hash,payload,expires_at) VALUES (?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 MINUTE))",
    [id, openid, model.hash(plan.request), JSON.stringify(plan)],
  );
  return plan;
}
async function review(openid, id, body) {
  if (!Array.isArray(body.changes) || body.changes.length > 1500)
    throw new AppError(400, "INVALID_CHANGES", "时间修改列表无效");
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [rows] = await c.query(
      "SELECT * FROM task_plans WHERE id=? AND openid=? AND expires_at>UTC_TIMESTAMP() FOR UPDATE",
      [id, openid],
    );
    if (!rows.length)
      throw new AppError(409, "PLAN_EXPIRED", "预览已过期，请重新生成");
    if (rows[0].used_by)
      throw new AppError(409, "PLAN_ALREADY_USED", "该预览已提交，不能再修改");
    const plan = model.parse(rows[0].payload);
    if (
      plan.request?.recordType !== "worklog-talk" ||
      plan.revision !== body.revision
    )
      throw new AppError(409, "PLAN_CHANGED", "预览版本已变化，请刷新");
    const snapshot = await rawSnapshot(plan.request.snapshotId, openid, {
        connection: c,
      }),
      byDate = new Map(snapshot.days.map((d) => [d.date, d]));
    const used = new Set();
    for (const change of body.changes) {
      const key = change.operationIndex;
      if (
        !Number.isInteger(key) ||
        used.has(key) ||
        !plan.operations[key] ||
        plan.operations[key].status !== "planned"
      )
        throw new AppError(
          400,
          "INVALID_CHANGES",
          "不能修改跳过项或不存在的记录",
        );
      used.add(key);
      const op = plan.operations[key],
        date = String(change.recordedAt || "").slice(0, 10),
        day = byDate.get(date),
        time = schedule.inWindow(change.recordedAt, plan.request, day);
      op.week = day.week;
      op.payload.recordedAt = schedule.format(time);
      op.payload.date = date;
      op.payload.gzrzid = day.gzrzid;
      if (change.content !== undefined) {
        if (typeof change.content !== "string" || change.content.length > 250)
          throw new AppError(400, "INVALID_CONTENT", "内容可留空，最多 250 字");
        op.payload.content = change.content.trim();
      }
    }
    const tupleKeys = new Set();
    for (const op of plan.operations.filter((o) => o.status === "planned")) {
      const key = op.studentId + "|" + op.payload.recordedAt.slice(0, 16);
      if (tupleKeys.has(key))
        throw new AppError(
          409,
          "DUPLICATE_ACTIVITY",
          "同一学生不能在同一分钟重复安排谈话",
        );
      tupleKeys.add(key);
    }
    const times = snapshot.records.map((r) => schedule.stamp(r.thsj));
    for (const op of plan.operations.filter((o) => o.status === "planned")) {
      const time = schedule.inWindow(
        op.payload.recordedAt,
        plan.request,
        byDate.get(op.payload.date),
      );
      if (!schedule.densityOK(time, times))
        throw new AppError(
          409,
          "DENSITY_LIMIT",
          "修改后的滚动 10 分钟内超过 2 条谈话，请调整时间",
        );
      times.push(time);
    }
    plan.request.weeks = [...new Set(plan.operations.map((o) => o.week))].sort(
      (a, b) => a - b,
    );
    plan.revision++;
    plan.distribution = [...new Set(snapshot.days.map((d) => d.week))]
      .sort((a, b) => a - b)
      .map((week) => ({
        week,
        existing: snapshot.records.filter((r) => r.week === week).length,
        planned: plan.operations.filter(
          (o) => o.status === "planned" && o.week === week,
        ).length,
      }));
    await c.query("UPDATE task_plans SET payload=?,body_hash=? WHERE id=?", [
      JSON.stringify(plan),
      model.hash(plan.request),
      id,
    ]);
    await c.commit();
    return plan;
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
module.exports = {
  startScan,
  getSnapshot,
  rawSnapshot,
  cancelScan,
  preview,
  review,
  scans,
  schoolDensity,
};
