const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  rules = require("../services/academicRequirements"),
  s = require("../services/overviewSummary");
const raw = (patch = {}) => ({
    pc: "2",
    gzcs: "1",
    gzlcth: "1",
    gzlczf: "1",
    gzlcpb: "1",
    lc: "1",
    lczs: "17",
    sfjjxs: "0",
    ...patch,
  }),
  options = { scene: "其他", pbType: "共同上课" };
test("school quota fields are required, numeric strings accepted and school cycle span is not fabricated into a weekly target", () => {
  const r = rules.normalize(raw());
  assert.equal(r.required, 2);
  assert.equal(r.remaining, 1);
  assert.equal(r.schoolCycleSpan, "17");
  for (const key of ["pc", "gzcs", "gzlcth", "gzlczf", "gzlcpb"])
    assert.throws(() => rules.normalize({ ...raw(), [key]: undefined }));
  assert.throws(() => rules.normalize(raw({ pc: "unknown" })));
});
test("one existing record does not complete a multi-count week", () => {
  const r = rules.normalize(raw({ pc: "4" })),
    g = rules.goals(r, "automatic", 2, options);
  assert.equal(g.operations.length, 3);
  assert(g.operations.every((o) => o.type === "talk"));
  assert.equal(rules.needed(r, "count"), true);
});
test("school round visit remains required even when weekly count is already met", () => {
  const r = rules.normalize(raw({ gzcs: "4", gzlczf: "0" })),
    g = rules.goals(r, "automatic", 1, options);
  assert.deepEqual(g.operations, [
    { type: "talk", purpose: "visit", scene: "走访寝室", credits: 2 },
  ]);
  assert.equal(rules.needed(r, "visit"), true);
});
test("visit-scene talk covers both talk and visit, companion fills the remaining measure without redundant talk", () => {
  const r = rules.normalize(
      raw({ pc: "3", gzcs: "0", gzlcth: "0", gzlczf: "0", gzlcpb: "0" }),
    ),
    g = rules.goals(r, "automatic", 1, options);
  assert.deepEqual(
    g.operations.map((o) => [o.type, o.purpose]),
    [
      ["talk", "visit"],
      ["companion", "companion"],
    ],
  );
  assert.equal(
    g.operations.reduce((n, o) => n + o.credits, 0),
    3,
  );
  assert.deepEqual(g.unhandled, []);
});
test("all missing counts and measures are covered in simulation and the next preview becomes empty", () => {
  const source = raw({
      pc: "9",
      gzcs: "1",
      gzlcth: "0",
      gzlczf: "0",
      gzlcpb: "0",
    }),
    g = rules.goals(rules.normalize(source), "automatic", 2, options);
  for (const o of g.operations) {
    source.gzcs = Number(source.gzcs) + o.credits;
    if (o.type === "talk") {
      source.gzlcth = Number(source.gzlcth) + 1;
      const k = rules.sceneKind(o.scene);
      if (k)
        source[k === "visit" ? "gzlczf" : "gzlcpb"] =
          Number(source[k === "visit" ? "gzlczf" : "gzlcpb"]) + 1;
    } else source.gzlcpb = Number(source.gzlcpb) + 1;
  }
  assert(Number(source.gzcs) >= 9);
  assert.deepEqual(
    rules.goals(rules.normalize(source), "automatic", 2, options).operations,
    [],
  );
});
test("fixed entry stays its own type, reports missing other round measures, and count exemptions preserve the school round check", () => {
  const r = rules.normalize(
      raw({ gzcs: "2", gzlcth: "0", gzlczf: "0", gzlcpb: "0" }),
    ),
    g = rules.goals(r, "companion", 2, options);
  assert(g.operations.every((o) => o.type === "companion"));
  assert.deepEqual(g.unhandled, ["talk", "visit"]);
  assert.equal(rules.normalize(raw({ sfjjxs: "1" })).remaining, 0);
});
test("school dropdown values reject arbitrary text and retain official text and code mapping", () => {
  assert.equal(rules.SCENES.length, 11);
  assert.equal(rules.COMPANIONS.length, 4);
  assert.equal(rules.sceneKind("走访实验室"), "visit");
  assert.equal(rules.sceneKind("陪伴进餐"), "companion");
  assert.throws(() => rules.validateOptions({ ...options, scene: "随便填" }));
  assert.throws(() =>
    rules.validateOptions({ ...options, pbType: "共同自习" }),
  );
});
const person = (id, patch = {}) => ({
  studentId: id,
  name: "示例" + id,
  requirements: rules.normalize(raw(patch)),
  records: [],
  recordCount: 1,
  anomalies: [],
});
test("academic overview counts actual weekly membership, independent school count and round deficits, and keeps current week separate", () => {
  const result = s.academic({
    calendar: { week: 3 },
    weeks: [
      {
        week: 1,
        editable: true,
        students: [
          person("a", { gzcs: "2" }),
          person("b", { gzcs: "2", gzlczf: "0" }),
        ],
      },
      { week: 2, editable: true, students: [person("a")] },
      { week: 3, editable: true, students: [person("a"), person("c")] },
    ],
  });
  assert.equal(result.summary.expected, 3);
  assert.equal(result.summary.completed, 1);
  assert.equal(result.summary.requiredCount, 6);
  assert.equal(result.summary.completedCount, 5);
  assert.equal(result.summary.missingCounts, 1);
  assert.equal(result.summary.missingRounds, 1);
  assert.equal(result.students.find((p) => p.studentId === "c").expected, 0);
  assert.equal(result.summary.currentWeek.expected, 2);
});
test("failed week is unknown rather than a zero or a fake full completion percentage", () => {
  const result = s.academic({
    calendar: { week: 3 },
    weeks: [
      { week: 1, students: [person("a", { gzcs: "2" })] },
      { week: 2, error: "读取失败", students: [] },
      { week: 3, students: [] },
    ],
  });
  assert.equal(result.summary.complete, false);
  assert.equal(result.summary.unverifiedWeeks, 1);
});
test("future academic record prevents normal completion and worklog future talks never count toward target", () => {
  const a = person("a", { gzcs: "2" });
  a.anomalies = ["未来时间"];
  assert.equal(
    s.academic({ calendar: { week: 2 }, weeks: [{ week: 1, students: [a] }] })
      .summary.completed,
    0,
  );
  const now = Date.parse("2026-09-02T10:00:00+08:00"),
    result = s.worklog(
      {
        students: [
          { studentId: "a", name: "示例", schoolCount: 999, hasContact: true },
          {
            studentId: "b",
            name: "另一个",
            schoolCount: 888,
            hasContact: true,
          },
        ],
        records: [
          { xh: "a", thsj: "2026-09-01 09:00:00", thsc: 10 },
          { xh: "a", thsj: "2026-09-01 10:00:00", thsc: 10 },
          { xh: "b", thsj: "2026-09-03 09:00:00", thsc: 10 },
        ],
      },
      1,
      now,
    );
  assert.equal(result.summary.completed, 1);
  assert.equal(result.summary.missingStudents, 1);
  assert.equal(result.summary.missingCounts, 1);
  assert.equal(result.students[1].completed, 0);
  assert.equal(result.summary.futureCount, 1);
  assert.equal(result.students[0].schoolCount, 999);
});
test("overview paging searches the whole source, and does not confuse the first 50 with the complete roster", () => {
  const data = {
    summary: {},
    students: Array.from({ length: 242 }, (_, i) => ({
      studentId: String(i),
      name: "示例" + i,
      remaining: i % 2,
      unknown: i === 241,
    })),
  };
  assert.equal(s.page(data).students.length, 50);
  assert.equal(s.page(data).totalStudents, 242);
  assert.equal(
    s.page(data, { query: "241", filter: "unknown" }).students[0].studentId,
    "241",
  );
  assert.equal(s.page(data, { filter: "missing" }).matched, 121);
});
test("post-save verification does not equate all receipts with fulfilled school requirements", async () => {
  const school = require("../services/academicSchool"),
    old = school.roster,
    post = require("../services/academicPostcheck");
  let reads = 0;
  school.roster = async () => {
    reads++;
    return {
      students: [
        {
          studentId: "a",
          requirements: rules.normalize(raw({ gzcs: "1", gzlczf: "0" })),
        },
        { studentId: "b", requirements: rules.normalize(raw({ gzcs: "2" })) },
      ],
    };
  };
  try {
    const result = await post.check({}, {}, [
      { student_id: "a", week: 1 },
      { student_id: "a", week: 1 },
      { student_id: "b", week: 1 },
    ]);
    assert.equal(reads, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].remaining, 1);
    assert.deepEqual(result[0].roundMissing, ["visit"]);
  } finally {
    school.roster = old;
    await require("../config/database").end();
  }
});
test("cached overview crosses Shanghai Monday midnight without continuing to label the prior week as current or hiding unread weeks", () => {
  const data = {
      kind: "academic",
      calendar: { startDate: "2026-08-31", week: 11 },
      weeks: [{ week: 11, students: [person("a", { gzcs: "2" })] }],
    },
    before = s.atTime(data, Date.parse("2026-11-15T15:59:59Z")),
    after = s.atTime(data, Date.parse("2026-11-15T16:00:00Z"));
  assert.equal(before.calendar.week, 11);
  assert.equal(after.calendar.week, 12);
  const result = s.academic(after);
  assert.equal(result.students[0].weeks[0].current, false);
  assert.equal(result.summary.currentWeek.week, 12);
  assert.match(result.summary.currentWeek.error, /尚未读取/);
  assert.equal(result.summary.complete, false);
});
