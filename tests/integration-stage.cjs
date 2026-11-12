const { test, after, before } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("crypto");
if (!/_(stage|test)$/.test(process.env.DB_NAME || ""))
  throw Error("Integration tests require a dedicated _stage or _test database");
const pool = require("../config/database"),
  model = require("../models/tasksV12"),
  identity = require("../services/identity"),
  token = require("../utils/session"),
  planner = require("../services/planner"),
  runner = require("../services/taskRunner");
const actor = "test_" + crypto.randomUUID(),
  other = actor + "_other";
let server, base, currentToken;
const schoolPage = () => ({
  isClosed: () => false,
  url: () => "https://xuegong.hitwh.edu.cn/zhxy-xgzs",
  request: {
    post: async () => ({
      ok: () => true,
      json: async () => ({ isSuccess: true, module: [] }),
    }),
  },
});
const calendar = {
  verified: true,
  checkedAt: new Date().toISOString(),
  startDate: "2026-08-31",
  academicYear: "2026—2027",
  semester: "秋季",
  week: 11,
};
const request = {
  recordType: "talk",
  mode: "record",
  weeks: [1],
  studentIds: ["2022000001"],
  schedule: { 1: "2026-08-31 09:00:00" },
  content: "隔离验证",
  calendarStartDate: "2026-08-31",
  durationMinutes: 30,
  method: "面对面",
  scene: "走访寝室",
};
async function fixtureConnection() {
  const current = await require("../services/connectionScope").current(actor);
  return current || (await overviewConnection());
}
async function scoped(value) {
  return JSON.stringify({ ...value, connectionId: await fixtureConnection() });
}
async function plan(operations) {
  const id = crypto.randomUUID(),
    p = {
      state: "ready",
      request,
      calendar,
      operations: operations || [
        {
          studentId: "2022000001",
          studentName: "同名学生",
          week: 1,
          type: "talk",
          status: "planned",
          payload: { ...request, recordedAt: "2026/08/31 09:00:00" },
        },
      ],
    };
  await pool.query(
    "INSERT INTO task_plans(id,openid,body_hash,payload,expires_at) VALUES (?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))",
    [id, actor, model.hash(p), await scoped(p)],
  );
  return id;
}
before(async () => {
  await require("../scripts/migrate-v12").migrate();
  const app = require("../app");
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  const [tasks] = await pool.query(
    "SELECT task_uuid FROM tasks WHERE openid IN (?,?)",
    [actor, other],
  );
  for (const t of tasks)
    await pool.query("DELETE FROM task_operations WHERE task_uuid=?", [
      t.task_uuid,
    ]);
  for (const table of [
    "content_template_libraries",
    "tasks",
    "task_plans",
    "task_user_locks",
    "credentials",
    "app_sessions",
    "school_account_bindings",
    "app_accounts",
    "worklog_snapshots",
    "academic_snapshots",
    "overview_snapshots",
    "school_login_sessions",
  ])
    await pool.query("DELETE FROM " + table + " WHERE openid IN (?,?)", [
      actor,
      other,
    ]);
  await pool.end();
});
const http = async (
  path,
  {
    method = "GET",
    body,
    bearer = currentToken || token.issueToken(actor),
  } = {},
) => {
  const r = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
test("HTTP rejects forged identities, preserves owner isolation and returns JSON for missing routes", async () => {
  assert.equal(
    (await http("/api/task/active", { bearer: "forged" })).status,
    401,
  );
  assert.equal(
    (
      await http("/api/task/create", {
        method: "POST",
        body: { openid: other },
      })
    ).status,
    403,
  );
  assert.equal((await http("/api/task/not-my-task")).status, 404);
  assert.equal((await http("/api/not-found")).body.code, "NOT_FOUND");
  assert.equal(
    (await http("/api/health", { bearer: null })).body.version,
    require("../package.json").version,
  );
});
test("recovery restores original identity and revokes previous access", async () => {
  const first = await identity.openSession(actor),
    sid = token.tokenClaims(first.token).sid;
  assert.ok(await identity.validSession(sid, actor));
  const recovered = await identity.recover(first.recoveryKey);
  assert.equal(recovered.openid, actor);
  currentToken = recovered.token;
  assert.equal(
    (
      await http("/api/auth/login", {
        method: "POST",
        body: { platform: "android" },
        bearer: first.token,
      })
    ).status,
    401,
  );
  assert.equal(
    (await http("/api/history", { bearer: token.issueToken(actor) })).status,
    401,
  );
  assert.equal(await identity.validSession(sid, actor), false);
  assert.equal(
    (await http("/api/history", { bearer: first.token })).status,
    401,
  );
  await assert.rejects(
    identity.recover("REC-" + "0".repeat(48)),
    (e) => e.code === "INVALID_RECOVERY",
  );
});
test("refresh tolerates response loss without rotating into inaccessible identity", async () => {
  const first = await identity.openSession(actor),
    second = await identity.refresh(first.refreshToken),
    retry = await identity.refresh(first.refreshToken);
  assert.equal(second.refreshToken, retry.refreshToken);
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.equal(retry.openid, actor);
  await pool.query(
    "UPDATE app_sessions SET previous_valid_until=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE id=?",
    [token.tokenClaims(second.token).sid],
  );
  await assert.rejects(
    identity.refresh(first.refreshToken),
    (e) => e.status === 401,
  );
});
test("credential deletion removes encrypted server data but retains identity/history", async () => {
  await require("../models/credential").saveCredential(
    actor,
    "20220006",
    "  password with spaces  ",
  );
  assert.equal(
    (await require("../models/credential").getCredential(actor)).password,
    "  password with spaces  ",
  );
  assert.equal(
    (await http("/api/auth/credential", { method: "DELETE" })).status,
    200,
  );
  assert.equal(
    await require("../models/credential").hasCredential(actor),
    false,
  );
  const [rows] = await pool.query(
    "SELECT openid FROM app_accounts WHERE openid=?",
    [actor],
  );
  assert.equal(rows.length, 1);
});
let uuid;
test("concurrent duplicate create produces exactly one task and one operation", async () => {
  const p = await plan(),
    results = await Promise.all(
      Array.from({ length: 8 }, () =>
        model.createFromPlan(actor, p, "request-1"),
      ),
    );
  assert.equal(new Set(results.map((x) => x.taskUuid)).size, 1);
  uuid = results[0].taskUuid;
  assert.equal((await model.operations(uuid)).length, 1);
  const p2 = await plan();
  await assert.rejects(
    model.createFromPlan(actor, p2, "request-2"),
    (e) => e.code === "TASK_ACTIVE",
  );
  await assert.rejects(
    model.createFromPlan(actor, p2, "request-1"),
    (e) => e.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(
    (await http("/api/task/" + uuid, { bearer: token.issueToken(other) }))
      .status,
    404,
  );
  assert.equal(
    (await http("/api/auth/credential", { method: "DELETE" })).status,
    409,
  );
});
test("terminal resume/cancel is rejected and receipt survives restart recovery", async () => {
  const [op] = await model.operations(uuid);
  await model.setOperation(op.id, "succeeded", {
    schoolRecordId: "isolated-school-receipt",
    verified: true,
  });
  await model.recoverOrphans();
  const t = await model.getTask(uuid, actor);
  assert.equal(t.status, "interrupted");
  assert.equal(t.details[0].receipt.schoolRecordId, "isolated-school-receipt");
  for (const action of ["resume", "cancel"])
    await assert.rejects(
      runner.control(uuid, actor, action),
      (e) => e.code === "INVALID_TASK_STATE",
    );
  assert.equal(await model.active(actor), null);
});
test("interrupted in-flight operations stay uncertain and are never automatically retried", async () => {
  const p = await plan(),
    r = await model.createFromPlan(actor, p, "request-3"),
    [op] = await model.operations(r.taskUuid);
  await model.setOperation(op.id, "in_progress");
  await model.recoverOrphans();
  assert.equal((await model.operations(r.taskUuid))[0].status, "unconfirmed");
  await assert.rejects(
    planner.retryPlan(r.taskUuid, actor),
    (e) => e.code === "NO_RETRYABLE_ITEMS",
  );
});
test("preview rejects guessed record types, stale calendars and invalid selections", () => {
  require("../utils/week").withSemester(calendar, () => {
    assert.equal(planner.validate(request, calendar).recordType, "talk");
    for (const patch of [
      { recordType: "batch" },
      { calendarStartDate: "2026-03-09" },
      { weeks: [0] },
      { studentIds: [] },
      { schedule: {} },
      { durationMinutes: 0 },
    ])
      assert.throws(() => planner.validate({ ...request, ...patch }, calendar));
  });
});
test("read-only calendar rejects client writes and history paginates without week zero", async () => {
  assert.equal(
    (
      await http("/api/week/set-start-date", {
        method: "POST",
        body: { date: "2000-01-03" },
      })
    ).status,
    410,
  );
  const r = await http("/api/history?pageSize=1&page=1");
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.hasMore, true);
  assert.deepEqual(r.body.items[0].weeks, [1]);
  const next = await http("/api/history?pageSize=1&page=2");
  assert.notEqual(next.body.items[0].taskUuid, r.body.items[0].taskUuid);
});

test("worker settles navigation failure without losing already saved receipt", async () => {
  const p = await plan([
    {
      studentId: "2022000001",
      studentName: "同名",
      week: 1,
      type: "talk",
      status: "succeeded",
      payload: { recordedAt: "2026/08/31 09:00:00" },
    },
    {
      studentId: "2022000002",
      studentName: "同名",
      week: 1,
      type: "talk",
      status: "planned",
      payload: { recordedAt: "2026/08/31 09:00:00" },
    },
  ]);
  const r = await model.createFromPlan(actor, p, "worker-failure"),
    [op] = await model.operations(r.taskUuid);
  await model.setOperation(op.id, "succeeded", {
    schoolRecordId: "survives-navigation-failure",
  });
  const nav = require("../services/navigator"),
    original = nav.navigateAndQuery;
  nav.navigateAndQuery = async () => {
    throw Error("隔离模拟：学校连接失败");
  };
  try {
    runner.enqueue(r.taskUuid, actor, {
      page: { isClosed: () => false },
      slot: {},
      step: "ready",
    });
    for (let i = 0; i < 100; i++) {
      const t = await model.getTask(r.taskUuid, actor);
      if (t.status === "interrupted") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const t = await model.getTask(r.taskUuid, actor);
    assert.equal(t.status, "interrupted");
    assert.equal(
      t.details.find((x) => x.studentId === "2022000001").receipt
        .schoolRecordId,
      "survives-navigation-failure",
    );
    assert.equal(
      t.details.find((x) => x.studentId === "2022000002").status,
      "planned",
    );
    assert.equal(await model.active(actor), null);
  } finally {
    nav.navigateAndQuery = original;
    require("../services/login").pendingLogins.delete(actor);
  }
});
test("pause is acknowledged at save boundary and cancellation preserves first receipt", async () => {
  const p = await plan(
      ["2022000001", "2022000002"].map((studentId) => ({
        studentId,
        studentName: "同名",
        week: 1,
        type: "talk",
        status: "planned",
        payload: { recordedAt: "2026/08/31 09:00:00" },
      })),
    ),
    r = await model.createFromPlan(actor, p, "pause-cancel-boundary");
  const nav = require("../services/navigator"),
    driver = require("../services/recordDriver"),
    oldNav = nav.navigateAndQuery,
    oldSave = driver.saveOperation;
  let firstReady,
    secondReady,
    allowFirst,
    allowSecond,
    calls = 0,
    writes = 0;
  const first = new Promise((resolve) => (firstReady = resolve)),
    second = new Promise((resolve) => (secondReady = resolve)),
    firstGate = new Promise((resolve) => (allowFirst = resolve)),
    secondGate = new Promise((resolve) => (allowSecond = resolve));
  const wait = async (fn) => {
    for (let i = 0; i < 300; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("Worker state transition timed out");
  };
  nav.navigateAndQuery = async () => {};
  driver.saveOperation = async (page, op, beforeSave) => {
    calls++;
    if (calls === 1) {
      firstReady();
      await firstGate;
    } else {
      secondReady();
      await secondGate;
    }
    try {
      await beforeSave();
    } catch (e) {
      if (e.code === "TASK_CANCELLED")
        return { status: "cancelled", reason: "提交前取消" };
      throw e;
    }
    writes++;
    return {
      status: "succeeded",
      receipt: { schoolRecordId: "boundary-" + writes, verified: true },
    };
  };
  try {
    runner.enqueue(r.taskUuid, actor, {
      page: { isClosed: () => false },
      slot: {},
      step: "ready",
    });
    await first;
    assert.equal(
      (await runner.control(r.taskUuid, actor, "pause")).status,
      "pause_requested",
    );
    allowFirst();
    await wait(
      async () => (await model.getTask(r.taskUuid, actor)).status === "paused",
    );
    assert.equal(writes, 0);
    assert.equal(
      (await runner.control(r.taskUuid, actor, "resume")).status,
      "running",
    );
    await second;
    assert.equal(writes, 1);
    assert.equal(
      (await runner.control(r.taskUuid, actor, "cancel")).status,
      "cancel_requested",
    );
    allowSecond();
    await wait(async () => !runner.live.has(r.taskUuid));
    const result = await model.getTask(r.taskUuid, actor);
    assert.equal(result.status, "cancelled");
    assert.equal(result.progress.success, 1);
    assert.equal(
      result.details.filter((d) => d.status === "cancelled").length,
      1,
    );
    assert.equal(
      result.details.find((d) => d.status === "succeeded").receipt
        .schoolRecordId,
      "boundary-1",
    );
  } finally {
    allowFirst();
    allowSecond();
    nav.navigateAndQuery = oldNav;
    driver.saveOperation = oldSave;
    require("../services/login").pendingLogins.delete(actor);
  }
});
test("periodic recovery settles a stale task without a live executor", async () => {
  const p = await plan(),
    r = await model.createFromPlan(actor, p, "reaper-orphan"),
    [op] = await model.operations(r.taskUuid);
  await model.setOperation(op.id, "in_progress");
  await pool.query(
    "UPDATE tasks SET created_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3 MINUTE) WHERE task_uuid=?",
    [r.taskUuid],
  );
  await runner.reapOrphans();
  const result = await model.getTask(r.taskUuid, actor);
  assert.equal(result.status, "interrupted");
  assert.equal(result.details[0].status, "unconfirmed");
  assert.equal(await model.active(actor), null);
});
test("work-log snapshots preserve native counts, hide school notes and enforce ownership", async () => {
  const id = crypto.randomUUID(),
    snapshot = {
      state: "ready",
      calendar,
      students: [
        {
          studentId: "2022000001",
          name: "同名",
          schoolCount: 8,
          semesterCount: 1,
          hasContact: true,
        },
      ],
      days: [],
      records: [
        {
          xh: "2022000001",
          thsj: "2026-08-31 09:00:00",
          bz: "private school note",
        },
      ],
      checkedAt: new Date().toISOString(),
    };
  await pool.query(
    "INSERT INTO worklog_snapshots(id,openid,payload,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 MINUTE))",
    [id, actor, await scoped(snapshot)],
  );
  const r = await http("/api/worklog/scans/" + id);
  assert.equal(r.status, 200);
  assert.equal(r.body.students[0].schoolCount, 8);
  assert.equal(r.body.students[0].semesterCount, 1);
  assert.equal(r.body.records, undefined);
  assert.equal(JSON.stringify(r.body).includes("private school note"), false);
  assert.equal(
    (
      await http("/api/worklog/scans/" + id, {
        bearer: token.issueToken(other),
      })
    ).status,
    404,
  );
  await pool.query(
    "UPDATE worklog_snapshots SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE id=?",
    [id],
  );
  await assert.rejects(
    require("../services/worklogPlanner").rawSnapshot(id, actor),
    (e) => e.code === "SNAPSHOT_EXPIRED",
  );
});
test("work-log submission requires actual-activity confirmation and retains multiple per-student receipts", async () => {
  const p = await plan(
    [1, 2].map((occurrence) => ({
      studentId: "2022000001",
      studentName: "同名",
      week: 1,
      type: "worklog-talk",
      occurrence,
      status: "planned",
      payload: {
        recordedAt:
          "2026-08-31 09:" + String(occurrence * 20).padStart(2, "0") + ":00",
      },
    })),
  );
  const [rows] = await pool.query("SELECT payload FROM task_plans WHERE id=?", [
      p,
    ]),
    payload = model.parse(rows[0].payload);
  payload.request.recordType = "worklog-talk";
  payload.kind = "worklog-talk";
  payload.revision = 1;
  await pool.query("UPDATE task_plans SET payload=? WHERE id=?", [
    await scoped(payload),
    p,
  ]);
  const rejected = await http("/api/task/create", {
    method: "POST",
    body: { planId: p, requestId: p, confirmedActual: false, revision: 1 },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, "ACTUAL_CONFIRMATION_REQUIRED");
  const r = await model.createFromPlan(actor, p, p),
    ops = await model.operations(r.taskUuid);
  assert.equal(ops.length, 2);
  assert.deepEqual(ops.map((o) => o.occurrence).sort(), [1, 2]);
  assert.equal((await model.getTask(r.taskUuid, actor)).type, "worklog-talk");
  await model.recoverOrphans();
});
test("work-log manual edits enforce rolling density, future cutoff and immutable submitted plans", async () => {
  const manager = require("../services/worklogPlanner"),
    id = crypto.randomUUID(),
    snapshot = {
      state: "ready",
      calendar,
      checkedAt: new Date().toISOString(),
      students: ["2022000001", "2022000002", "2022000003"].map((studentId) => ({
        studentId,
        name: "同名",
        schoolCount: 0,
        semesterCount: 0,
        hasContact: true,
      })),
      days: [{ date: "2026-08-31", week: 1, gzrzid: "day-1", editable: true }],
      records: [],
    };
  await pool.query(
    "INSERT INTO worklog_snapshots(id,openid,payload,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 MINUTE))",
    [id, actor, await scoped(snapshot)],
  );
  const pending = require("../services/login").pendingLogins;
  pending.set(actor, { calendar, step: "ready", page: schoolPage() });
  try {
    const p = await manager.preview(actor, {
      snapshotId: id,
      studentIds: snapshot.students.map((s) => s.studentId),
      content: "实际核对内容",
      fromDate: "2026-08-31",
      toDate: "2026-08-31",
    });
    assert.equal(p.summary.planned, 3);
    await assert.rejects(
      manager.review(actor, p.id, {
        revision: 1,
        changes: [0, 1, 2].map((operationIndex) => ({
          operationIndex,
          recordedAt: "2026-08-31 09:00:00",
        })),
      }),
      (e) => e.code === "DENSITY_LIMIT",
    );
    const accepted = await manager.review(actor, p.id, {
      revision: 1,
      changes: [{ operationIndex: 0, recordedAt: "2026-08-31 11:30:00" }],
    });
    assert.equal(accepted.revision, 2);
    await assert.rejects(
      manager.review(actor, p.id, { revision: 1, changes: [] }),
      (e) => e.code === "PLAN_CHANGED",
    );
    const r = await model.createFromPlan(actor, p.id, p.id);
    await assert.rejects(
      manager.review(actor, p.id, { revision: 2, changes: [] }),
      (e) => e.code === "PLAN_ALREADY_USED",
    );
    await model.recoverOrphans();
    assert.equal((await model.getTask(r.taskUuid, actor)).details.length, 3);
  } finally {
    pending.delete(actor);
  }
});

test("school cookies are encrypted, isolated by app owner, expire in 24h and explicit release removes them", async () => {
  const sessions = require("../services/schoolSession"),
    cookie = "private-cookie-" + crypto.randomUUID();
  await sessions.persist(actor, {
    step: "ready",
    calendar,
    page: {
      context: () => ({
        storageState: async () => ({
          cookies: [
            {
              name: "sid",
              value: cookie,
              domain: "xuegong.hitwh.edu.cn",
              path: "/",
            },
          ],
          origins: [],
        }),
      }),
    },
  });
  const [rows] = await pool.query(
    "SELECT state_encrypted,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),expires_at) AS ttl FROM school_login_sessions WHERE openid=?",
    [actor],
  );
  assert.equal(rows.length, 1);
  assert(!rows[0].state_encrypted.includes(cookie));
  assert(rows[0].ttl > 86000 && rows[0].ttl <= 86400);
  assert.equal((await sessions.status(other)).hasActiveSession, false);
  assert.equal((await sessions.status(actor)).resumable, true);
  await pool.query(
    "UPDATE school_login_sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE openid=?",
    [actor],
  );
  assert.equal((await sessions.status(actor)).resumable, false);
  assert.equal(
    (await http("/api/auth/release", { method: "POST" })).status,
    200,
  );
  assert.equal(await sessions.stored(actor), undefined);
  await sessions.persist(
    actor,
    {
      step: "ready",
      calendar,
      page: {
        context: () => ({
          storageState: async () => ({ cookies: [], origins: [] }),
        }),
      },
    },
    { existingOnly: true },
  );
  assert.equal(
    await sessions.stored(actor),
    undefined,
    "late idle or worker updates must not recreate a released session",
  );
});
test("academic snapshots cannot be opened across owners and reject work-log IDs before any write", async () => {
  const id = crypto.randomUUID(),
    snap = {
      scope: "academic",
      state: "ready",
      ruleVersion: 2,
      calendar,
      weeks: [1],
      entry: "automatic",
      students: [{ studentId: "2022000001", name: "学情学生", weeks: [1] }],
      weekRosters: [{ week: 1, students: [{ studentId: "2022000001" }] }],
    };
  await pool.query(
    "INSERT INTO academic_snapshots(id,openid,payload,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))",
    [id, actor, await scoped(snap)],
  );
  const academic = require("../services/academicPlanner");
  await assert.rejects(
    () => academic.snapshot(id, other),
    (e) => e.code === "ACADEMIC_SNAPSHOT_NOT_FOUND",
  );
  const sessions = require("../services/schoolSession"),
    old = sessions.getSession;
  sessions.getSession = async () => ({
    step: "ready",
    calendar,
    page: schoolPage(),
  });
  try {
    await assert.rejects(
      () =>
        academic.preview(actor, {
          snapshotId: id,
          studentIds: ["2023000001"],
          content: "",
        }),
      (e) => e.code === "ACADEMIC_STUDENT_NOT_OWNED",
    );
  } finally {
    sessions.getSession = old;
  }
});

test("academic preview edits enforce selected week, existing density, blank note and immutable submitted revisions", async () => {
  const s = require("../services/worklogSchedule"),
    academic = require("../services/academicPlanner"),
    id = crypto.randomUUID(),
    options = s.normalize(
      { studentIds: ["2022000001"], content: "" },
      calendar,
    ),
    p = {
      state: "ready",
      request: {
        ...options,
        scope: "academic",
        entry: "talk",
        recordType: "talk",
        weeks: [1],
      },
      calendar,
      revision: 1,
      existingTimes: [
        s.stamp("2026-08-31 09:00:00"),
        s.stamp("2026-08-31 09:01:00"),
      ],
      operations: [
        {
          studentId: "2022000001",
          studentName: "学情学生",
          week: 1,
          type: "talk",
          status: "planned",
          payload: {
            ...options,
            scope: "academic",
            gzrzid: "w1",
            recordedAt: "2026-08-31 10:00:00",
          },
        },
      ],
    };
  await pool.query(
    "INSERT INTO task_plans(id,openid,body_hash,payload,expires_at) VALUES (?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))",
    [id, actor, model.hash(p), await scoped(p)],
  );
  const change = (recordedAt, content = "") => ({
    revision: 1,
    changes: [{ operationIndex: 0, recordedAt, content }],
  });
  await assert.rejects(
    () => academic.review(actor, id, change("2026-08-31 09:02:00")),
    (e) => e.code === "DENSITY_LIMIT",
  );
  await assert.rejects(
    () => academic.review(actor, id, change("2026-09-07 10:00:00")),
    (e) => e.code === "INVALID_WEEK_DATE",
  );
  await assert.rejects(
    () => academic.review(actor, id, change("invalid")),
    (e) => e.code === "INVALID_DATE",
  );
  const revised = await academic.review(
    actor,
    id,
    change("2026-08-31 10:30:00"),
  );
  assert.equal(revised.revision, 2);
  assert.equal(revised.operations[0].payload.content, "");
  await assert.rejects(
    () => academic.review(actor, id, change("2026-08-31 10:40:00")),
    (e) => e.code === "PLAN_CHANGED",
  );
  await pool.query(
    "UPDATE task_plans SET payload=JSON_SET(payload,'$.state','scanning') WHERE id=?",
    [id],
  );
  await assert.rejects(
    () => academic.review(actor, id, { revision: 2, changes: [] }),
    (e) => e.code === "PLAN_CHANGED",
  );
});

test("SIGTERM shuts down cleanly with numeric exit status", async () => {
  const { spawn } = require("node:child_process"),
    child = spawn(
      process.execPath,
      [
        "-e",
        "require('./app').start().then(()=>setTimeout(()=>process.kill(process.pid,'SIGTERM'),50)).catch(()=>process.exit(2))",
      ],
      {
        cwd: require("node:path").resolve(__dirname, ".."),
        env: { ...process.env, PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, log);
    assert(!log.includes("uncaughtException"));
  } finally {
    clearTimeout(timer);
  }
});

test("release page serves illustrated instructions and APK downloads support range without exposing private data", async () => {
  const fs = require("node:fs"),
    path = require("node:path"),
    os = require("node:os"),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-download-")),
    old = process.env.RELEASE_DOWNLOAD_DIR;
  process.env.RELEASE_DOWNLOAD_DIR = dir;
  try {
    const manifest = require("../public/releases/release.json"),
      data = Buffer.from("isolated-apk-download-fixture");
    fs.writeFileSync(path.join(dir, manifest.file), data);
    const redirect = await fetch(base + "/releases", { redirect: "manual" });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "releases/");
    const page = await fetch(base + "/releases/");
    assert.equal(page.status, 200);
    assert((await page.text()).includes("先连接学校"));
    const image = await fetch(base + "/releases/images/home.png");
    assert.equal(image.status, 200);
    const download = await fetch(base + "/downloads/latest.apk");
    assert.equal(download.status, 200);
    assert(
      download.headers.get("content-type").includes("android.package-archive"),
    );
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), data);
    const partial = await fetch(base + "/downloads/" + manifest.file, {
      headers: { Range: "bytes=0-3" },
    });
    assert.equal(partial.status, 206);
    assert.equal(Buffer.from(await partial.arrayBuffer()).toString(), "isol");
    assert.equal((await fetch(base + "/downloads/.env")).status, 404);
    assert.equal((await fetch(base + "/releases/../.env")).status, 404);
  } finally {
    if (old === undefined) delete process.env.RELEASE_DOWNLOAD_DIR;
    else process.env.RELEASE_DOWNLOAD_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("all-existing preview completes atomically without acquiring a school session or queueing writes", async () => {
  const id = await plan([
    {
      studentId: "2022000001",
      studentName: "示例",
      week: 1,
      type: "talk",
      status: "skipped",
      reason: "该周已有记录",
      payload: { recordedAt: "2026-08-31 09:00:00" },
    },
  ]);
  const sessions = require("../services/schoolSession"),
    old = sessions.getSession;
  sessions.getSession = async () => {
    throw Error("must not acquire school session");
  };
  try {
    const r = await http("/api/task/create", {
      method: "POST",
      body: { planId: id, requestId: id },
    });
    assert.equal(r.status, 202);
    const task = await model.getTask(r.body.taskUuid, actor);
    assert.equal(task.status, "completed");
    assert.equal(task.progress.skipped, 1);
    assert.equal(await model.active(actor), null);
    assert(!runner.queue.some((q) => q.uuid === r.body.taskUuid));
    const again = await http("/api/task/create", {
      method: "POST",
      body: { planId: id, requestId: id },
    });
    assert.equal(again.body.taskUuid, r.body.taskUuid);
  } finally {
    sessions.getSession = old;
  }
});
test("progress summary equals full counts, omits details and enforces ownership", async () => {
  const [rows] = await pool.query(
    "SELECT task_uuid FROM tasks WHERE openid=? ORDER BY id DESC LIMIT 1",
    [actor],
  );
  const uuid = rows[0].task_uuid,
    full = await model.getTask(uuid, actor),
    r = await http("/api/task/" + uuid + "?summary=1");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.progress, full.progress);
  assert.equal(r.body.detailsCount, full.details.length);
  assert.equal(r.body.details, undefined);
  assert.equal(
    (
      await http("/api/task/" + uuid + "?summary=1", {
        bearer: token.issueToken(other),
      })
    ).status,
    404,
  );
});

test("242-item progress summary preserves result counts with much smaller payload", async () => {
  const id = await plan(
      Array.from({ length: 242 }, (_, i) => ({
        studentId: String(2025000000 + i),
        studentName: "测试学生",
        week: 1,
        type: "talk",
        status: "skipped",
        reason: "本周已有谈话",
        payload: { recordedAt: "2026-08-31 09:00:00" },
      })),
    ),
    r = await model.createFromPlan(actor, id, id),
    full = await model.getTask(r.taskUuid, actor),
    summary = await model.getTask(r.taskUuid, actor, { summary: true });
  assert.deepEqual(summary.progress, full.progress);
  assert.equal(summary.detailsCount, 242);
  assert(
    Buffer.byteLength(JSON.stringify(summary)) <
      Buffer.byteLength(JSON.stringify(full)) / 10,
  );
});

test("academic worker checks once at save boundary and executes by actual date without changing payloads", async () => {
  const id = await plan([
    {
      studentId: "2022000001",
      studentName: "甲",
      week: 1,
      type: "talk",
      status: "planned",
      payload: { recordedAt: "2026-09-02 09:00:00" },
    },
    {
      studentId: "2022000002",
      studentName: "乙",
      week: 1,
      type: "talk",
      status: "planned",
      payload: { recordedAt: "2026-09-01 09:00:00" },
    },
  ]);
  const [row] = await pool.query("SELECT payload FROM task_plans WHERE id=?", [
      id,
    ]),
    p = model.parse(row[0].payload);
  p.request.scope = "academic";
  await pool.query("UPDATE task_plans SET payload=? WHERE id=?", [
    await scoped(p),
    id,
  ]);
  const nav = require("../services/navigator"),
    driver = require("../services/recordDriver"),
    guard = require("../services/academicGuard"),
    cal = require("../services/academicCalendar"),
    old = [
      nav.navigateAndQuery,
      driver.saveOperation,
      guard.check,
      cal.syncSchoolCalendar,
    ],
    order = [];
  let checks = 0;
  nav.navigateAndQuery = async () => {};
  guard.check = async () => {
    checks++;
    return { skip: false };
  };
  cal.syncSchoolCalendar = async () => calendar;
  driver.saveOperation = async (_, op, before) => {
    const gate = await before();
    if (gate) return gate;
    order.push(op.payload.recordedAt);
    return { status: "succeeded", receipt: { verified: true } };
  };
  try {
    const created = await model.createFromPlan(actor, id, id);
    runner.enqueue(created.taskUuid, actor, {
      step: "ready",
      calendar,
      page: { isClosed: () => false },
    });
    let task;
    for (let i = 0; i < 100; i++) {
      task = await model.getTask(created.taskUuid, actor);
      if (!model.ACTIVE.includes(task.status)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(task.status, "completed");
    assert.equal(checks, 2);
    assert.deepEqual(order, ["2026-09-01 09:00:00", "2026-09-02 09:00:00"]);
  } finally {
    [
      nav.navigateAndQuery,
      driver.saveOperation,
      guard.check,
      cal.syncSchoolCalendar,
    ] = old;
    require("../services/login").pendingLogins.delete(actor);
  }
});

test("uncertain worklog receipt holds related goals while unrelated students continue", async () => {
  const ops = [
      { studentId: "2022000001", occurrence: 1, time: "09:00" },
      { studentId: "2022000001", occurrence: 2, time: "09:20" },
      { studentId: "2022000002", occurrence: 1, time: "09:40" },
    ].map((o) => ({
      studentId: o.studentId,
      studentName: "示例",
      week: 1,
      type: "worklog-talk",
      occurrence: o.occurrence,
      status: "planned",
      payload: { recordedAt: "2026-09-01 " + o.time + ":00" },
    })),
    id = await plan(ops),
    [rows] = await pool.query("SELECT payload FROM task_plans WHERE id=?", [
      id,
    ]),
    p = model.parse(rows[0].payload);
  p.request.recordType = "worklog-talk";
  await pool.query("UPDATE task_plans SET payload=? WHERE id=?", [
    await scoped(p),
    id,
  ]);
  const school = require("../services/worklogSchool"),
    driver = require("../services/worklogDriver"),
    cal = require("../services/academicCalendar"),
    old = [school.readSnapshot, driver.saveOperation, cal.syncSchoolCalendar],
    saved = [];
  school.readSnapshot = async () => ({ calendar, students: [], records: [] });
  cal.syncSchoolCalendar = async () => calendar;
  driver.saveOperation = async (_, op, before) => {
    await before();
    saved.push(op.studentId);
    return op.studentId === "2022000001"
      ? { status: "unconfirmed", reason: "回执不确定" }
      : { status: "succeeded", receipt: { verified: true } };
  };
  try {
    const r = await model.createFromPlan(actor, id, id);
    runner.enqueue(r.taskUuid, actor, {
      step: "ready",
      calendar,
      page: { isClosed: () => false },
    });
    let t;
    for (let i = 0; i < 150; i++) {
      t = await model.getTask(r.taskUuid, actor);
      if (!model.ACTIVE.includes(t.status) && !runner.live.has(r.taskUuid))
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(t.status, "partial_failed");
    assert.equal(t.progress.unconfirmed, 1);
    assert.deepEqual(saved, ["2022000001", "2022000002"]);
    assert.equal(t.details.filter((o) => o.status === "cancelled").length, 1);
  } finally {
    [school.readSnapshot, driver.saveOperation, cal.syncSchoolCalendar] = old;
    require("../services/login").pendingLogins.delete(actor);
  }
});

async function interruptedFixture(id) {
  const [rows] = await pool.query("SELECT payload FROM task_plans WHERE id=?", [
      id,
    ]),
    p = model.parse(rows[0].payload),
    desired = p.operations.map((o) => ({ ...o }));
  p.operations = p.operations.map((o) => ({ ...o, status: "planned" }));
  await pool.query("UPDATE task_plans SET payload=? WHERE id=?", [
    await scoped(p),
    id,
  ]);
  const r = await model.createFromPlan(actor, id, id);
  for (const row of await model.operations(r.taskUuid)) {
    const op = desired.find(
      (o) =>
        o.studentId === row.student_id &&
        (o.occurrence || 1) === row.occurrence,
    );
    await model.setOperation(row.id, op.status);
  }
  return r;
}
test("retry rechecks school data asynchronously, holds related uncertain goals and never creates writes", async () => {
  const ids = ["2022000001", "2022000002", "2022000003"],
    payload = {
      recordedAt: "2026-09-01 09:00:00",
      date: "2026-09-01",
      gzrzid: "d1",
      content: "",
      durationMinutes: 10,
      method: "面对面",
      skipRecorded: true,
      targetCount: 1,
      fromDate: "2026-08-31",
      toDate: "2026-11-01",
      excludeDates: [],
      ranges: [[540, 720]],
    },
    ops = [
      { studentId: ids[0], status: "unconfirmed", occurrence: 1 },
      { studentId: ids[0], status: "cancelled", occurrence: 2 },
      { studentId: ids[1], status: "failed" },
      { studentId: ids[2], status: "failed" },
    ].map((o) => ({
      ...o,
      studentName: "示例",
      week: 1,
      type: "worklog-talk",
      payload,
    }));
  const id = await plan(ops),
    [rows] = await pool.query("SELECT payload FROM task_plans WHERE id=?", [
      id,
    ]),
    p = model.parse(rows[0].payload);
  p.request.recordType = "worklog-talk";
  await pool.query("UPDATE task_plans SET payload=? WHERE id=?", [
    await scoped(p),
    id,
  ]);
  const created = await interruptedFixture(id);
  await runner.finish(created.taskUuid, "interrupted");
  await model.releaseLock(actor, created.taskUuid);
  const sessions = require("../services/schoolSession"),
    school = require("../services/worklogSchool"),
    old = [sessions.getSession, school.readSnapshot, runner.verify],
    session = {
      step: "ready",
      calendar,
      connectionId: await fixtureConnection(),
      page: schoolPage(),
    };
  let verifies = 0,
    reads = 0;
  sessions.getSession = async () => session;
  runner.verify = async () => {
    verifies++;
    return model.getTask(created.taskUuid, actor);
  };
  school.readSnapshot = async () => {
    reads++;
    return {
      students: ids.map((studentId) => ({ studentId, hasContact: true })),
      days: [{ date: payload.date, gzrzid: "d1", editable: true }],
      records: [
        { xh: ids[2], thsj: payload.recordedAt, thsc: 10, thfs: "1", bz: "" },
      ],
    };
  };
  try {
    await assert.rejects(
      planner.retryPlan(created.taskUuid, other),
      (e) => e.code === "TASK_NOT_FOUND",
    );
    assert.equal(verifies, 0);
    const retry = await planner.retryPlan(created.taskUuid, actor);
    let ready;
    for (let i = 0; i < 100; i++) {
      ready = await planner.getPlan(retry.id, actor);
      if (ready.state !== "scanning") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(ready.state, "ready");
    assert.equal(verifies, 1);
    assert.equal(reads, 1);
    assert.deepEqual(
      ready.operations.map((o) => [o.studentId, o.status]),
      [
        [ids[1], "planned"],
        [ids[2], "skipped"],
      ],
    );
    assert.equal(ready.operations[0].payload.recordedAt, payload.recordedAt);
    assert.equal(ready.request.retryOf, created.taskUuid);
    assert.equal(session.busyPlan, null);
    assert.equal(await model.active(actor), null);
    assert.equal(
      (await model.getTask(created.taskUuid, actor)).progress.unconfirmed,
      1,
    );
  } finally {
    [sessions.getSession, school.readSnapshot, runner.verify] = old;
  }
});
test("full and lightweight results separate existing records from unarranged and unexecuted work", async () => {
  const id = await plan(
      [
        "succeeded",
        "skipped",
        "not_applicable",
        "failed",
        "unconfirmed",
        "cancelled",
        "planned",
      ].map((status, i) => ({
        studentId: "20220000" + String(i + 11),
        studentName: "示例",
        week: 1,
        type: "talk",
        status,
        payload: { recordedAt: "2026-09-01 09:00:00" },
      })),
    ),
    r = await interruptedFixture(id);
  try {
    const full = await model.getTask(r.taskUuid, actor),
      summary = await model.getTask(r.taskUuid, actor, { summary: true });
    assert.deepEqual(summary.progress, full.progress);
    assert.equal(summary.progress.existing, 1);
    assert.equal(summary.progress.notApplicable, 1);
    assert.equal(summary.progress.notExecuted, 2);
    assert.equal(summary.progress.unconfirmed, 1);
  } finally {
    await runner.finish(r.taskUuid, "cancelled");
    await model.releaseLock(actor, r.taskUuid);
  }
});
test("uncertain worklog receipt verification resolves a unique school record without any save", async () => {
  const payload = {
      recordedAt: "2026-09-01 09:00:00",
      date: "2026-09-01",
      gzrzid: "d1",
      content: "",
      durationMinutes: 10,
      method: "面对面",
    },
    id = await plan([
      {
        studentId: "2022000001",
        studentName: "示例",
        week: 1,
        type: "worklog-talk",
        status: "unconfirmed",
        payload,
      },
    ]),
    r = await interruptedFixture(id);
  await runner.finish(r.taskUuid, "interrupted");
  await model.releaseLock(actor, r.taskUuid);
  const sessions = require("../services/schoolSession"),
    school = require("../services/worklogSchool"),
    old = [sessions.getSession, school.dayRecords];
  let reads = 0;
  sessions.getSession = async () => ({
    step: "ready",
    calendar,
    page: schoolPage(),
  });
  school.dayRecords = async () => {
    reads++;
    return [
      {
        id: "unique-read-only-receipt",
        xh: "2022000001",
        thsj: payload.recordedAt,
        thsc: 10,
        thfs: "1",
        bz: "",
      },
    ];
  };
  try {
    const verified = await runner.verify(r.taskUuid, actor);
    assert.equal(reads, 1);
    assert.equal(verified.details[0].status, "succeeded");
    assert.equal(
      verified.details[0].receipt.schoolRecordId,
      "unique-read-only-receipt",
    );
    assert.equal(verified.progress.unconfirmed, 0);
  } finally {
    [sessions.getSession, school.dayRecords] = old;
  }
});

async function overviewConnection() {
  const connectionId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO school_login_sessions(openid,state_encrypted,calendar,profile,expires_at,connection_id) VALUES (?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 DAY),?) ON DUPLICATE KEY UPDATE calendar=VALUES(calendar),connection_id=VALUES(connection_id),expires_at=VALUES(expires_at)",
    [actor, "fixture-only", JSON.stringify(calendar), "测试学校", connectionId],
  );
  return connectionId;
}
async function overviewFixture(kind, payload) {
  const connectionId = await overviewConnection(),
    id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO overview_snapshots(id,openid,connection_id,kind,payload,expires_at) VALUES (?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 DAY))",
    [
      id,
      actor,
      connectionId,
      kind,
      JSON.stringify({
        id,
        kind,
        state: "ready",
        calendar,
        connectionId,
        readCompletedAt: new Date().toISOString(),
        ...payload,
      }),
    ],
  );
  return id;
}
test("overview preserves school-account and app-owner isolation and detects a semester switch", async () => {
  const overview = require("../services/overview"),
    id = await overviewFixture("academic", { weeks: [] });
  assert.equal((await http("/api/overview/" + id)).status, 200);
  assert.equal(
    (await http("/api/overview/" + id, { bearer: token.issueToken(other) }))
      .status,
    404,
  );
  await pool.query(
    "UPDATE school_login_sessions SET connection_id=? WHERE openid=?",
    [crypto.randomUUID(), actor],
  );
  await assert.rejects(
    overview.get(id, actor),
    (e) => e.code === "OVERVIEW_NOT_FOUND",
  );
  const id2 = await overviewFixture("academic", { weeks: [] });
  await pool.query(
    "UPDATE school_login_sessions SET calendar=? WHERE openid=?",
    [JSON.stringify({ ...calendar, startDate: "2027-03-01" }), actor],
  );
  await assert.rejects(
    overview.get(id2, actor),
    (e) => e.code === "OVERVIEW_TERM_CHANGED",
  );
});
test("worklog overview pages 242 own students, evaluates targets from school records, and carries all missing IDs rather than only the first page", async () => {
  const overview = require("../services/overview"),
    students = Array.from({ length: 242 }, (_, i) => ({
      studentId: "202200" + String(i + 1).padStart(4, "0"),
      name: "示例" + i,
      hasContact: true,
      schoolCount: 999,
    })),
    id = await overviewFixture("worklog", {
      students,
      records: [
        {
          id: "school-old",
          xh: students[0].studentId,
          thsj: "2026-09-01 09:00:00",
          thsc: 10,
          thfs: "1",
        },
      ],
    });
  const data = await overview.get(id, actor, { targetCount: 1 });
  assert.equal(data.students.length, 50);
  assert.equal(data.totalStudents, 242);
  assert.equal(data.summary.completed, 1);
  assert.equal(data.summary.missingCounts, 241);
  const selected = await overview.selection(id, actor, { targetCount: 1 });
  assert.equal(selected.studentIds.length, 241);
  assert(!selected.studentIds.includes(students[0].studentId));
  assert.equal(selected.targetCount, 1);
  const changed = await overview.get(id, actor, { targetCount: 2 });
  assert.equal(changed.summary.missingCounts, 483);
  const detail = await overview.detail(id, actor, students[0].studentId);
  assert.equal(detail.records[0].id, "school-old");
  assert.equal(detail.schoolCount, 999);
  assert.equal(
    (await overview.get(id, actor, { query: students[241].studentId })).students
      .length,
    1,
  );
});
test("academic scan and preview preserve multiple same-type operations even when a record already exists", async () => {
  const sessions = require("../services/schoolSession"),
    academic = require("../services/academicSchool"),
    manager = require("../services/academicPlanner"),
    rules = require("../services/academicRequirements"),
    old = [sessions.getSession, academic.roster, academic.records],
    session = {
      step: "ready",
      calendar,
      connectionId: await fixtureConnection(),
      page: schoolPage(),
    },
    person = {
      studentId: "2022000001",
      name: "示例",
      requirements: rules.normalize({
        pc: 5,
        gzcs: 1,
        gzlcth: 1,
        gzlczf: 1,
        gzlcpb: 1,
      }),
    };
  sessions.getSession = async () => session;
  academic.roster = async (_, c, week) => ({
    week,
    gzrzid: "quota-week-" + week,
    editable: true,
    students: [structuredClone(person)],
  });
  academic.records = async (_, info, id, type) =>
    type === "talk"
      ? [{ id: "already-there", thsj: "2026-08-31 09:00:00", thsc: 10, bz: "" }]
      : [];
  try {
    const scan = await manager.startRoster(actor, {
      weeks: [1],
      entry: "talk",
    });
    let ready;
    for (let i = 0; i < 100; i++) {
      ready = await manager.snapshot(scan.snapshotId, actor);
      if (ready.state !== "scanning" && !session.busyPlan) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(ready.students[0].remainingCount, 4);
    const created = await manager.preview(actor, {
      snapshotId: scan.snapshotId,
      studentIds: [person.studentId],
      content: "",
    });
    let preview;
    for (let i = 0; i < 100; i++) {
      preview = await planner.getPlan(created.planId, actor);
      if (preview.state !== "scanning" && !session.busyPlan) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(preview.state, "ready", preview.error);
    assert.equal(preview.summary.planned, 4);
    assert.equal(preview.summary.skipped, 0);
    assert.deepEqual(
      preview.operations.map((o) => o.occurrence),
      [1, 2, 3, 4],
    );
    assert(
      preview.operations.every(
        (o) => o.type === "talk" && o.payload.ruleVersion === 2,
      ),
    );
    assert.equal(
      new Set(preview.operations.map((o) => o.payload.recordedAt)).size,
      4,
    );
    assert.equal(await model.active(actor), null);
  } finally {
    [sessions.getSession, academic.roster, academic.records] = old;
  }
});
test("incomplete overview read retains failed weeks as unknown, prevents direct selection, and cancellation preserves the last readable result", async () => {
  const sessions = require("../services/schoolSession"),
    academic = require("../services/academicSchool"),
    calendarService = require("../services/academicCalendar"),
    overview = require("../services/overview"),
    rules = require("../services/academicRequirements"),
    old = [
      sessions.getSession,
      academic.roster,
      academic.records,
      calendarService.syncSchoolCalendar,
    ],
    connectionId = await overviewConnection(),
    session = { step: "ready", calendar, connectionId, page: schoolPage() };
  sessions.getSession = async () => session;
  calendarService.syncSchoolCalendar = async () => calendar;
  academic.roster = async (_, c, week) => {
    if (week === 2)
      throw new (require("../utils/errors").AppError)(
        409,
        "ACADEMIC_WEEK_UNAVAILABLE",
        "该周未建立",
      );
    return {
      week,
      gzrzid: "w" + week,
      editable: true,
      students: [
        {
          studentId: "2022000001",
          name: "示例",
          requirements: rules.normalize({
            pc: 1,
            gzcs: 1,
            gzlcth: 1,
            gzlczf: 1,
            gzlcpb: 1,
          }),
        },
      ],
    };
  };
  academic.records = async () => [];
  try {
    const scan = await overview.start(actor, "academic");
    let data;
    for (let i = 0; i < 100; i++) {
      data = await overview.get(scan.id, actor);
      if (data.state !== "scanning" && !session.busyPlan) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(data.state, "ready", data.error);
    assert.equal(data.summary.unverifiedWeeks, 1);
    assert.equal(data.summary.complete, false);
    await assert.rejects(
      overview.selection(scan.id, actor),
      (e) => e.code === "OVERVIEW_INCOMPLETE",
    );
    const lastId = scan.id;
    let release;
    academic.roster = async () => {
      await new Promise((r) => (release = r));
      return { week: 1, gzrzid: "w1", editable: true, students: [] };
    };
    const cancelled = await overview.start(actor, "academic");
    for (let i = 0; i < 20 && !release; i++)
      await new Promise((r) => setTimeout(r, 10));
    await overview.cancel(cancelled.id, actor);
    release();
    for (let i = 0; i < 100; i++) {
      data = await overview.get(cancelled.id, actor);
      if (data.state !== "scanning" && !session.busyPlan) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(data.state, "cancelled");
    assert.equal(
      (await overview.latest(actor, "academic")).snapshot.id,
      lastId,
    );
    assert.equal(session.busyPlan, null);
  } finally {
    [
      sessions.getSession,
      academic.roster,
      academic.records,
      calendarService.syncSchoolCalendar,
    ] = old;
  }
});

test("academic worker stops at the fresh school target, and final round deficits remain visible without losing saved receipts", async () => {
  const nav = require("../services/navigator"),
    driver = require("../services/recordDriver"),
    school = require("../services/academicSchool"),
    cal = require("../services/academicCalendar"),
    rules = require("../services/academicRequirements"),
    old = [
      nav.navigateAndQuery,
      driver.saveOperation,
      school.roster,
      school.records,
      cal.syncSchoolCalendar,
    ];
  let count, writes, visit;
  nav.navigateAndQuery = async () => {};
  cal.syncSchoolCalendar = async () => calendar;
  school.roster = async () => ({
    week: 1,
    gzrzid: "quota-log",
    editable: true,
    students: [
      {
        studentId: "2022000001",
        requirements: rules.normalize({
          pc: 3,
          gzcs: count,
          gzlcth: count,
          gzlczf: visit,
          gzlcpb: 1,
        }),
      },
    ],
  });
  school.records = async (_, __, ___, type) =>
    type === "talk"
      ? [{ id: "prior", thsj: "2026-09-01 08:00:00", thsc: 10 }]
      : [];
  driver.saveOperation = async (_, op, before) => {
    const gate = await before();
    if (gate) return gate;
    count++;
    writes++;
    return {
      status: "succeeded",
      receipt: { schoolRecordId: "verified-" + writes, verified: true },
    };
  };
  try {
    for (const roundVisit of [1, 0]) {
      visit = roundVisit;
      count = 1;
      writes = 0;
      const rulesOptions =
          require("../services/academicPlanner").validateOptions(
            { studentIds: ["2022000001"], content: "" },
            calendar,
          ),
        id = await plan(
          Array.from({ length: 3 }, (_, i) => ({
            studentId: "2022000001",
            studentName: "示例",
            week: 1,
            type: "talk",
            occurrence: i + 1,
            status: "planned",
            payload: {
              ...rulesOptions,
              ruleVersion: 2,
              academicGoal: "count",
              scope: "academic",
              gzrzid: "quota-log",
              recordedAt:
                "2026-09-01 09:" + String(i * 20).padStart(2, "0") + ":00",
            },
          })),
        ),
        [rows] = await pool.query("SELECT payload FROM task_plans WHERE id=?", [
          id,
        ]),
        p = model.parse(rows[0].payload);
      Object.assign(p.request, {
        recordType: "academic-auto",
        scope: "academic",
        ruleVersion: 2,
      });
      await pool.query("UPDATE task_plans SET payload=? WHERE id=?", [
        await scoped(p),
        id,
      ]);
      const created = await model.createFromPlan(actor, id, id);
      runner.enqueue(created.taskUuid, actor, {
        step: "ready",
        calendar,
        page: { isClosed: () => false },
      });
      let result;
      for (let i = 0; i < 150; i++) {
        result = await model.getTask(created.taskUuid, actor);
        if (
          !model.ACTIVE.includes(result.status) &&
          !runner.live.has(created.taskUuid)
        )
          break;
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(writes, 2);
      assert.equal(result.progress.success, 2);
      assert.equal(result.progress.skipped, 1);
      assert.equal(result.status, visit ? "completed" : "partial_failed");
      assert(
        result.details
          .filter((d) => d.status === "succeeded")
          .every((d) => d.receipt.verified),
      );
      if (!visit) {
        assert.equal(result.schoolOutstanding.length, 1);
        assert.deepEqual(result.schoolOutstanding[0].roundMissing, ["visit"]);
      }
    }
  } finally {
    [
      nav.navigateAndQuery,
      driver.saveOperation,
      school.roster,
      school.records,
      cal.syncSchoolCalendar,
    ] = old;
    require("../services/login").pendingLogins.delete(actor);
  }
});

test("overview cache retention preserves the two latest complete results and the current failed read", async () => {
  const service = require("../services/overview"),
    connectionId = await overviewConnection(),
    ids = [];
  for (let i = 0; i < 4; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
    await pool.query(
      "INSERT INTO overview_snapshots(id,openid,connection_id,kind,payload,expires_at) VALUES (?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 DAY))",
      [
        id,
        actor,
        connectionId,
        "worklog",
        JSON.stringify({
          kind: "worklog",
          state: i === 3 ? "failed" : "ready",
          calendar,
          students: [],
          records: [],
          readCompletedAt: new Date().toISOString(),
        }),
      ],
    );
  }
  await service.prune(actor, "worklog", connectionId, ids[3]);
  const [rows] = await pool.query(
    "SELECT id FROM overview_snapshots WHERE openid=? AND connection_id=? AND kind=?",
    [actor, connectionId, "worklog"],
  );
  assert.equal(rows.length, 3);
  assert(rows.some((r) => r.id === ids[1]));
  assert(rows.some((r) => r.id === ids[2]));
  assert(rows.some((r) => r.id === ids[3]));
  assert(!rows.some((r) => r.id === ids[0]));
});

test("v16 switching school connections invalidates snapshots and previews before planning or creating a task", async () => {
  const connectionId = await fixtureConnection(),
    id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO worklog_snapshots(id,openid,payload,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))",
    [
      id,
      actor,
      JSON.stringify({
        connectionId,
        state: "ready",
        calendar,
        students: [],
        records: [],
      }),
    ],
  );
  assert.equal(
    (await require("../services/worklogPlanner").rawSnapshot(id, actor))
      .connectionId,
    connectionId,
  );
  await pool.query(
    "UPDATE school_login_sessions SET connection_id=? WHERE openid=?",
    [crypto.randomUUID(), actor],
  );
  await assert.rejects(
    require("../services/worklogPlanner").rawSnapshot(id, actor),
    (e) => e.code === "SCHOOL_ACCOUNT_CHANGED",
  );
});
test("v16 operation details paginate on server, search full data and enforce owner isolation", async () => {
  const id = await plan(
      Array.from({ length: 75 }, (_, i) => ({
        studentId: String(2022000000 + i),
        studentName: "学生" + i,
        week: 1,
        type: "talk",
        status: i === 74 ? "not_applicable" : "skipped",
        reason: i === 74 ? "fixture issue" : null,
        payload: { recordedAt: "2026-09-01 09:00:00" },
      })),
    ),
    task = await model.createFromPlan(actor, id, id);
  const first = await http(
    "/api/task/" + task.taskUuid + "/details?pageSize=30",
  );
  assert.equal(first.body.items.length, 30);
  assert.equal(first.body.total, 75);
  assert(first.body.hasMore);
  const found = await http(
    "/api/task/" + task.taskUuid + "/details?query=学生74",
  );
  assert.equal(found.body.items.length, 1);
  const issues = await http("/api/task/" + task.taskUuid + "/details?issues=1");
  assert.equal(issues.body.total, 1);
  assert.equal(
    (
      await http("/api/task/" + task.taskUuid + "/details", {
        bearer: token.issueToken(other),
      })
    ).status,
    404,
  );
  await model.recoverOrphans();
});
test("v16 maintenance deletes expired temporary data but keeps tasks and receipts", async () => {
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO academic_snapshots(id,openid,payload,expires_at) VALUES (?,?,?,DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR))",
    [id, actor, JSON.stringify({ state: "ready" })],
  );
  const [before] = await pool.query("SELECT COUNT(*) AS n FROM tasks");
  await require("../services/maintenance").cleanup();
  const [after] = await pool.query("SELECT COUNT(*) AS n FROM tasks");
  assert.equal(before[0].n, after[0].n);
  const [rows] = await pool.query(
    "SELECT id FROM academic_snapshots WHERE id=?",
    [id],
  );
  assert.equal(rows.length, 0);
});
test("v16 read-only academic entry requires an app identity and does not expose old grade routes", async () => {
  assert.equal(
    (await http("/api/academic-access/status", { bearer: "invalid" })).status,
    401,
  );
  assert.equal((await http("/api/academic-access/status")).body.step, "none");
  assert.equal((await http("/api/grade/login-status")).status, 404);
});

test("v16 incremental overview reuses only verified history and rereads current or dirty weeks", async () => {
  const overview = require("../services/overview"),
    school = require("../services/academicSchool"),
    sessions = require("../services/schoolSession"),
    cal = require("../services/academicCalendar");
  const old = [
    school.roster,
    school.records,
    sessions.getSession,
    cal.syncSchoolCalendar,
  ];
  const connectionId = await overviewConnection(),
    session = { step: "ready", connectionId, calendar, page: schoolPage() };
  let reads = [];
  sessions.getSession = async () => session;
  cal.syncSchoolCalendar = async () => calendar;
  school.roster = async (_, c, week) => {
    reads.push(week);
    return {
      week,
      gzrzid: "fixture-" + week,
      editable: true,
      students: [
        {
          studentId: "2022000001",
          name: "fixture",
          requirements: {
            required: 1,
            completed: 1,
            remaining: 0,
            roundMissing: [],
            round: { talk: 1, visit: 1, companion: 1 },
          },
        },
      ],
    };
  };
  school.records = async () => [];
  const scan = async (full = false) => {
    const r = await overview.start(actor, "academic", { full });
    for (let i = 0; i < 200 && overview.running.has(actor); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    return overview.get(r.id, actor);
  };
  try {
    reads = [];
    const initial = await scan(true);
    assert.equal(reads.length, 11);
    reads = [];
    const incremental = await scan();
    assert.deepEqual(reads, [11]);
    assert.equal(incremental.reusedWeeks.length, 10);
    const [rows] = await pool.query(
      "SELECT payload FROM overview_snapshots WHERE id=?",
      [incremental.id],
    );
    const data = model.parse(rows[0].payload);
    data.dirtyWeeks = [2];
    await pool.query("UPDATE overview_snapshots SET payload=? WHERE id=?", [
      JSON.stringify(data),
      incremental.id,
    ]);
    reads = [];
    await scan();
    assert.deepEqual(reads, [2, 11]);
  } finally {
    [
      school.roster,
      school.records,
      sessions.getSession,
      cal.syncSchoolCalendar,
    ] = old;
  }
});

test("v16 refusing credential deletion during a scan leaves both credential and connection intact", async () => {
  const credential = require("../models/credential"),
    pending = require("../services/login").pendingLogins;
  await credential.saveCredential(actor, "2022000001", "synthetic-password");
  pending.set(actor, {
    step: "ready",
    busyPlan: "fixture-scan",
    page: schoolPage(),
  });
  try {
    const r = await http("/api/auth/credential", { method: "DELETE" });
    assert.equal(r.status, 409);
    assert.equal(await credential.hasCredential(actor), true);
    assert.equal(pending.peek(actor).busyPlan, "fixture-scan");
  } finally {
    pending.delete(actor);
  }
});
test("v16 long pause releases only before save and retains operations as safely retryable", async () => {
  const old = process.env.TASK_PAUSE_RELEASE_MS;
  process.env.TASK_PAUSE_RELEASE_MS = "1";
  const id = await plan(),
    task = await model.createFromPlan(actor, id, id);
  await pool.query("UPDATE tasks SET status='paused' WHERE task_uuid=?", [
    task.taskUuid,
  ]);
  await pool.query(
    "UPDATE task_operations SET status='in_progress' WHERE task_uuid=?",
    [task.taskUuid],
  );
  try {
    await assert.rejects(
      runner.checkpoint(task.taskUuid),
      (e) => e.code === "PAUSE_EXPIRED",
    );
    const rows = await model.operations(task.taskUuid);
    assert.equal(rows[0].status, "cancelled");
  } finally {
    if (old === undefined) delete process.env.TASK_PAUSE_RELEASE_MS;
    else process.env.TASK_PAUSE_RELEASE_MS = old;
    await model.recoverOrphans();
  }
});
test("v16 overview partitions round-trip and do not copy all records into each progress update", async () => {
  const connectionId = await fixtureConnection(),
    id = crypto.randomUUID(),
    data = {
      id,
      connectionId,
      kind: "academic",
      calendar,
      state: "ready",
      readCompletedAt: new Date().toISOString(),
      weeks: [
        { week: 1, readCompletedAt: new Date().toISOString(), students: [] },
      ],
    };
  await pool.query(
    "INSERT INTO overview_snapshots(id,openid,connection_id,kind,payload,expires_at) VALUES (?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 DAY))",
    [id, actor, connectionId, "academic", JSON.stringify(data)],
  );
  await require("../services/overviewStorage").save(id, data);
  const [rows] = await pool.query(
    "SELECT payload FROM overview_snapshots WHERE id=?",
    [id],
  );
  const metadata = model.parse(rows[0].payload);
  assert.equal(metadata.weeks, undefined);
  assert(metadata.partitioned);
  assert.equal(
    (await require("../services/overviewStorage").hydrate(id, metadata)).weeks
      .length,
    1,
  );
});

test("random academic methods stay concrete after persistence, manual review and retry planning", async () => {
  const manager = require("../services/academicPlanner"),
    academic = require("../services/academicSchool"),
    sessions = require("../services/schoolSession"),
    rules = require("../services/academicRequirements");
  const old = [sessions.getSession, academic.roster, academic.records],
    connectionId = await fixtureConnection(),
    session = { step: "ready", connectionId, calendar, page: schoolPage() },
    person = {
      studentId: "2022000001",
      name: "合成学生",
      requirements: rules.normalize({
        pc: 3,
        gzcs: 0,
        gzlcth: 1,
        gzlczf: 1,
        gzlcpb: 1,
      }),
    };
  sessions.getSession = async () => session;
  academic.roster = async (_, c, week) => ({
    week,
    gzrzid: "fixture-method",
    editable: true,
    students: [structuredClone(person)],
  });
  academic.records = async () => [];
  const wait = async (id) => {
    let p;
    for (let i = 0; i < 150; i++) {
      p = await planner.getPlan(id, actor);
      if (p.state !== "scanning" && !session.busyPlan) return p;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("preview timeout");
  };
  try {
    const r = await manager.startRoster(actor, { weeks: [1], entry: "talk" });
    for (let i = 0; i < 150 && session.busyPlan; i++)
      await new Promise((r) => setTimeout(r, 10));
    const created = await manager.preview(actor, {
      snapshotId: r.snapshotId,
      studentIds: [person.studentId],
      method: "随机",
      content: "",
    });
    let p = await wait(created.planId);
    assert.equal(p.request.method, "随机");
    assert.equal(p.operations.length, 3);
    assert(
      p.operations.every((o) =>
        ["面对面", "电话", "网络"].includes(o.payload.method),
      ),
    );
    const methods = p.operations.map((o) => o.payload.method);
    assert.deepEqual(
      (await planner.getPlan(p.id, actor)).operations.map(
        (o) => o.payload.method,
      ),
      methods,
    );
    const change = {
      operationIndex: 0,
      recordedAt: p.operations[0].payload.recordedAt,
      content: "实际核对",
      method: "电话",
    };
    p = await manager.review(actor, p.id, {
      revision: p.revision,
      changes: [change],
    });
    assert.equal(p.operations[0].payload.method, "电话");
    await assert.rejects(
      manager.review(actor, p.id, {
        revision: p.revision,
        changes: [{ ...change, method: "随机" }],
      }),
      (e) => e.code === "INVALID_TALK_METHOD",
    );
    const task = await model.createFromPlan(actor, p.id, p.id);
    await model.recoverOrphans();
    const retry = await planner.retryPlan(task.taskUuid, actor),
      ready = await wait(retry.id);
    assert.deepEqual(
      // Database operation IDs can reorder equal student/week rows. Compare each
      // actual record by its scheduled time rather than by array position.
      ready.operations
        .map((o) => [o.payload.recordedAt, o.payload.method])
        .sort(),
      p.operations.map((o) => [o.payload.recordedAt, o.payload.method]).sort(),
    );
    assert.equal(ready.state, "ready");
  } finally {
    [sessions.getSession, academic.roster, academic.records] = old;
  }
});

test("content template CRUD is owner-isolated, revision checked and deleting all templates persists", async () => {
  const service = require("../services/contentTemplates");
  let a = await service.get(actor);
  const b = await service.get(other);
  assert(a.items.length > 0 && b.items.length > 0);
  const res = await http("/api/content-templates");
  assert.equal(res.status, 200);
  const created = await http("/api/content-templates", {
    method: "POST",
    body: {
      action: "create",
      revision: a.revision,
      item: {
        title: "合成主题",
        content: "合成测试内容",
        scope: "talk",
        enabled: true,
      },
    },
  });
  assert.equal(created.status, 200);
  a = created.body;
  const t = a.items.at(-1);
  assert(!(await service.get(other)).items.some((x) => x.id === t.id));
  await assert.rejects(
    service.change(actor, {
      action: "update",
      revision: a.revision - 1,
      id: t.id,
      item: t,
    }),
    (e) => e.code === "TEMPLATES_CHANGED",
  );
  await assert.rejects(
    service.change(other, { action: "delete", revision: b.revision, id: t.id }),
    (e) => e.code === "TEMPLATE_NOT_FOUND",
  );
  a = await service.change(actor, {
    action: "update",
    revision: a.revision,
    id: t.id,
    item: { ...t, content: "修改后的合成内容" },
  });
  assert.equal(a.items.at(-1).content, "修改后的合成内容");
  for (const item of [...a.items])
    a = await service.change(actor, {
      action: "delete",
      revision: a.revision,
      id: item.id,
    });
  assert.deepEqual((await service.get(actor)).items, []);
  await assert.rejects(
    service.prepare(actor, { contentMode: "random" }, "talk"),
    (e) => e.code === "NO_CONTENT_TEMPLATES",
  );
  // Restore explicit synthetic fixtures for the next test; defaults must never silently reappear.
  for (const item of service.DEFAULTS)
    a = await service.change(actor, {
      action: "create",
      revision: a.revision,
      item,
    });
});

test("all academic random fields resolve in scope and remain fixed through template edits, review and retry", async () => {
  const manager = require("../services/academicPlanner"),
    academic = require("../services/academicSchool"),
    sessions = require("../services/schoolSession"),
    rules = require("../services/academicRequirements"),
    templates = require("../services/contentTemplates");
  const old = [sessions.getSession, academic.roster, academic.records],
    connectionId = await fixtureConnection(),
    session = { step: "ready", connectionId, calendar, page: schoolPage() },
    person = {
      studentId: "2022000001",
      name: "合成学生",
      requirements: rules.normalize({
        pc: 3,
        gzcs: 0,
        gzlcth: 0,
        gzlczf: 0,
        gzlcpb: 0,
      }),
    };
  sessions.getSession = async () => session;
  academic.roster = async () => ({
    week: 1,
    gzrzid: "random-fixture",
    editable: true,
    students: [structuredClone(person)],
  });
  academic.records = async () => [];
  const wait = async (id) => {
    for (let n = 0; n < 200; n++) {
      const p = await planner.getPlan(id, actor);
      if (p.state !== "scanning" && !session.busyPlan) return p;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("Random preview timeout");
  };
  try {
    const scan = await manager.startRoster(actor, {
      weeks: [1],
      entry: "automatic",
    });
    for (let n = 0; n < 200 && session.busyPlan; n++)
      await new Promise((r) => setTimeout(r, 10));
    const result = await manager.preview(actor, {
      snapshotId: scan.snapshotId,
      studentIds: [person.studentId],
      method: "随机",
      scene: "随机",
      pbType: "随机",
      contentMode: "random",
      durationMode: "random",
      durationMin: 8,
      durationMax: 15,
    });
    let p = await wait(result.planId);
    assert.equal(p.state, "ready");
    assert.equal(p.operations.length, 2);
    for (const op of p.operations) {
      assert(op.payload.content.length > 0);
      assert(op.payload.contentTemplateId);
      assert(
        op.payload.durationMinutes >= 8 && op.payload.durationMinutes <= 15,
      );
      assert(op.payload.scene !== "随机" && op.payload.pbType !== "随机");
      assert(!op.payload.contentTemplates);
    }
    assert.equal(
      rules.sceneKind(
        p.operations.find((o) => o.goal === "visit").payload.scene,
      ),
      "visit",
    );
    const frozen = p.operations
      .map((o) => [
        o.payload.recordedAt,
        o.payload.content,
        o.payload.scene,
        o.payload.pbType,
        o.payload.durationMinutes,
        o.payload.method,
      ])
      .sort();
    let lib = await templates.get(actor);
    const selected = lib.items.find(
      (t) => t.id === p.operations[0].payload.contentTemplateId,
    );
    await templates.change(actor, {
      action: "update",
      revision: lib.revision,
      id: selected.id,
      item: { ...selected, content: "后来修改的模板内容" },
    });
    assert.deepEqual(
      (await planner.getPlan(p.id, actor)).operations
        .map((o) => [
          o.payload.recordedAt,
          o.payload.content,
          o.payload.scene,
          o.payload.pbType,
          o.payload.durationMinutes,
          o.payload.method,
        ])
        .sort(),
      frozen,
    );
    const index = p.operations.findIndex((o) => o.type === "talk"),
      op = p.operations[index];
    p = await manager.review(actor, p.id, {
      revision: p.revision,
      changes: [
        {
          operationIndex: index,
          recordedAt: op.payload.recordedAt,
          scene: "走访实验室",
          durationMinutes: 9,
          method: "网络",
          content: "实际核对后的内容",
        },
      ],
    });
    assert.equal(p.operations[index].payload.scene, "走访实验室");
    assert.equal(p.operations[index].payload.durationMinutes, 9);
    await assert.rejects(
      manager.review(actor, p.id, {
        revision: p.revision,
        changes: [
          {
            operationIndex: index,
            recordedAt: op.payload.recordedAt,
            scene: "随机",
          },
        ],
      }),
      (e) => e.code === "INVALID_FORM_OPTION",
    );
    const task = await model.createFromPlan(actor, p.id, p.id);
    const details = await require("../services/taskDetails").page(
      task.taskUuid,
      actor,
    );
    const actual = details.items.find((d) => d.type === "talk");
    assert.equal(actual.content, "实际核对后的内容");
    assert.equal(actual.durationMinutes, 9);
    await model.recoverOrphans();
    const retry = await planner.retryPlan(task.taskUuid, actor),
      ready = await wait(retry.id);
    const fields = (o) => [
      o.type,
      o.payload.recordedAt,
      o.payload.content,
      o.payload.scene,
      o.payload.pbType,
      o.payload.durationMinutes,
      o.payload.method,
    ];
    assert.deepEqual(
      ready.operations.map(fields).sort(),
      p.operations.map(fields).sort(),
    );
  } finally {
    [sessions.getSession, academic.roster, academic.records] = old;
  }
});

test("worklog scan checkpoints and final partition persistence retain one semester talk for every one of 242 students", async () => {
  const overview = require("../services/overview"),
    sessions = require("../services/schoolSession"),
    worklog = require("../services/worklogSchool"),
    calendarService = require("../services/academicCalendar");
  const old = [
      sessions.getSession,
      worklog.readSnapshot,
      calendarService.syncSchoolCalendar,
    ],
    connectionId = await overviewConnection(),
    session = { step: "ready", connectionId, calendar, page: schoolPage() };
  const students = Array.from({ length: 242 }, (_, i) => ({
    studentId: "202200" + String(i + 1).padStart(4, "0"),
    name: "合成学生" + i,
    schoolCount: 1,
    semesterCount: 1,
    hasContact: true,
  }));
  const records = students.map((s, i) => ({
      id: "partition-" + i,
      xh: s.studentId,
      thsj: "2026-09-01 09:00:00",
      thsc: 10,
      thfs: "1",
      week: 1,
    })),
    source = {
      students,
      records,
      days: [
        { week: 1, date: "2026-09-01", editable: true, gzrzid: "fixture" },
      ],
      weekCheckedAt: { 1: new Date().toISOString() },
      totalWeeks: 1,
      reusedWeeks: [],
    };
  sessions.getSession = async () => session;
  calendarService.syncSchoolCalendar = async () => calendar;
  worklog.readSnapshot = async (p, c, options) => {
    assert.equal(options.previous, null);
    await options.onCheckpoint(source);
    return structuredClone(source);
  };
  try {
    const scan = await overview.start(actor, "worklog", { full: false });
    let data;
    for (let i = 0; i < 150; i++) {
      data = await overview.get(scan.id, actor, { targetCount: 1 });
      if (data.state !== "scanning" && !session.busyPlan) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(data.state, "ready", data.error);
    assert.equal(data.summary.completed, 242);
    assert.equal(data.summary.missingStudents, 0);
    assert.equal(data.summary.missingCounts, 0);
    const [rows] = await pool.query(
      "SELECT payload FROM overview_snapshots WHERE id=?",
      [scan.id],
    );
    const metadata = model.parse(rows[0].payload);
    assert.equal(metadata.worklogRecordsVersion, 2);
    const hydrated = await require("../services/overviewStorage").hydrate(
      scan.id,
      metadata,
    );
    assert.equal(hydrated.records.length, 242);
    assert(hydrated.records.every((r) => r.week === 1));
    assert.equal(
      (await overview.detail(scan.id, actor, students[241].studentId))
        .completed,
      1,
    );
    assert.equal(
      (
        await overview.get(scan.id, actor, {
          filter: "missing",
          targetCount: 1,
        })
      ).matched,
      0,
    );
    await assert.rejects(
      require("../services/overviewStorage").save(scan.id, {
        ...hydrated,
        records: records.map(({ week, ...r }) => r),
      }),
      /所属周次/,
    );
    assert.equal(
      (await require("../services/overviewStorage").hydrate(scan.id, metadata))
        .records.length,
      242,
    );
  } finally {
    [
      sessions.getSession,
      worklog.readSnapshot,
      calendarService.syncSchoolCalendar,
    ] = old;
  }
});
