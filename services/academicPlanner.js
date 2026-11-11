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
  const data = model.parse(rows[0].payload);
  await require("./connectionScope").assertCurrent(openid, data);
  return {
    ...data,
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
    await require("./schoolSession").requireSchoolSession(session, {
      force: true,
    });
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
      connectionId: session.connectionId,
      schoolAccountKey: session.accountKey || session.connectionId,
      ruleVersion: 2,
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
          const info = await school.roster(session.page, calendar, w),
            type = typeFor(entry, w);
          await require("../utils/readLimit").mapRead(
            info.students,
            async (student) => {
              student.recordCount = (
                await school.records(
                  session.page,
                  info,
                  student.studentId,
                  type,
                )
              ).length;
            },
            { cancelled: () => control.cancelled },
          );
          if (control.cancelled)
            throw new AppError(409, "SCAN_CANCELLED", "已停止读取");
          data.weekRosters.push(info);
          data.progress.processed++;
          await persistSnapshot(id, data);
        }
        const people = new Map();
        for (const info of data.weekRosters)
          for (const s of info.students) {
            if (!people.has(s.studentId))
              people.set(s.studentId, {
                ...s,
                weeks: [],
                missingWeeks: [],
                recordedCount: 0,
                requirementsByWeek: [],
                requiredCount: 0,
                completedCount: 0,
                remainingCount: 0,
                roundMissingCount: 0,
              });
            const person = people.get(s.studentId);
            person.weeks.push(info.week);
            person.recordedCount += s.recordCount;
            person.requirementsByWeek.push({
              week: info.week,
              ...s.requirements,
            });
            person.requiredCount += s.requirements.countExempt
              ? 0
              : s.requirements.required;
            person.completedCount += s.requirements.countExempt
              ? 0
              : Math.min(s.requirements.required, s.requirements.completed);
            person.remainingCount += s.requirements.remaining;
            person.roundMissingCount += s.requirements.roundMissing.length;
            if (s.requirements.remaining || s.requirements.roundMissing.length)
              person.missingWeeks.push(info.week);
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
  require("./academicRequirements").validateOptions({
    scene,
    pbType,
    formOptions: body.formOptions,
  });
  return {
    ...normalized,
    content: content.trim(),
    scene,
    pbType,
    scope: "academic",
    formOptions: body.formOptions,
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
  if (data.ruleVersion !== 2)
    throw new AppError(
      409,
      "ACADEMIC_SNAPSHOT_EXPIRED",
      "学校次数规则已更新，正在重新读取名单",
    );
  const options = validateOptions(
      {
        ...body,
        formOptions: await require("./schoolOptions").get(openid, session),
      },
      data.calendar,
    ),
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
      ruleVersion: 2,
      entry: data.entry,
      recordType: data.entry === "automatic" ? "academic-auto" : data.entry,
      weeks: data.weeks,
      snapshotId: body.snapshotId,
      mode: "missing",
    },
    plan = {
      id,
      connectionId: data.connectionId,
      schoolAccountKey: data.schoolAccountKey,
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
    await require("./schoolSession").requireSchoolSession(session, {
      force: true,
    });
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
      const rules = require("./academicRequirements");
      plan.ruleWarnings = [];
      for (const info of data.weekRosters) {
        if (control.cancelled) break;
        const fresh = await school.roster(
            session.page,
            data.calendar,
            info.week,
          ),
          existing = [];
        const lists = await require("../utils/readLimit").mapRead(
          fresh.students,
          async (person) => {
            const talk = await school.records(
                session.page,
                fresh,
                person.studentId,
                "talk",
              ),
              companion = await school.records(
                session.page,
                fresh,
                person.studentId,
                "companion",
              );
            return { talk, companion };
          },
          { cancelled: () => control.cancelled },
        );
        if (control.cancelled) break;
        for (let n = 0; n < fresh.students.length; n++)
          for (const type of ["talk", "companion"])
            for (const row of lists[n][type]) {
              const time = schedule.stamp(
                type === "talk" ? row.thsj : row.cysj,
              );
              if (!Number.isFinite(time))
                throw new AppError(
                  502,
                  "ACADEMIC_RECORDS_INVALID",
                  "已有记录时间无法核验，已停止安排",
                );
              existing.push({
                id: String(row.id),
                xh: fresh.students[n].studentId,
                thsj: schedule.format(time),
                thsc: Number(row.thsc) || 10,
              });
            }
        const start =
            Date.parse(data.calendar.startDate + "T00:00:00+08:00") +
            (info.week - 1) * 7 * schedule.DAY,
          from = schedule.dateOf(start),
          to = schedule.dateOf(Math.min(start + 6 * schedule.DAY, Date.now())),
          days = Array.from({ length: 7 }, (_, i) => ({
            date: schedule.dateOf(start + i * schedule.DAY),
            week: info.week,
            gzrzid: fresh.gzrzid,
            editable: fresh.editable,
          })),
          booked = [...existing];
        plan.existingTimes ??= [];
        plan.existingTimes.push(...existing.map((r) => schedule.stamp(r.thsj)));
        for (const person of fresh.students.filter((s) =>
          options.studentIds.includes(s.studentId),
        )) {
          if (control.cancelled) break;
          const personIndex = fresh.students.indexOf(person),
            bad = [
              ...lists[personIndex].talk,
              ...lists[personIndex].companion,
            ].some((r) => {
              const time = schedule.stamp(r.thsj || r.cysj);
              return !require("./recordValidity").inspect(r).valid;
            });
          if (bad) {
            plan.operations.push({
              studentId: person.studentId,
              studentName: person.name,
              week: info.week,
              type: typeFor(data.entry, info.week),
              status: "not_applicable",
              reason: "学校有未来或时间不明的记录，请先核对，未重复补写",
              payload: { scope: "academic", ruleVersion: 2 },
            });
            plan.processed++;
            continue;
          }
          const result = rules.goals(
              person.requirements,
              data.entry,
              info.week,
              options,
            ),
            occurrences = {};
          if (result.unhandled.length)
            plan.ruleWarnings.push({
              studentId: person.studentId,
              week: info.week,
              missing: result.unhandled,
            });
          if (!result.operations.length)
            plan.operations.push({
              studentId: person.studentId,
              studentName: person.name,
              week: info.week,
              type: typeFor(data.entry, info.week),
              status: "skipped",
              reason: person.requirements.roundMissing.length
                ? "所选入口无可补项；其他轮次请使用一键录入"
                : "学校次数及本轮举措已完成，不重复录入",
              payload: { scope: "academic", ruleVersion: 2 },
            });
          for (const goal of result.operations) {
            const occurrence = (occurrences[goal.type] || 0) + 1;
            occurrences[goal.type] = occurrence;
            const source = {
              studentId: person.studentId,
              studentName: person.name,
              week: info.week,
              type: goal.type,
              occurrence,
              goal: goal.purpose,
              reason:
                goal.purpose === "count"
                  ? "补足学校应完成次数"
                  : "补齐本轮" +
                    { talk: "谈话", visit: "走访", companion: "陪伴" }[
                      goal.purpose
                    ],
              payload: {
                ...options,
                scope: "academic",
                mode: "missing",
                ruleVersion: 2,
                academicGoal: goal.purpose,
                scene: goal.scene,
                gzrzid: fresh.gzrzid,
                schoolRequirementAtPreview: person.requirements,
              },
            };
            delete source.payload.studentIds;
            if (!fresh.editable) {
              plan.operations.push({
                ...source,
                status: "not_applicable",
                reason: "学校日志不可编辑，次数或轮次仍未完成",
              });
              continue;
            }
            const generated = schedule.build(
              {
                calendar: data.calendar,
                days,
                records: booked,
                students: [
                  {
                    studentId: person.studentId,
                    name: person.name,
                    semesterCount: 0,
                    hasContact: true,
                    schoolCount: 0,
                  },
                ],
              },
              {
                ...options,
                studentIds: [person.studentId],
                fromDate: from,
                toDate: to,
                targetCount: 1,
                skipRecorded: false,
              },
            ).operations[0];
            const op = {
              ...generated,
              ...source,
              status: generated.status,
              reason:
                generated.status === "planned"
                  ? source.reason
                  : generated.reason,
              payload: { ...generated.payload, ...source.payload },
            };
            plan.operations.push(op);
            if (op.status === "planned")
              booked.push({
                id: "preview-" + plan.operations.length,
                xh: person.studentId,
                thsj: op.payload.recordedAt,
                thsc: options.durationMinutes,
              });
            if (plan.operations.length > 1500)
              throw new AppError(
                400,
                "TOO_MANY_OPERATIONS",
                "学校次数及轮次要求超过1500项，请缩小范围",
              );
          }
          plan.processed++;
          plan.progress.processed = plan.processed;
          if (plan.processed % 5 === 0) await save();
        }
        for (const person of info.students.filter(
          (s) =>
            options.studentIds.includes(s.studentId) &&
            !fresh.students.some((p) => p.studentId === s.studentId),
        ))
          plan.operations.push({
            studentId: person.studentId,
            studentName: person.name,
            week: info.week,
            type: typeFor(data.entry, info.week),
            status: "not_applicable",
            reason: "学校学情名册已变化，未替换其他学生",
            payload: { scope: "academic" },
          });
        await save();
      }
      plan.state = control.cancelled ? "cancelled" : "ready";
      plan.total = plan.operations.length;
      plan.request.ruleWarnings = plan.ruleWarnings;
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
    await require("./connectionScope").assertCurrent(openid, p, c);
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
