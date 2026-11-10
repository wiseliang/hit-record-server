const school = require("./academicSchool");
async function check(page, calendar, operations) {
  const weeks = new Map(),
    seen = new Set(),
    outstanding = [];
  for (const op of operations) {
    const id = op.student_id || op.studentId,
      key = op.week + ":" + id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!weeks.has(op.week))
      weeks.set(op.week, await school.roster(page, calendar, op.week));
    const info = weeks.get(op.week),
      person = info.students.find((s) => s.studentId === id);
    if (!person) {
      outstanding.push({
        studentId: id,
        week: op.week,
        reason: "学校名册已变化",
      });
      continue;
    }
    const r = person.requirements;
    if (!r || r.remaining || r.roundMissing.length)
      outstanding.push({
        studentId: id,
        week: op.week,
        remaining: r?.remaining,
        roundMissing: r?.roundMissing,
        reason: "学校次数或本轮举措尚未全部满足",
      });
  }
  return outstanding;
}
module.exports = { check };
