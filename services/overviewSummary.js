const rules = require("./academicRequirements"),
  schedule = require("./worklogSchedule");
const LABELS = { talk: "谈话", visit: "走访", companion: "陪伴" };
function academic(data) {
  const people = new Map(),
    weeks = [],
    current = data.calendar.week;
  let expected = 0,
    completed = 0,
    requiredCount = 0,
    completedCount = 0,
    missingRounds = 0,
    missingCounts = 0,
    unverified = 0;
  for (const info of data.weeks) {
    if (info.error) {
      unverified++;
      weeks.push({ week: info.week, error: info.error });
      continue;
    }
    const ended = info.week < current;
    let done = 0;
    for (const s of info.students) {
      const r = s.requirements,
        anomalies = s.anomalies || [],
        ok = !r.remaining && !r.roundMissing.length && !anomalies.length;
      if (!people.has(s.studentId))
        people.set(s.studentId, {
          studentId: s.studentId,
          name: s.name,
          weeks: [],
          expected: 0,
          completed: 0,
          remainingCount: 0,
          roundMissingCount: 0,
          unknown: false,
          issues: [],
        });
      const person = people.get(s.studentId);
      const row = {
        week: info.week,
        required: r.required,
        completed: r.completed,
        remaining: r.remaining,
        countExempt: r.countExempt,
        roundMissing: r.roundMissing,
        round: r.round,
        editable: info.editable,
        current: !ended,
        complete: ok,
        anomalies,
        recordCount: s.recordCount,
      };
      person.weeks.push(row);
      if (anomalies.length) {
        person.unknown = true;
        person.issues.push("第" + info.week + "周记录需核实");
      }
      if (ok) done++;
      if (ended) {
        expected++;
        person.expected++;
        if (ok) {
          completed++;
          person.completed++;
        }
        requiredCount += r.countExempt ? 0 : r.required;
        completedCount += r.countExempt ? 0 : Math.min(r.required, r.completed);
        missingCounts += r.remaining;
        person.remainingCount += r.remaining;
        missingRounds += r.roundMissing.length;
        person.roundMissingCount += r.roundMissing.length;
      }
    }
    weeks.push({
      week: info.week,
      current: !ended,
      expected: info.students.length,
      completed: done,
      editable: info.editable,
    });
  }
  for (let week = 1; week <= current; week++)
    if (!weeks.some((w) => w.week === week)) {
      unverified++;
      weeks.push({
        week,
        current: week === current,
        error: "该周尚未读取，请更新学校记录",
      });
    }
  weeks.sort((a, b) => a.week - b.week);
  const students = [...people.values()];
  return {
    summary: {
      expected,
      completed,
      missing: expected - completed,
      requiredCount,
      completedCount,
      missingCounts,
      missingRounds,
      unverifiedWeeks: unverified,
      complete: !unverified,
      missingStudents: students.filter((s) => s.completed < s.expected).length,
      currentWeek: weeks.find((w) => w.week === current) || null,
    },
    weeks,
    students,
  };
}
function worklog(data, target = 1, now = Date.now()) {
  if (!Number.isInteger(target) || target < 1 || target > 10)
    throw new (require("../utils/errors").AppError)(
      400,
      "INVALID_TARGET",
      "学期目标为1–10次",
    );
  const students = data.students.map((s) => {
    const records = data.records.filter((r) => r.xh === s.studentId),
      valid = records.filter(
        (r) => schedule.stamp(r.thsj) + Number(r.thsc) * schedule.MIN <= now,
      ),
      future = records.length - valid.length;
    return {
      studentId: s.studentId,
      name: s.name,
      major: s.major,
      hasContact: s.hasContact,
      schoolCount: s.schoolCount,
      completed: valid.length,
      expected: target,
      remaining: Math.max(0, target - valid.length),
      unknown: future > 0,
      futureCount: future,
      lastDate:
        valid
          .map((r) => r.thsj)
          .sort()
          .at(-1) || null,
    };
  });
  return {
    summary: {
      expected: students.length,
      completed: students.filter((s) => s.completed >= target).length,
      missingStudents: students.filter((s) => s.completed < target).length,
      missingCounts: students.reduce((n, s) => n + s.remaining, 0),
      futureCount: students.reduce((n, s) => n + s.futureCount, 0),
      complete: true,
      targetCount: target,
    },
    students,
  };
}
function page(
  data,
  { query = "", filter = "all", page = 1, pageSize = 50 } = {},
) {
  const q = String(query).trim().toLowerCase();
  page = Math.max(1, Math.trunc(Number(page) || 1));
  pageSize = Math.min(50, Math.max(1, Math.trunc(Number(pageSize) || 50)));
  const people = data.students.filter(
    (s) =>
      (!q || (s.name + " " + s.studentId).toLowerCase().includes(q)) &&
      (filter !== "missing" ||
        (s.remaining ?? s.expected - s.completed) > 0 ||
        s.roundMissingCount > 0) &&
      (filter !== "unknown" || s.unknown),
  );
  return {
    ...data,
    students: people.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    totalStudents: data.students.length,
    matched: people.length,
    hasMore: page * pageSize < people.length,
  };
}
function atTime(data, now = Date.now()) {
  if (data.kind !== "academic") return data;
  const start = Date.parse(data.calendar.startDate + "T00:00:00+08:00"),
    week = Math.max(
      1,
      Math.min(60, Math.floor((now - start) / (7 * schedule.DAY)) + 1),
    );
  return { ...data, calendar: { ...data.calendar, week } };
}
module.exports = { academic, worklog, page, LABELS, atTime };
