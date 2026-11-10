const { test, after } = require("node:test"),
  assert = require("node:assert/strict"),
  p = require("../services/academicPlanner"),
  s = require("../services/worklogSchedule"),
  driver = require("../services/recordDriver");
after(() => require("../config/database").end());
const calendar = { startDate: "2026-08-31", week: 11, verified: true };
test("automatic academic entry alternates per absolute semester week and fixed entries stay fixed", () => {
  assert.deepEqual(
    [1, 2, 3, 4].map((w) => p.typeFor("automatic", w)),
    ["companion", "talk", "companion", "talk"],
  );
  assert.equal(p.typeFor("talk", 1), "talk");
  assert.equal(p.typeFor("companion", 2), "companion");
  assert.throws(() => p.typeFor("worklog-talk", 2));
  assert.throws(() => p.weeksOf([12], calendar));
  assert.throws(() => p.weeksOf([1, 1], calendar));
});
test("empty academic content is valid while null, oversized and foreign shaped IDs are rejected", () => {
  const input = { studentIds: ["2022000001"], content: "" };
  assert.equal(p.validateOptions(input, calendar).content, "");
  assert.equal(
    p.validateOptions({ studentIds: input.studentIds }, calendar).content,
    "",
  );
  assert.throws(() =>
    p.validateOptions({ ...input, content: "字".repeat(251) }, calendar),
  );
  assert.throws(() =>
    p.validateOptions({ ...input, studentIds: ["row-index-0"] }, calendar),
  );
});
test("blank content receipt matches exact blank note and time, never every existing note", () => {
  const payload = { recordedAt: "2026-09-01 09:00:00", content: "" };
  assert.equal(
    driver.matches({ thsj: "2026-09-01 09:00", bz: "原有内容" }, payload),
    false,
  );
  assert.equal(
    driver.matches({ thsj: "2026-09-01 09:00", bz: "" }, payload),
    true,
  );
  assert.equal(
    driver.matches({ thsj: "2026-09-01 09:10", bz: "" }, payload),
    false,
  );
});
test("empty note cannot match a modified timestamp instead of the actual activity time", () => {
  assert.equal(
    driver.matches(
      { thsj: "2026-09-01 10:00", updatedAt: "2026-09-01 09:00", bz: "" },
      { recordedAt: "2026-09-01 09:00:00", content: "" },
    ),
    false,
  );
});
test("generated academic work stays in the selected week, weekdays and daytime even with empty content", () => {
  const request = p.validateOptions(
      {
        studentIds: ["2022000001", "2022000002"],
        content: "",
        excludeDates: ["2026-09-01"],
      },
      calendar,
    ),
    days = Array.from({ length: 7 }, (_, i) => ({
      date: s.dateOf(Date.parse("2026-08-31T00:00:00+08:00") + i * s.DAY),
      week: 1,
      editable: true,
      gzrzid: "w1",
    })),
    snapshot = {
      calendar,
      days,
      students: request.studentIds.map((studentId) => ({
        studentId,
        name: "测试",
        hasContact: true,
        semesterCount: 0,
        schoolCount: 0,
      })),
      records: [],
    };
  const result = s.build(snapshot, request);
  assert.equal(result.summary.planned, 2);
  for (const op of result.operations) {
    assert.equal(op.week, 1);
    assert(!op.payload.recordedAt.startsWith("2026-09-01"));
    s.inWindow(
      op.payload.recordedAt,
      op.payload,
      days.find((d) => d.date === op.payload.date),
    );
    assert.equal(op.payload.content, "");
  }
});

test("academic save preflight keeps partial counts writable and stops after school count and round completion", async () => {
  const source = require("../services/academicSchool"),
    guard = require("../services/academicGuard"),
    rules = require("../services/academicRequirements"),
    oldRoster = source.roster,
    oldRecords = source.records;
  const requirement = rules.normalize({
      pc: 2,
      gzcs: 1,
      gzlcth: 1,
      gzlczf: 1,
      gzlcpb: 1,
    }),
    info = {
      week: 1,
      gzrzid: "w1",
      editable: true,
      students: [
        { studentId: "2022000001", requirements: requirement },
        { studentId: "2022000002", requirements: requirement },
      ],
    },
    options = p.validateOptions(
      { studentIds: ["2022000001"], content: "" },
      calendar,
    ),
    op = {
      studentId: "2022000001",
      week: 1,
      type: "talk",
      payload: {
        ...options,
        ruleVersion: 2,
        academicGoal: "count",
        gzrzid: "w1",
        recordedAt: "2026-08-31 09:02:00",
      },
    };
  source.roster = async () => info;
  source.records = async (_, __, id, type) =>
    type === "companion"
      ? []
      : id === "2022000001"
        ? [{ thsj: "2026-08-31 08:30:00", thsc: 10 }]
        : [
            { thsj: "2026-08-31 09:00:00", thsc: 10 },
            { thsj: "2026-08-31 09:01:00", thsc: 10 },
          ];
  try {
    await assert.rejects(
      () => guard.check({}, calendar, op),
      (e) => e.code === "DENSITY_LIMIT",
    );
    op.payload.recordedAt = "2026-08-31 10:00:00";
    assert.equal((await guard.check({}, calendar, op)).skip, false);
    op.studentId = "2023000001";
    await assert.rejects(
      () => guard.check({}, calendar, op),
      (e) => e.code === "ACADEMIC_STUDENT_NOT_OWNED",
    );
    op.studentId = "2022000001";
    info.editable = false;
    await assert.rejects(
      () => guard.check({}, calendar, op),
      (e) => e.code === "WORKLOG_LOCKED",
    );
    info.editable = true;
    info.students[0].requirements = rules.normalize({
      pc: 2,
      gzcs: 2,
      gzlcth: 2,
      gzlczf: 1,
      gzlcpb: 1,
    });
    assert.equal((await guard.check({}, calendar, op)).skip, true);
  } finally {
    source.roster = oldRoster;
    source.records = oldRecords;
  }
});
