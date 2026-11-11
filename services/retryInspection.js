// Read-only recovery: a retry is a fresh preview, never a replay of saved writes.
const academic = require("./academicSchool"),
  worklog = require("./worklogSchool"),
  schedule = require("./worklogSchedule"),
  driver = require("./recordDriver"),
  nav = require("./navigator");
async function inspect(
  page,
  plan,
  failures,
  { cancelled = () => false, onProgress = async () => {} } = {},
) {
  return require("../utils/executionMetrics").run(
    plan.id,
    "retry-read",
    async () => {
      const state = failures.some((o) => o.type === "worklog-talk")
        ? await worklog.readSnapshot(page, plan.calendar, { cancelled })
        : null;
      const weeks = new Map();
      for (const row of failures) {
        if (cancelled())
          throw new (require("../utils/errors").AppError)(
            409,
            "SCAN_CANCELLED",
            "已停止重试检查，未写入学校记录",
          );
        const op = {
          studentId: row.student_id,
          studentName: row.student_name,
          week: row.week,
          type: row.type,
          occurrence: row.occurrence,
          payload: row.payload,
          status: "planned",
        };
        if (row.type === "worklog-talk") {
          const own = state.students.find((s) => s.studentId === op.studentId),
            day = state.days.find((d) => d.date === op.payload.date),
            matches = state.records.filter((r) =>
              require("./worklogDriver").same(r, op),
            );
          const completed = state.records.filter(
            (r) =>
              r.xh === op.studentId &&
              require("./recordValidity").inspect(r).valid,
          ).length;
          if (
            matches.length ||
            (op.payload.skipRecorded && completed >= op.payload.targetCount)
          ) {
            op.status = "skipped";
            op.reason = "重新读取学校记录后确认已录入或达到目标，不重复提交";
          } else if (
            !own ||
            !own.hasContact ||
            !day?.editable ||
            day.gzrzid !== op.payload.gzrzid
          ) {
            op.status = "not_applicable";
            op.reason =
              "学校名单、联系方式或可编辑日期已变化，请重新读取名单生成计划";
          } else schedule.inWindow(op.payload.recordedAt, op.payload, day);
        } else if (plan.request.scope === "academic") {
          if (!weeks.has(row.week))
            weeks.set(
              row.week,
              await academic.roster(page, plan.calendar, row.week),
            );
          const info = weeks.get(row.week);
          if (!info.students.some((s) => s.studentId === op.studentId)) {
            op.status = "not_applicable";
            op.reason = "该学生已不在本周学情名单，不会借用工作日志人员";
          } else if (
            op.payload.ruleVersion === 2
              ? !require("./academicRequirements").needed(
                  info.students.find((s) => s.studentId === op.studentId)
                    .requirements,
                  op.payload.academicGoal,
                )
              : (await academic.records(page, info, op.studentId, op.type))
                  .length
          ) {
            op.status = "skipped";
            op.reason = "重新读取学校次数及轮次后，该项要求已完成，不重复提交";
          } else if (!info.editable || info.gzrzid !== op.payload.gzrzid) {
            op.status = "not_applicable";
            op.reason = "学校周日志已变化或不可编辑，请重新生成计划";
          } else
            schedule.inWindow(op.payload.recordedAt, op.payload, {
              date: schedule.dateOf(schedule.stamp(op.payload.recordedAt)),
              editable: true,
            });
        } else {
          await nav.navigateAndQuery(page, row.week);
          const info = await driver.inspectStudent(page, op.studentId, op.type);
          if (info.missing) {
            op.status = "not_applicable";
            op.reason = "该学生不在本周名单";
          } else if (info.records.some((r) => driver.matches(r, op.payload))) {
            op.status = "skipped";
            op.reason = "相同记录已存在，不重复提交";
          }
        }
        plan.operations.push(op);
        plan.processed = plan.operations.length;
        await onProgress();
      }
      if (cancelled())
        throw new (require("../utils/errors").AppError)(
          409,
          "SCAN_CANCELLED",
          "已停止重试检查，未写入学校记录",
        );
    },
  );
}
module.exports = { inspect };
