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
const calendar = {
  verified: true,
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
    [id, actor, model.hash(p), JSON.stringify(p)],
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
    "tasks",
    "task_plans",
    "task_user_locks",
    "credentials",
    "app_sessions",
    "app_accounts",
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
    "1.2.0",
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
