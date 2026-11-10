const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  s = require("../services/worklogSchedule");
const now = Date.parse("2026-11-10T15:40:00+08:00"),
  calendar = {
    startDate: "2026-08-31",
    academicYear: "2026—2027",
    semester: "秋季",
    week: 11,
    verified: true,
  };
function snapshot(n = 242) {
  const days = Array.from({ length: 11 * 7 }, (_, i) => ({
    date: s.dateOf(
      Date.parse(calendar.startDate + "T00:00:00+08:00") + i * s.DAY,
    ),
    week: Math.floor(i / 7) + 1,
    editable: true,
    gzrzid: "week-" + Math.floor(i / 7),
  }));
  return {
    calendar,
    days,
    students: Array.from({ length: n }, (_, i) => ({
      studentId: String(2025000000 + i),
      name: "同名学生",
      semesterCount: 0,
      schoolCount: 0,
      hasContact: true,
    })),
    records: [],
  };
}
function request(snapshot, patch = {}) {
  return s.normalize(
    {
      studentIds: snapshot.students.map((x) => x.studentId),
      content: "已经实际开展的谈话，提交前核对",
      ...patch,
    },
    calendar,
    now,
  );
}
test("242 students are spread across elapsed weekdays, all finish before now, and rolling density stays <=2", () => {
  const data = snapshot(),
    r = request(data),
    result = s.build(data, r, now),
    ops = result.operations.filter((o) => o.status === "planned");
  assert.equal(ops.length, 242);
  const times = [];
  for (const op of ops) {
    assert.equal(
      s.inWindow(
        op.payload.recordedAt,
        r,
        data.days.find((d) => d.date === op.payload.date),
        now,
      ),
      s.stamp(op.payload.recordedAt),
    );
    assert.equal(s.densityOK(s.stamp(op.payload.recordedAt), times), true);
    times.push(s.stamp(op.payload.recordedAt));
  }
  const weekly = result.distribution.filter((d) => d.week <= 10);
  assert.ok(
    Math.max(...weekly.map((w) => w.planned)) -
      Math.min(...weekly.map((w) => w.planned)) <=
      1,
  );
  assert.ok(result.distribution.find((d) => d.week === 11).planned > 0);
});
test("already-recorded students remain selected but are skipped according to semester target", () => {
  const data = snapshot(3);
  data.students[0].semesterCount = 1;
  data.students[0].schoolCount = 9;
  data.records = [
    {
      id: "existing",
      xh: data.students[0].studentId,
      thsj: "2026-09-01 09:00:00",
      thsc: 10,
    },
  ];
  const result = s.build(data, request(data), now);
  assert.equal(result.summary.skipped, 1);
  assert.equal(result.summary.planned, 2);
  assert.match(
    result.operations.find((o) => o.status === "skipped").reason,
    /本学期/,
  );
  assert.equal(data.students.length, 3);
});
test("multiple target occurrences keep independent operation keys and do not invent contacts", () => {
  const data = snapshot(2);
  data.students[1].hasContact = false;
  const result = s.build(data, request(data, { targetCount: 3 }), now);
  assert.equal(result.summary.planned, 3);
  assert.equal(result.summary.not_applicable, 3);
  assert.equal(
    new Set(
      result.operations
        .filter((o) => o.status === "planned")
        .map((o) => o.occurrence),
    ).size,
    3,
  );
});
test("closed weeks and excluded dates are never used and no future fallback is allowed", () => {
  const data = snapshot(3);
  data.days.forEach((d) => (d.editable = false));
  const result = s.build(data, request(data), now);
  assert.equal(result.summary.planned, 0);
  assert.equal(result.unscheduled, 3);
  const d2 = snapshot(3),
    excluded = d2.days
      .filter((d) => new Date(d.date + "T00:00:00Z").getUTCDay() === 1)
      .map((d) => d.date),
    r = request(d2, { excludeDates: excluded });
  assert.ok(
    s
      .build(d2, r, now)
      .operations.every((o) => !excluded.includes(o.payload.date)),
  );
});
test("rolling windows do not reset at fixed 10-minute boundaries", () => {
  const t = Date.parse("2026-09-01T09:09:00+08:00");
  assert.equal(s.densityOK(t + 2 * s.MIN, [t, t + s.MIN]), false);
  assert.equal(s.densityOK(t + 10 * s.MIN, [t, t + 5 * s.MIN]), false);
  assert.equal(s.densityOK(t + 11 * s.MIN, [t, t + 5 * s.MIN]), true);
});
test("manual times reject future end, weekend, lunch, out-of-semester and minute truncation", () => {
  const data = snapshot(1),
    r = request(data),
    day = (date) => data.days.find((d) => d.date === date);
  for (const value of [
    "2026-11-10 15:35:00",
    "2026-09-05 09:00:00",
    "2026-09-01 12:00:00",
    "2026-09-01 09:00:30",
  ])
    assert.throws(() => s.inWindow(value, r, day(value.slice(0, 10)), now));
  for (const patch of [
    { fromDate: "2026-08-30" },
    { toDate: "2026-11-11" },
    { targetCount: 11 },
    { shifts: [["07:00", "08:00"]] },
    { durationMinutes: 0 },
  ])
    assert.throws(() => request(data, patch));
});
test("external and duplicated student IDs are rejected instead of replaced by row index", () => {
  const data = snapshot(2);
  assert.throws(() =>
    request(data, {
      studentIds: [data.students[0].studentId, data.students[0].studentId],
    }),
  );
  const r = request(data, { studentIds: ["2025999999"] });
  assert.throws(
    () => s.build(data, r, now),
    (e) => e.code === "STUDENT_NOT_OWNED",
  );
});

test("one student cannot receive duplicate talks in the only available minute", () => {
  const data = snapshot(1),
    r = request(data, {
      fromDate: "2026-08-31",
      toDate: "2026-08-31",
      shifts: [["09:00", "09:10"]],
      targetCount: 2,
    });
  const result = s.build(data, r, now);
  assert.equal(result.summary.planned, 1);
  assert.equal(result.summary.not_applicable, 1);
});
