const { test, after } = require("node:test"),
  assert = require("node:assert/strict");
const sessions = require("../services/schoolSession"),
  inspect = require("../services/retryInspection").inspect,
  academic = require("../services/academicSchool"),
  worklog = require("../services/worklogSchool");
after(() => require("../config/database").end());
const calendar = { startDate: "2026-08-31", week: 11 },
  p = {
    recordedAt: "2026-09-01 09:00:00",
    date: "2026-09-01",
    content: "",
    durationMinutes: 10,
    method: "面对面",
    gzrzid: "w1",
    fromDate: "2026-08-31",
    toDate: "2026-11-01",
    excludeDates: [],
    ranges: [[540, 720]],
    skipRecorded: true,
    targetCount: 1,
  };
const row = (id, type = "talk") => ({
  student_id: id,
  student_name: "测试",
  week: 1,
  type,
  payload: { ...p },
});
test("explicit stage preflight bypasses validation cache and refuses expired school HTML", async () => {
  let calls = 0;
  const session = {
    step: "ready",
    _validatedAt: Date.now(),
    page: {
      isClosed: () => false,
      url: () => "https://xuegong.hitwh.edu.cn/zhxy-xgzs",
      request: {
        post: async () => {
          calls++;
          return {
            ok: () => true,
            json: async () => ({ isSuccess: true, module: [] }),
          };
        },
      },
    },
  };
  await sessions.requireSchoolSession(session);
  assert.equal(calls, 0);
  await sessions.requireSchoolSession(session, { force: true });
  assert.equal(calls, 1);
  session.page.request.post = async () => ({
    ok: () => true,
    json: async () => {
      throw Error("HTML login");
    },
  });
  await assert.rejects(
    sessions.requireSchoolSession(session, { force: true }),
    (e) => e.code === "SCHOOL_AUTH_REQUIRED",
  );
});
test("school outage does not erase retained cookies or extend auth expiry", async () => {
  const expiry = Date.now() + 100000,
    session = {
      step: "ready",
      authExpiresAt: expiry,
      page: {
        isClosed: () => false,
        url: () => "https://xuegong.hitwh.edu.cn/zhxy-xgzs",
        request: {
          post: async () => {
            throw Error("network");
          },
        },
      },
    };
  await assert.rejects(
    sessions.requireSchoolSession(session, { force: true }),
    (e) => e.code === "SCHOOL_UNAVAILABLE",
  );
  assert.equal(session.authExpiresAt, expiry);
  assert.equal(session.step, "ready");
});
test("academic recovery reads own weekly roster and skips records added since interruption", async () => {
  const old = [academic.roster, academic.records];
  let rosters = 0;
  academic.roster = async () => {
    rosters++;
    return {
      gzrzid: "w1",
      editable: true,
      students: [{ studentId: "2022000001" }, { studentId: "2022000002" }],
    };
  };
  academic.records = async (_, info, id) =>
    id === "2022000001" ? [{ id: "existing" }] : [];
  try {
    const plan = {
      id: "fixture",
      calendar,
      request: { scope: "academic" },
      operations: [],
    };
    await inspect({}, plan, [
      row("2022000001"),
      row("2022000002"),
      row("2023000001"),
    ]);
    assert.deepEqual(
      plan.operations.map((o) => o.status),
      ["skipped", "planned", "not_applicable"],
    );
    assert.equal(rosters, 1);
    assert.equal(plan.operations[1].payload.recordedAt, p.recordedAt);
    assert.equal(plan.processed, 3);
  } finally {
    [academic.roster, academic.records] = old;
  }
});
test("worklog recovery uses semester counts and never borrows academic membership", async () => {
  const old = worklog.readSnapshot;
  worklog.readSnapshot = async () => ({
    students: [
      { studentId: "2022000001", hasContact: true },
      { studentId: "2022000002", hasContact: true },
    ],
    days: [{ date: p.date, gzrzid: "w1", editable: true }],
    records: [
      {
        xh: "2022000001",
        thsj: "2026-09-02 10:00:00",
        thsc: 10,
        thfs: "1",
        bz: "",
      },
    ],
  });
  try {
    const plan = { id: "fixture", calendar, request: {}, operations: [] };
    await inspect({}, plan, [
      row("2022000001", "worklog-talk"),
      row("2022000002", "worklog-talk"),
      row("2023000001", "worklog-talk"),
    ]);
    assert.deepEqual(
      plan.operations.map((o) => o.status),
      ["skipped", "planned", "not_applicable"],
    );
  } finally {
    worklog.readSnapshot = old;
  }
});
test("recovery read failure and cancellation never turn unread records into planned operations", async () => {
  const old = academic.roster;
  academic.roster = async () => {
    throw Error("school read unavailable");
  };
  try {
    const plan = {
      id: "fixture",
      calendar,
      request: { scope: "academic" },
      operations: [],
    };
    await assert.rejects(inspect({}, plan, [row("2022000001")]), /unavailable/);
    assert.equal(plan.operations.length, 0);
    await assert.rejects(
      inspect({}, plan, [row("2022000001")], { cancelled: () => true }),
      (e) => e.code === "SCAN_CANCELLED",
    );
    assert.equal(plan.operations.length, 0);
  } finally {
    academic.roster = old;
  }
});

test("cancelling during the last progress update cannot produce a ready retry", async () => {
  const old = [academic.roster, academic.records];
  academic.roster = async () => ({
    gzrzid: "w1",
    editable: true,
    students: [{ studentId: "2022000001" }],
  });
  academic.records = async () => [];
  let cancelled = false;
  try {
    await assert.rejects(
      inspect(
        {},
        {
          id: "fixture",
          calendar,
          request: { scope: "academic" },
          operations: [],
        },
        [row("2022000001")],
        {
          cancelled: () => cancelled,
          onProgress: async () => {
            cancelled = true;
          },
        },
      ),
      (e) => e.code === "SCAN_CANCELLED",
    );
  } finally {
    [academic.roster, academic.records] = old;
  }
});
