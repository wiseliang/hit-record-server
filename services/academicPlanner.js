const crypto = require("crypto"),
  pool = require("../config/database"),
  model = require("../models/tasksV12"),
  school = require("./academicSchool"),
  schedule = require("./worklogSchedule"),
  { AppError } = require("../utils/errors"),
  { pendingLogins } = require("./login");
const running = new Map();
function weeksOf(weeks, calendar) {
  if (
    !Array.isArray(weeks) ||
    !weeks.length ||
    weeks.length > 30 ||
    weeks.some((w) => !Number.isInteger(w) || w < 1 || w > calendar.week) ||
    new Set(weeks).size !== weeks.length
  )
    throw new AppError(400, "INVALID_WEEK", "请选择当前学期内不重复的周次");
  return [...weeks].sort((a, b) => a - b);
}
function typeFor(entry, week) {
  if (!["talk", "companion", "automatic"].includes(entry))
    throw new AppError(400, "INVALID_RECORD_TYPE", "录入类型由入口确定");
  return entry === "automatic"
    ? week % 2 === 1
      ? "companion"
      : "talk"
    : entry;
}
async function persistSnapshot(id, data) {
  await pool.query("UPDATE academic_snapshots SET payload=? WHERE id=?", [
    JSON.stringify(data),
    id,
  ]);
}
async function snapshot(id, openid) {
  const [rows] = await pool.query(
    "SELECT *,expires_at>UTC_TIMESTAMP() AS fresh,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),expires_at) AS ttl FROM academic_snapshots WHERE id=? AND openid=?",
    [id, openid],
  );
  if (!rows.length)
    throw new AppError(404, "ACADEMIC_SNAPSHOT_NOT_FOUND", "没有这份学情名单");
  return {
    ...model.parse(rows[0].payload),
    id,
    expired: !rows[0].fresh,
    expiresAt: new Date(Date.now() + rows[0].ttl * 1000).toISOString(),
  };
}
async function startRoster(openid, body) {
  const session = await require("./schoolSession").getSession(openid);
  if (
    session.busyPlan ||
    running.has(openid) ||
    require("../routes/auth").busy.has(openid)
  )
    throw new AppError(409, "SCAN_ACTIVE", "学校正在处理其他操作，请稍候");
  const id = crypto.randomUUID(),
    control = { id, cancelled: false };
  session.busyPlan = "academic-" + id;
  running.set(openid, control);
  try {
    if (await model.active(openid))
      throw new AppError(409, "TASK_ACTIVE", "请先结束当前任务");
    const calendar = session.calendar?.verified
        ? session.calendar
        : await require("./academicCalendar").syncSchoolCalendar(session.page),
      weeks = weeksOf(body.weeks, calendar),
      entry = body.entry || "automatic";
    typeFor(entry, weeks[0]);
    const data = {
      scope: "academic",
      state: "scanning",
      calendar,
      weeks,
      entry,
      weekRosters: [],
      students: [],
      progress: { processed: 0, total: weeks.length },
    };
    await pool.query(
      "INSERT INTO academic_snapshots(id,openid,payload,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 MINUTE))",
      [id, openid, JSON.stringify(data)],
    );
    void require("../utils/executionMetrics")
      .run(id, "academic-read", async () => {
        for (const w of weeks) {
          if (control.cancelled)
            throw new AppError(409, "SCAN_CANCELLED", "已停止读取");
          data.weekRosters.push(await school.roster(session.page, calendar, w));
          data.progress.processed++;
          await persistSnapshot(id, data);
        }
        const people = new Map();
        for (const info of data.weekRosters)
          for (const s of info.students) {
            if (!people.has(s.studentId))
              people.set(s.studentId, { ...s, weeks: [] });
            people.get(s.studentId).weeks.push(info.week);
          }
        data.students = [...people.values()];
        data.state = "ready";
        data.checkedAt = new Date().toISOString();
        await persistSnapshot(id, data);
      })
      .catch(async (e) => {
        data.state = e.code === "SCAN_CANCELLED" ? "cancelled" : "failed";
        data.error = e.message;
        await persistSnapshot(id, data).catch(() => {});
      })
      .finally(() => {
        running.delete(openid);
        if (session.busyPlan === "academic-" + id) session.busyPlan = null;
        session._lastUsed = Date.now();
      });
    return { snapshotId: id, state: "scanning" };
  } catch (e) {
    session.busyPlan = null;
    running.delete(openid);
    throw e;
  }
}
function validateOptions(body, calendar) {
  const content = body.content ?? "";
  if (typeof content !== "string" || content.length > 250)
    throw new AppError(400, "INVALID_CONTENT", "内容可留空，最多 250 字");
  const duration = body.durationMinutes ?? 10,
    method = body.method || "面对面",
    scene = body.scene || "其他",
    pbType = body.pbType || "共同上课";
  const normalized = schedule.normalize(
    {
      studentIds: body.studentIds,
      content,
      fromDate: calendar.startDate,
      toDate: schedule.dateOf(Date.now()),
      durationMinutes: duration,
      method,
      shifts: body.shifts,
      excludeDates: body.excludeDates,
    },
    calendar,
  );
  return {
    ...normalized,
    content: content.trim(),
    scene,
    pbType,
    scope: "academic",
  };
}
async function preview(openid, body) {
  const data = await snapshot(body.snapshotId, openid);
  if (data.expired || data.state !== "ready")
    throw new AppError(
      409,
      "ACADEMIC_SNAPSHOT_EXPIRED",
      "学情名单已过期或未完成，请重新读取",
    );
  const session = await require("./schoolSession").getSession(openid);
  if (session.busyPlan || running.has(openid))
    throw new AppError(409, "SCAN_ACTIVE", "学校正在处理其他操作");
  if (session.calendar.startDate !== data.calendar.startDate)
    throw new AppError(409, "CALENDAR_CHANGED", "学期已变化，请重新读取");
  const options = validateOptions(body, data.calendar),
    allowed = new Set(data.students.map((s) => s.studentId));
  if (options.studentIds.some((id) => !allowed.has(id)))
    throw new AppError(
      400,
      "ACADEMIC_STUDENT_NOT_OWNED",
      "所选学生不在这些周次的学情名册中，不会从工作日志补入人员",
    );
  const relevant = data.weekRosters.reduce(
    (n, r) =>
      n +
      r.students.filter((s) => options.studentIds.includes(s.studentId)).length,
    0,
  );
  if (!relevant || relevant > 1500)
    throw new AppError(
      400,
      "INVALID_STUDENTS",
      "请选择有效人员，一次最多 1500 个实际学生周次组合",
    );
  const id = crypto.randomUUID(),
    control = { id, cancelled: false },
    request = {
      ...options,
      entry: data.entry,
      recordType: data.entry === "automatic" ? "academic-auto" : data.entry,
      weeks: data.weeks,
      snapshotId: body.snapshotId,
      mode: "missing",
    },
    plan = {
      id,
      scope: "academic",
      kind: "academic",
      state: "scanning",
      calendar: data.calendar,
      request,
      operations: [],
      progress: { processed: 0, total: relevant },
      processed: 0,
      total: relevant,
      revision: 1,
      requiresActualConfirmation: true,
    };
  session.busyPlan = "academic-" + id;
  running.set(openid, control);
  try {
    await pool.query(
      "INSERT INTO task_plans(id,openid,body_hash,payload,expires_at) VALUES (?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 45 MINUTE))",
      [id, openid, model.hash(request), JSON.stringify(plan)],
    );
  } catch (e) {
    session.busyPlan = null;
    running.delete(openid);
    throw e;
  }
  const save = () =>
    pool.query("UPDATE task_plans SET payload=? WHERE id=?", [
      JSON.stringify(plan),
      id,
    ]);
  void require("../utils/executionMetrics")
    .run(id, "academic-read", async () => {
      for (const info of data.weekRosters) {
        if (control.cancelled) break;
        const fresh = await school.roster(
            session.page,
            data.calendar,
            info.week,
          ),
          type = typeFor(data.entry, info.week),
          existing = [],
          pending = [];
        const recordLists = await require("../utils/readLimit").mapRead(
          fresh.students,
          (person) =>
            school.records(session.page, fresh, person.studentId, type),
          { cancelled: () => control.cancelled },
        );
        for (const [personIndex, person] of fresh.students.entries()) {
          if (control.cancelled) break;
          const records = recordLists[personIndex];
          for (const r of records) {
            const date = type === "talk" ? r.thsj : r.cysj;
            if (date) {
              const t = schedule.stamp(date);
              if (!Number.isFinite(t))
                throw new AppError(
                  502,
                  "ACADEMIC_RECORDS_INVALID",
                  "已有记录时间无法核验，已停止安排",
                );
              existing.push({
                id: String(r.id),
                xh: person.studentId,
                thsj: schedule.format(t),
                thsc: Number(r.thsc) || 10,
              });
            }
          }
          if (!options.studentIds.includes(person.studentId)) continue;
          const op = {
            studentId: person.studentId,
            studentName: person.name,
            week: info.week,
            type,
            status: "planned",
            payload: {
              ...options,
              scope: "academic",
              mode: "missing",
              gzrzid: fresh.gzrzid,
              content: options.content,
            },
          };
          delete op.payload.studentIds;
          if (records.length)
            plan.operations.push({
              ...op,
              status: "skipped",
              reason:
                "该周已有" +
                (type === "talk" ? "谈话" : "陪伴") +
                "记录，自动跳过",
              payload: {
                ...op.payload,
                recordedAt:
                  (type === "talk" ? records[0].thsj : records[0].cysj) || null,
              },
            });
          else if (!fresh.editable)
            plan.operations.push({
              ...op,
              status: "not_applicable",
              reason: "该周学校日志不可编辑，未安排",
            });
          else pending.push(op);
          plan.processed++;
          plan.progress.processed = plan.processed;
          if (plan.processed % 5 === 0) await save();
        }
        const missingSelected = info.students.filter(
          (s) =>
            options.studentIds.includes(s.studentId) &&
            !fresh.students.some((r) => r.studentId === s.studentId),
        );
        for (const person of missingSelected) {
          plan.operations.push({
            studentId: person.studentId,
            studentName: person.name,
            week: info.week,
            type,
            status: "not_applicable",
            reason: "学校学情名册已变化，未替换其他学生",
            payload: { scope: "academic" },
          });
          plan.processed++;
          plan.progress.processed = plan.processed;
        }
        plan.existingTimes ??= [];
        plan.existingTimes.push(...existing.map((r) => schedule.stamp(r.thsj)));
        if (pending.length) {
          const first =
              Date.parse(data.calendar.startDate + "T00:00:00+08:00") +
              (info.week - 1) * 7 * schedule.DAY,
            from = schedule.dateOf(first),
            to = schedule.dateOf(
              Math.min(first + 6 * schedule.DAY, Date.now()),
            );
          const days = Array.from({ length: 7 }, (_, i) => ({
              date: schedule.dateOf(first + i * schedule.DAY),
              week: info.week,
              gzrzid: fresh.gzrzid,
              editable: fresh.editable,
            })),
            fake = {
              calendar: data.calendar,
              days,
              records: existing,
              students: pending.map((op) => ({
                studentId: op.studentId,
                name: op.studentName,
                semesterCount: 0,
                hasContact: true,
                schoolCount: 0,
              })),
            },
            generated = schedule.build(fake, {
              ...options,
              studentIds: pending.map((o) => o.studentId),
              fromDate: from,
              toDate: to,
              targetCount: 1,
              skipRecorded: false,
            });
          for (const op of generated.operations) {
            const source = pending.find((p) => p.studentId === op.studentId);
            plan.operations.push({
              ...source,
              status: op.status,
              reason: op.reason,
              payload: {
                ...source.payload,
                ...op.payload,
                scope: "academic",
                mode: "missing",
                gzrzid: fresh.gzrzid,
              },
            });
          }
        }
        await save();
      }
      plan.state = control.cancelled ? "cancelled" : "ready";
      plan.total = plan.operations.length;
      plan.summary = Object.fromEntries(
        ["planned", "skipped", "not_applicable", "unconfirmed"].map((s) => [
          s,
          plan.operations.filter((o) => o.status === s).length,
        ]),
      );
      await save();
    })
    .catch(async (e) => {
      plan.state = "failed";
      plan.error = e.message;
      await save().catch(() => {});
    })
    .finally(() => {
      running.delete(openid);
      if (session.busyPlan === "academic-" + id) session.busyPlan = null;
      session._lastUsed = Date.now();
    });
  return { planId: id, state: "scanning" };
}
async function cancel(id, openid) {
  const control = running.get(openid);
  if (control?.id === id) {
    control.cancelled = true;
    return { state: "cancelling" };
  }
  return { state: "stopped" };
}
async function review(openid, id, body) {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [rows] = await c.query(
      "SELECT *,expires_at>UTC_TIMESTAMP() AS fresh FROM task_plans WHERE id=? AND openid=? FOR UPDATE",
      [id, openid],
    );
    if (!rows.length || !rows[0].fresh)
      throw new AppError(409, "PLAN_EXPIRED", "预览已过期");
    if (rows[0].used_by)
      throw new AppError(409, "PLAN_ALREADY_USED", "预览已经提交");
    const p = model.parse(rows[0].payload);
    if (
      p.state !== "ready" ||
      p.request?.scope !== "academic" ||
      p.revision !== body.revision ||
      !Array.isArray(body.changes) ||
      body.changes.length > 1500
    )
      throw new AppError(409, "PLAN_CHANGED", "预览版本已变化");
    const indices = new Set();
    for (const change of body.changes) {
      if (
        !Number.isInteger(change.operationIndex) ||
        indices.has(change.operationIndex)
      )
        throw new AppError(400, "INVALID_CHANGE", "修改项编号无效或重复");
      indices.add(change.operationIndex);
      const op = p.operations[change.operationIndex];
      if (!op || op.status !== "planned")
        throw new AppError(400, "INVALID_CHANGE", "不能修改已跳过的记录");
      const start =
          Date.parse(p.calendar.startDate + "T00:00:00+08:00") +
          (op.week - 1) * 7 * schedule.DAY,
        time = schedule.stamp(change.recordedAt);
      if (!Number.isFinite(time))
        throw new AppError(400, "INVALID_DATE", "请选择有效日期和时间");
      const date = schedule.dateOf(time);
      if (time < start || time >= start + 7 * schedule.DAY)
        throw new AppError(
          400,
          "INVALID_WEEK_DATE",
          "时间必须在该条记录所属周内",
        );
      schedule.inWindow(change.recordedAt, op.payload, {
        date,
        editable: true,
      });
      op.payload.recordedAt = schedule.format(time);
      op.payload.date = date;
      if (change.content !== undefined) {
        if (typeof change.content !== "string" || change.content.length > 250)
          throw new AppError(400, "INVALID_CONTENT", "内容可留空，最多250字");
        op.payload.content = change.content.trim();
      }
    }
    const seen = [...(p.existingTimes || [])];
    for (const op of p.operations.filter((o) => o.status === "planned")) {
      const t = schedule.stamp(op.payload.recordedAt);
      if (!schedule.densityOK(t, seen))
        throw new AppError(
          409,
          "DENSITY_LIMIT",
          "时间调整后10分钟内超过2条，请调整",
        );
      seen.push(t);
    }
    p.revision++;
    await c.query("UPDATE task_plans SET payload=? WHERE id=?", [
      JSON.stringify(p),
      id,
    ]);
    await c.commit();
    return p;
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
module.exports = {
  startRoster,
  snapshot,
  preview,
  review,
  cancel,
  typeFor,
  weeksOf,
  running,
  validateOptions,
};
