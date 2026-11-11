const { test, after } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path"),
  vm = require("vm");
const summary = require("../services/overviewSummary"),
  validity = require("../services/recordValidity"),
  schedule = require("../services/worklogSchedule");
function load(relative, overrides = {}) {
  const filename = path.resolve(__dirname, "..", relative),
    local = require("node:module").createRequire(filename),
    ctx = {
      module: { exports: {} },
      require: (n) => (Object.hasOwn(overrides, n) ? overrides[n] : local(n)),
      process,
      console,
      Buffer,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      performance,
      __dirname: path.dirname(filename),
    };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), ctx, { filename });
  return ctx.module.exports;
}
after(() => require("../config/database").end());
test("invalid and future work-log records are held, not counted or automatically replaced", () => {
  for (const duration of [0, -10, NaN, 1441]) {
    const data = {
        students: [{ studentId: "2022000001", name: "fixture" }],
        records: [
          { xh: "2022000001", thsj: "2026-09-01 09:00:00", thsc: duration },
        ],
      },
      result = summary.worklog(data, 1);
    assert.equal(result.students[0].completed, 0);
    assert.equal(result.students[0].unknown, true);
    assert.equal(result.summary.invalidCount, 1);
  }
  assert.equal(
    validity.inspect({ thsj: "2099-01-01 09:00:00", thsc: 10 }).future,
    true,
  );
  assert(Number.isNaN(schedule.stamp("2026-02-30 09:00:00")));
});
test("academic pagination supports smaller actual pages and rejects gaps, repeated IDs and changing totals", async () => {
  const { collect } = require("../services/schoolPagination");
  assert.equal(
    (
      await collect(async ({ page }) => ({
        data: [{ id: "r" + page }],
        total: 2,
      }))
    ).length,
    2,
  );
  await assert.rejects(
    collect(async ({ page }) => ({
      data: page === 1 ? [{ id: "r" }] : [],
      total: 2,
    })),
    /分页缺失/,
  );
  await assert.rejects(
    collect(async () => ({ data: [{ id: "same" }], total: 2 })),
    /重复/,
  );
  await assert.rejects(
    collect(async ({ page }) => ({
      data: [{ id: String(page) }],
      total: page === 1 ? 2 : 3,
    })),
    /总数变化/,
  );
});
test("current-week, count and round filters remain separate from historical completion", () => {
  const data = summary.academic({
    calendar: { week: 1 },
    weeks: [
      {
        week: 1,
        editable: true,
        students: [
          {
            studentId: "2022000001",
            name: "fixture",
            requirements: {
              required: 1,
              completed: 0,
              remaining: 1,
              roundMissing: ["talk"],
              round: { talk: 0, visit: 1, companion: 1 },
            },
            recordCount: 0,
          },
        ],
      },
    ],
  });
  assert.equal(data.summary.expected, 0);
  assert.equal(summary.page(data, { filter: "missing" }).matched, 0);
  assert.equal(summary.page(data, { filter: "current" }).matched, 1);
});
test("read-only receipt verification does not promote unarranged work or retained school deficits", async () => {
  const updates = [],
    task = {
      type: "academic-auto",
      status: "partial_failed",
      total: 1,
      options: {
        calendar: { startDate: "2026-08-31" },
        schoolOutstanding: [{ remaining: 1 }],
      },
      progress: { processed: 1, error: 0, unconfirmed: 0, notApplicable: 1 },
      details: [{ status: "not_applicable" }],
    },
    session = {
      step: "ready",
      calendar: { startDate: "2026-08-31" },
      page: {},
    };
  const runner = load("services/taskRunner.js", {
    "../config/database": {
      query: async (sql, args) => {
        updates.push(sql);
        return [{ affectedRows: 1 }];
      },
    },
    "../models/tasksV12": {
      ACTIVE: ["running"],
      parse: (v) => v,
      rawTask: async () => task,
      operations: async () => [],
      getTask: async () => task,
    },
    "../utils/logger": { info() {}, warn() {}, error() {} },
    "./login": { pendingLogins: new Map() },
    "./browser": {},
    "./navigator": {},
    "./recordDriver": {},
    "./schoolSession": {
      getSession: async () => session,
      requireSchoolSession: async () => {},
    },
    "./academicPostcheck": { check: async () => [{ remaining: 1 }] },
    "../utils/week": { withSemester: async (_, fn) => fn() },
  });
  await runner.verify("fixture", "fixture");
  assert.equal(
    updates.some((s) => s.includes("status='completed'")),
    false,
  );
});
test("snapshot and preview scope rejects missing and replaced school connections", async () => {
  const scope = require("../services/connectionScope"),
    connection = { query: async () => [[{ connection_id: "current" }]] };
  await assert.rejects(
    scope.assertCurrent("fixture", {}, connection),
    (e) => e.code === "SCHOOL_ACCOUNT_CHANGED",
  );
  await assert.rejects(
    scope.assertCurrent("fixture", { connectionId: "old" }, connection),
    (e) => e.code === "SCHOOL_ACCOUNT_CHANGED",
  );
  assert.equal(
    await scope.assertCurrent(
      "fixture",
      { connectionId: "current" },
      connection,
    ),
    "current",
  );
});
test("incremental reuse never reuses current, dirty, failed, outdated or explicitly full weeks", () => {
  const { canReuse } = require("../services/overviewFreshness"),
    now = Date.now(),
    good = { readCompletedAt: new Date(now - 60000).toISOString() };
  assert(canReuse(good, 1, { week: 11 }, [], false, now));
  for (const args of [
    [good, 11, { week: 11 }, [], false, now],
    [good, 1, { week: 11 }, [1], false, now],
    [{ ...good, error: "failed" }, 1, { week: 11 }, [], false, now],
    [good, 1, { week: 11 }, [], true, now],
    [
      { readCompletedAt: new Date(now - 7 * 3600000).toISOString() },
      1,
      { week: 11 },
      [],
      false,
      now,
    ],
  ])
    assert.equal(canReuse(...args), false);
});
test("backup rotation keeps distinct days even with many release backups today", () => {
  const { retained } = require("../scripts/backup"),
    files = [];
  for (let d = 1; d <= 14; d++)
    files.push(
      "student-recorder-2026-10-" +
        String(d).padStart(2, "0") +
        "T00-00-00.sql",
    );
  for (let h = 0; h < 20; h++)
    files.push(
      "student-recorder-2026-11-11T" +
        String(h).padStart(2, "0") +
        "-00-00.sql",
    );
  const keep = retained(files);
  assert.equal(new Set([...keep].map((n) => n.slice(17, 27))).size, 14);
  assert(keep.size <= 16);
  assert(keep.has("student-recorder-2026-11-11T19-00-00.sql"));
});
