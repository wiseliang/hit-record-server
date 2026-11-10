const crypto = require("crypto"),
  pool = require("../config/database");
const { AppError } = require("../utils/errors"),
  { parse, hash } = require("../models/tasksV12");
const { pendingLogins } = require("./login"),
  { requireSchoolSession } = require("./schoolSession");
const { withSemester } = require("../utils/week"),
  { validateRecordDateTime } = require("./companion");
const nav = require("./navigator"),
  driver = require("./recordDriver");
const running = new Map();
function validate(body, calendar) {
  const {
    recordType,
    mode = "record",
    weeks,
    studentIds,
    schedule,
    content,
  } = body;
  if (
    !["talk", "companion"].includes(recordType) ||
    !["record", "missing"].includes(mode)
  )
    throw new AppError(
      400,
      "INVALID_RECORD_TYPE",
      "请选择明确的录入类型和检查方式",
    );
  if (
    !Array.isArray(weeks) ||
    !weeks.length ||
    weeks.length > 30 ||
    weeks.some((w) => !Number.isInteger(w) || w < 1 || w > calendar.week) ||
    new Set(weeks).size !== weeks.length
  )
    throw new AppError(400, "INVALID_WEEK", "请选择有效、不重复的周次");
  if (
    !Array.isArray(studentIds) ||
    !studentIds.length ||
    studentIds.some((id) => typeof id !== "string" || !/^\d{8,16}$/.test(id)) ||
    new Set(studentIds).size !== studentIds.length ||
    weeks.length * studentIds.length > 1500
  )
    throw new AppError(
      400,
      "INVALID_STUDENTS",
      "请选择有效学生；一次最多检查 1500 个学生周次组合",
    );
  if (typeof content !== "string" || !content.trim() || content.length > 250)
    throw new AppError(
      400,
      "INVALID_CONTENT",
      "请填写实际工作内容，不超过 250 字",
    );
  if (body.calendarStartDate !== calendar.startDate)
    throw new AppError(409, "CALENDAR_CHANGED", "学期已变化，请重新同步");
  if (
    recordType === "talk" &&
    (!Number.isInteger(body.durationMinutes) ||
      body.durationMinutes < 1 ||
      body.durationMinutes > 1440 ||
      !["面对面", "电话", "网络"].includes(body.method) ||
      typeof body.scene !== "string")
  )
    throw new AppError(400, "INVALID_FORM", "请填写实际谈话时长、方式和场景");
  if (recordType === "companion" && typeof body.pbType !== "string")
    throw new AppError(400, "INVALID_FORM", "请选择陪伴类型");
  const dates = {};
  for (const week of weeks)
    dates[week] = validateRecordDateTime(week, schedule?.[week]);
  return {
    recordType,
    mode,
    weeks: [...weeks].sort((a, b) => a - b),
    studentIds: [...studentIds],
    schedule: dates,
    content: content.trim(),
    calendarStartDate: calendar.startDate,
    ...(recordType === "talk"
      ? {
          durationMinutes: body.durationMinutes,
          method: body.method,
          scene: body.scene,
        }
      : { pbType: body.pbType }),
  };
}
async function getPlan(id, openid) {
  const [rows] = await pool.query(
    "SELECT * FROM task_plans WHERE id=? AND openid=?",
    [id, openid],
  );
  if (!rows.length) throw new AppError(404, "PLAN_NOT_FOUND", "没有这份预览");
  return {
    ...parse(rows[0].payload),
    id,
    usedBy: rows[0].used_by,
    expiresAt: rows[0].expires_at,
  };
}
async function persist(id, plan) {
  await pool.query("UPDATE task_plans SET payload=? WHERE id=?", [
    JSON.stringify(plan),
    id,
  ]);
}
async function startUnlocked(openid, body) {
  const session = pendingLogins.get(openid);
  if (!session)
    throw new AppError(401, "SCHOOL_AUTH_REQUIRED", "请先验证学校登录");
  if (session.busyPlan || running.has(openid))
    throw new AppError(409, "SCAN_ACTIVE", "当前已有检查，请稍候");
  session.busyPlan = "starting";
  try {
    await requireSchoolSession(session);
    if (await require("../models/tasksV12").active(openid))
      throw new AppError(
        409,
        "TASK_ACTIVE",
        "当前已有检查或录入任务，请先完成它",
      );
    if (!session.calendar?.verified)
      throw new AppError(409, "CALENDAR_REQUIRED", "请重新同步学校学期");
    const request = withSemester(session.calendar, () =>
        validate(body, session.calendar),
      ),
      id = crypto.randomUUID();
    const calendar = Object.fromEntries(
      [
        "startDate",
        "academicYear",
        "semester",
        "source",
        "checkedAt",
        "schoolWeek",
        "schoolYearId",
        "schoolSemesterId",
      ].map((k) => [k, session.calendar[k]]),
    );
    const plan = {
      id,
      state: "scanning",
      request,
      calendar,
      operations: [],
      processed: 0,
      total: request.weeks.length * request.studentIds.length,
      createdAt: new Date().toISOString(),
    };
    await pool.query(
      "INSERT INTO task_plans(id,openid,body_hash,payload,expires_at) VALUES (?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 60 MINUTE))",
      [id, openid, hash(request), JSON.stringify(plan)],
    );
    const control = { id, cancelled: false };
    running.set(openid, control);
    session.busyPlan = id;
    void withSemester(calendar, () => scan(openid, session, plan, control))
      .catch(async (e) => {
        plan.state = "failed";
        plan.error = e.message;
        try {
          await persist(id, plan);
        } catch (writeError) {
          require("../utils/logger").error(writeError.message);
        }
      })
      .finally(() => {
        running.delete(openid);
        session.busyPlan = null;
      });
    return { planId: id, state: "scanning" };
  } catch (e) {
    session.busyPlan = null;
    throw e;
  }
}
async function scan(openid, session, plan, control) {
  for (const week of plan.request.weeks) {
    if (control.cancelled) break;
    pendingLogins.get(openid);
    await nav.navigateAndQuery(session.page, week);
    const students = await nav.extractStudentNames(session.page);
    for (const id of plan.request.studentIds) {
      if (control.cancelled) break;
      pendingLogins.get(openid);
      const student = students.find((s) => s.studentId === id),
        payload = {
          ...Object.fromEntries(
            ["mode", "content", "durationMinutes", "method", "scene", "pbType"]
              .filter((k) => plan.request[k] !== undefined)
              .map((k) => [k, plan.request[k]]),
          ),
          recordedAt: plan.request.schedule[week],
        };
      let op = {
        studentId: id,
        studentName: student?.name || id,
        week,
        type: plan.request.recordType,
        payload,
        status: "planned",
      };
      if (!student)
        op = {
          ...op,
          status: "not_applicable",
          reason: "该学生不在本周名单中，不会录入其他人",
        };
      else
        try {
          const info = await driver.inspectStudent(session.page, id, op.type);
          if (info.missing)
            op = {
              ...op,
              status: "not_applicable",
              reason: "该学生不在本周名单中",
            };
          else if (info.records.some((r) => driver.matches(r, payload)))
            op = { ...op, status: "skipped", reason: "相同时间和内容已存在" };
          else if (payload.mode === "missing" && info.records.length)
            op = {
              ...op,
              status: "skipped",
              reason: "已有所选类型记录，不重复补写",
            };
          op.existingCount = info.records.length;
        } catch (e) {
          op = {
            ...op,
            status: "unconfirmed",
            reason: "检查未完成：" + e.message,
          };
        }
      plan.operations.push(op);
      plan.processed++;
      await persist(plan.id, plan);
    }
  }
  plan.state = control.cancelled ? "cancelled" : "ready";
  plan.summary = Object.fromEntries(
    ["planned", "skipped", "not_applicable", "unconfirmed"].map((s) => [
      s,
      plan.operations.filter((o) => o.status === s).length,
    ]),
  );
  await persist(plan.id, plan);
}
async function cancel(id, openid) {
  const plan = await getPlan(id, openid);
  const control = running.get(openid);
  if (control?.id === id) {
    control.cancelled = true;
    return { state: "cancelling" };
  }
  return { state: plan.state };
}
async function retryPlan(uuid, openid) {
  const task = await require("../models/tasksV12").rawTask(uuid, openid),
    operations = await require("../models/tasksV12").operations(uuid);
  const model = require("../models/tasksV12");
  if (model.ACTIVE.includes(task.status))
    throw new AppError(409, "TASK_ACTIVE", "任务仍在执行，请先等待结束");
  const failures = operations.filter((o) =>
    ["failed", "planned", "cancelled"].includes(o.status),
  );
  if (!failures.length)
    throw new AppError(
      409,
      "NO_RETRYABLE_ITEMS",
      "没有可安全重试的失败或未执行项；待回查项不会自动重试",
    );
  const original = model.parse(task.options),
    session = pendingLogins.get(openid);
  await requireSchoolSession(session);
  if (session.calendar?.startDate !== original.calendar.startDate)
    throw new AppError(
      409,
      "CALENDAR_CHANGED",
      "该任务属于其他学期，请先在学校系统核对，不能套用当前学期重试",
    );
  const id = crypto.randomUUID(),
    plan = {
      id,
      state: "ready",
      request: {
        ...original,
        retryOf: uuid,
        weeks: [...new Set(failures.map((o) => o.week))],
        studentIds: [...new Set(failures.map((o) => o.student_id))],
      },
      calendar: original.calendar,
      operations: failures.map((o) => ({
        studentId: o.student_id,
        studentName: o.student_name,
        week: o.week,
        type: o.type,
        payload: o.payload,
        status: "planned",
      })),
      processed: failures.length,
      total: failures.length,
      summary: {
        planned: failures.length,
        skipped: 0,
        not_applicable: 0,
        unconfirmed: 0,
      },
    };
  await pool.query(
    "INSERT INTO task_plans(id,openid,body_hash,payload,expires_at) VALUES (?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 15 MINUTE))",
    [id, openid, model.hash(plan.request), JSON.stringify(plan)],
  );
  return plan;
}
const starting = new Set();
async function start(openid, body) {
  if (starting.has(openid))
    throw new AppError(409, "SCAN_ACTIVE", "检查正在启动，请稍候");
  starting.add(openid);
  try {
    return await startUnlocked(openid, body);
  } finally {
    starting.delete(openid);
  }
}
module.exports = { start, getPlan, cancel, retryPlan, validate, running };
