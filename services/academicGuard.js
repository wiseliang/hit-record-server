const school = require("./academicSchool"),
  schedule = require("./worklogSchedule"),
  { AppError } = require("../utils/errors");
async function check(page, calendar, op) {
  const info = await school.roster(page, calendar, op.week),
    p = op.payload;
  if (info.gzrzid !== p.gzrzid)
    throw new AppError(
      409,
      "ACADEMIC_LOG_CHANGED",
      "学校周日志已变化，请重新生成预览",
    );
  if (!info.students.some((s) => s.studentId === op.studentId))
    throw new AppError(
      409,
      "ACADEMIC_STUDENT_NOT_OWNED",
      "学生已不在该周学情名单，未录入",
    );
  const t = schedule.stamp(p.recordedAt),
    start =
      Date.parse(calendar.startDate + "T00:00:00+08:00") +
      (op.week - 1) * 7 * schedule.DAY;
  if (!Number.isFinite(t) || t < start || t >= start + 7 * schedule.DAY)
    throw new AppError(400, "INVALID_WEEK_DATE", "时间不在对应周内");
  schedule.inWindow(p.recordedAt, p, {
    date: schedule.dateOf(t),
    editable: info.editable,
  });
  const own = [
    ...(await school.records(page, info, op.studentId, "talk")),
    ...(await school.records(page, info, op.studentId, "companion")),
  ];
  if (
    own.some((r) => {
      const time = schedule.stamp(r.thsj || r.cysj);
      return (
        !Number.isFinite(time) ||
        time + (r.thsj ? (Number(r.thsc) || 10) * schedule.MIN : 0) > Date.now()
      );
    })
  )
    throw new AppError(
      409,
      "ACADEMIC_RECORDS_INVALID",
      "学校已有未来或时间不明的记录，请先核对",
    );
  if (p.ruleVersion !== 2)
    throw new AppError(
      409,
      "ACADEMIC_RULES_UPDATED",
      "次数和轮次规则已更新，请重新生成预览",
    );
  const person = info.students.find((s) => s.studentId === op.studentId);
  if (
    !require("./academicRequirements").needed(
      person.requirements,
      p.academicGoal,
    )
  )
    return { skip: true };
  const times = [];
  const lists = await require("../utils/readLimit").mapRead(
    info.students,
    async (s) => [
      ...(await school.records(page, info, s.studentId, "talk")),
      ...(await school.records(page, info, s.studentId, "companion")),
    ],
  );
  for (const records of lists) {
    for (const r of records) {
      const v = r.thsj || r.cysj,
        stamp = schedule.stamp(v);
      if (!Number.isFinite(stamp))
        throw new AppError(
          502,
          "ACADEMIC_RECORDS_INVALID",
          "已有记录时间无法核验，未提交",
        );
      times.push(stamp);
    }
  }
  if (!schedule.densityOK(t, times))
    throw new AppError(
      409,
      "DENSITY_LIMIT",
      "学校已有记录变化，此时段10分钟内超过2人，未提交",
    );
  return { skip: false };
}
module.exports = { check };
