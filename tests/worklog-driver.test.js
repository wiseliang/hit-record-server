const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  school = require("../services/worklogSchool"),
  driver = require("../services/worklogDriver");
const id = "2025000001",
  day = { date: "2026-09-01", week: 1, gzrzid: "owned-week", editable: true },
  base = {
    studentId: id,
    week: 1,
    type: "worklog-talk",
    payload: {
      recordedAt: "2026-09-01 09:10:00",
      date: day.date,
      gzrzid: day.gzrzid,
      content: "实际内容",
      durationMinutes: 10,
      method: "面对面",
      skipRecorded: true,
      targetCount: 1,
      ranges: [
        [540, 720],
        [840, 1020],
      ],
      fromDate: "2026-08-31",
      toDate: "2026-11-10",
      excludeDates: [],
    },
  },
  state = () => ({
    calendar: { startDate: "2026-08-31" },
    students: [{ studentId: id }],
    records: [],
  });
async function mocked(rows, fn, editDay = day) {
  const oldWeek = school.weekInfo,
    oldRecords = school.dayRecords;
  school.weekInfo = async () => ({ days: [editDay] });
  school.dayRecords = async () => rows;
  try {
    return await fn();
  } finally {
    school.weekInfo = oldWeek;
    school.dayRecords = oldRecords;
  }
}
test("a late external record refresh rejects dense times and locked work-log days before save", async () => {
  const rows = ["09:00", "09:05"].map((t, i) => ({
    id: String(i),
    xh: "202500009" + i,
    thsj: "2026-09-01 " + t,
    thsc: 10,
    bz: "other",
    thfs: "1",
  }));
  await mocked(rows, () =>
    assert.rejects(
      driver.currentCheck({}, base, state()),
      (e) => e.code === "DENSITY_LIMIT",
    ),
  );
  await mocked(
    [],
    () =>
      assert.rejects(
        driver.currentCheck({}, base, state()),
        (e) => e.code === "WORKLOG_LOCKED",
      ),
    { ...day, editable: false },
  );
});
test("duplicate native records and newly completed semester targets are skipped", async () => {
  await mocked(
    [
      {
        id: "receipt",
        xh: id,
        thsj: base.payload.recordedAt,
        thsc: 10,
        bz: "实际内容",
        thfs: "1",
      },
    ],
    async () => {
      const r = await driver.currentCheck({}, base, state());
      assert.equal(r.skip.status, "skipped");
      assert.equal(r.skip.receipt.schoolRecordId, "receipt");
    },
  );
  const s = state();
  s.records = [
    { id: "elsewhere", xh: id, thsj: "2026-09-02 09:00:00", thsc: 10 },
  ];
  await mocked([], async () => {
    const r = await driver.currentCheck({}, base, s);
    assert.equal(r.skip.status, "skipped");
    assert.match(r.skip.reason, /达到目标/);
  });
});
test("students outside the refreshed owned roster are never substituted", async () => {
  await assert.rejects(
    driver.currentCheck({}, base, { ...state(), students: [] }),
    (e) => e.code === "STUDENT_NOT_OWNED",
  );
});
