const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto"),
  methods = require("../services/conversationMethod"),
  schedule = require("../services/worklogSchedule");
test("random selection maps each of three equally likely slots to a concrete native method", () => {
  for (let i = 0; i < 3; i++)
    assert.equal(
      methods.resolve("随机", (max) => {
        assert.equal(max, 3);
        return i;
      }),
      methods.METHODS[i],
    );
  for (const method of methods.METHODS)
    assert.equal(
      methods.resolve(method, () => {
        throw Error("fixed methods must not draw randomness");
      }),
      method,
    );
  assert.throws(() => methods.resolve("自动"));
  assert.throws(() => methods.validate("随机"));
});
test("work-log random methods are materialized once per operation and survive preview reload and unrelated edits", () => {
  const calendar = { startDate: "2026-08-31", week: 11 },
    now = Date.parse("2026-11-11T15:00:00+08:00"),
    ids = ["2022000001", "2022000002", "2022000003"],
    snapshot = {
      calendar,
      records: [],
      students: ids.map((studentId) => ({
        studentId,
        name: "合成学生",
        semesterCount: 0,
        schoolCount: 0,
        hasContact: true,
      })),
      days: [
        { date: "2026-09-01", week: 1, gzrzid: "fixture", editable: true },
      ],
    },
    request = schedule.normalize(
      {
        studentIds: ids,
        method: "随机",
        fromDate: "2026-09-01",
        toDate: "2026-09-01",
      },
      calendar,
      now,
    ),
    old = crypto.randomInt;
  let i = 0;
  crypto.randomInt = (max) => i++ % max;
  let plan;
  try {
    plan = schedule.build(snapshot, request, now);
  } finally {
    crypto.randomInt = old;
  }
  assert.equal(request.method, "随机");
  assert.deepEqual(
    plan.operations.map((o) => o.payload.method),
    methods.METHODS,
  );
  const reloaded = JSON.parse(JSON.stringify(plan));
  reloaded.operations[0].payload.content = "核对后的实际内容";
  assert.deepEqual(
    reloaded.operations.map((o) => o.payload.method),
    methods.METHODS,
  );
  assert(plan.operations.every((o) => o.status === "planned"));
});
test("fixed method previews retain the explicitly chosen method for all students", () => {
  const calendar = { startDate: "2026-08-31", week: 11 },
    now = Date.parse("2026-11-11T15:00:00+08:00"),
    ids = ["2022000001", "2022000002"];
  const snapshot = {
    calendar,
    records: [],
    students: ids.map((studentId) => ({
      studentId,
      name: "合成学生",
      semesterCount: 0,
      schoolCount: 0,
      hasContact: true,
    })),
    days: [{ date: "2026-09-01", week: 1, gzrzid: "fixture", editable: true }],
  };
  for (const method of methods.METHODS) {
    const request = schedule.normalize(
      { studentIds: ids, method, fromDate: "2026-09-01", toDate: "2026-09-01" },
      calendar,
      now,
    );
    assert(
      schedule
        .build(snapshot, request, now)
        .operations.every((o) => o.payload.method === method),
    );
  }
});
