const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  rules = require("../services/academicRequirements"),
  templates = require("../services/contentTemplates"),
  summary = require("../services/overviewSummary"),
  crypto = require("crypto");
const completed = () =>
  rules.normalize({ pc: 1, gzcs: 1, gzlcth: 1, gzlczf: 1, gzlcpb: 1 });
test("random scene for a missing visit is restricted to school visit options and all concrete companions are reachable", () => {
  const old = crypto.randomInt;
  try {
    for (let slot = 0; slot < 24; slot++) {
      crypto.randomInt = (n) => slot % n;
      const goal = rules.goals(
        { ...completed(), roundMissing: ["visit", "companion"] },
        "automatic",
        1,
        { scene: "随机", pbType: "随机" },
      );
      assert.equal(goal.operations[0].purpose, "visit");
      assert.equal(rules.sceneKind(goal.operations[0].scene), "visit");
      assert(
        rules.COMPANIONS.some((t) => t.label === goal.operations[0].pbType),
      );
      assert(
        goal.operations.every((o) => o.scene !== "随机" && o.pbType !== "随机"),
      );
      assert.deepEqual(goal.unhandled, []);
    }
  } finally {
    crypto.randomInt = old;
  }
  assert.throws(() =>
    rules.validateOptions({ scene: "随机", pbType: "共同运动" }),
  );
  const formOptions = {
    scenes: [{ value: "1", label: "学校走访选项" }],
    companionTypes: [{ value: "3", label: "共同运动" }],
  };
  const custom = rules.goals(
    { ...completed(), roundMissing: ["visit"] },
    "automatic",
    1,
    { scene: "随机", pbType: "随机", formOptions },
  );
  assert.equal(custom.operations[0].credits, 2);
  assert.equal(custom.operations[0].scene, "学校走访选项");
});
test("random content uses only enabled scope-compatible templates and frozen preview text survives library changes", () => {
  const items = structuredClone(templates.DEFAULTS);
  items[0].enabled = false;
  const request = { contentMode: "random", contentTemplates: items };
  for (let slot = 0; slot < 20; slot++) {
    const p = templates.resolve(request, "companion", (n) => slot % n);
    assert(
      items.some(
        (t) =>
          t.id === p.contentTemplateId &&
          t.enabled &&
          ["both", "companion"].includes(t.scope),
      ),
    );
  }
  const p = templates.resolve(request, "talk", () => 0),
    text = p.content;
  items.find((t) => t.id === p.contentTemplateId).content = "修改后的模板";
  assert.equal(JSON.parse(JSON.stringify(p)).content, text);
  assert.throws(
    () =>
      templates.resolve(
        { contentMode: "random", contentTemplates: [] },
        "talk",
      ),
    (e) => e.code === "NO_CONTENT_TEMPLATES",
  );
  assert.deepEqual(templates.resolve({ content: "实际内容" }, "talk"), {
    content: "实际内容",
  });
  assert.throws(() =>
    templates.validateItem({
      title: "标题",
      content: "x".repeat(251),
      scope: "talk",
      enabled: true,
    }),
  );
});
test("academic future anomalies are recomputed when time passes without rereading or mutating the saved snapshot", () => {
  const before = Date.parse("2026-09-01T10:05:00+08:00"),
    after = Date.parse("2026-09-01T10:10:00+08:00");
  const data = {
    calendar: { week: 2 },
    weeks: [
      {
        week: 1,
        students: [
          {
            studentId: "a",
            name: "合成学生",
            requirements: completed(),
            anomalies: ["学校有未来时间记录"],
            records: [
              {
                id: "r",
                type: "talk",
                recordedAt: "2026-09-01 10:00:00",
                duration: 10,
              },
            ],
          },
        ],
      },
      { week: 2, students: [] },
    ],
  };
  assert.equal(summary.academic(data, before).summary.verifiedCompleted, 0);
  assert.equal(summary.academic(data, after).summary.verifiedCompleted, 1);
  assert.equal(data.weeks[0].students[0].anomalies.length, 1);
});
test("academic summary cache expires exactly when a future talk ends", () => {
  const old = Date.now,
    compile = require("../services/overviewCache").compile;
  try {
    let now = Date.parse("2026-09-01T10:05:00+08:00");
    Date.now = () => now;
    const data = {
      id: "clock-regression",
      readCompletedAt: "fixed",
      kind: "academic",
      calendar: { week: 2 },
      weeks: [
        {
          week: 1,
          students: [
            {
              studentId: "a",
              name: "合成学生",
              requirements: completed(),
              records: [
                {
                  type: "talk",
                  recordedAt: "2026-09-01 10:00:00",
                  duration: 10,
                },
              ],
            },
          ],
        },
        { week: 2, students: [] },
      ],
    };
    assert.equal(compile(data).summary.verifiedCompleted, 0);
    now = Date.parse("2026-09-01T10:10:00+08:00");
    assert.equal(compile(data).summary.verifiedCompleted, 1);
  } finally {
    Date.now = old;
  }
});
test("random duration uses the validated range and keeps the maximum reserved window", () => {
  const schedule = require("../services/worklogSchedule"),
    calendar = { startDate: "2026-08-31", week: 2 };
  const request = schedule.normalize(
    {
      studentIds: ["2022000001"],
      durationMode: "random",
      durationMin: 8,
      durationMax: 16,
      contentMode: "manual",
      fromDate: "2026-09-01",
      toDate: "2026-09-01",
    },
    calendar,
    Date.parse("2026-09-02T12:00:00+08:00"),
  );
  const snapshot = {
    calendar,
    days: [{ date: "2026-09-01", week: 1, gzrzid: "mock", editable: true }],
    records: [],
    students: [
      {
        studentId: "2022000001",
        semesterCount: 0,
        schoolCount: 0,
        hasContact: true,
      },
    ],
  };
  for (let n = 0; n < 12; n++) {
    const op = schedule.build(
      snapshot,
      request,
      Date.parse("2026-09-02T12:00:00+08:00"),
    ).operations[0];
    assert(op.payload.durationMinutes >= 8 && op.payload.durationMinutes <= 16);
    assert.equal(request.durationMinutes, 16);
  }
  assert.throws(() =>
    schedule.normalize(
      {
        studentIds: ["2022000001"],
        durationMode: "random",
        durationMin: 30,
        durationMax: 10,
      },
      calendar,
    ),
  );
});
