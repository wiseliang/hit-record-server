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
    "worklog_snapshots",
    "academic_snapshots",
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
    "1.4.1",
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
    [id, actor, JSON.stringify(snapshot)],
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
    JSON.stringify(payload),
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
    [id, actor, JSON.stringify(snapshot)],
  );
  const pending = require("../services/login").pendingLogins;
  pending.set(actor, { calendar, step: "ready" });
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
  await sessions.persist(actor,{step:"ready",calendar,page:{context:()=>({storageState:async()=>({cookies:[],origins:[]})})}},{existingOnly:true});
  assert.equal(await sessions.stored(actor),undefined,"late idle or worker updates must not recreate a released session");
});
test("academic snapshots cannot be opened across owners and reject work-log IDs before any write", async () => {
  const id = crypto.randomUUID(),
    snap = {
      scope: "academic",
      state: "ready",
      calendar,
      weeks: [1],
      entry: "automatic",
      students: [{ studentId: "2022000001", name: "学情学生", weeks: [1] }],
      weekRosters: [{ week: 1, students: [{ studentId: "2022000001" }] }],
    };
  await pool.query(
    "INSERT INTO academic_snapshots(id,openid,payload,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))",
    [id, actor, JSON.stringify(snap)],
  );
  const academic = require("../services/academicPlanner");
  await assert.rejects(
    () => academic.snapshot(id, other),
    (e) => e.code === "ACADEMIC_SNAPSHOT_NOT_FOUND",
  );
  const sessions = require("../services/schoolSession"),
    old = sessions.getSession;
  sessions.getSession = async () => ({ step: "ready", calendar });
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
    [id, actor, model.hash(p), JSON.stringify(p)],
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

test('SIGTERM shuts down cleanly with numeric exit status',async()=>{
 const {spawn}=require('node:child_process'),child=spawn(process.execPath,['-e',"require('./app').start().then(()=>setTimeout(()=>process.kill(process.pid,'SIGTERM'),50)).catch(()=>process.exit(2))"],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);const timer=setTimeout(()=>child.kill('SIGKILL'),10000);try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});assert.equal(code,0,log);assert(!log.includes('uncaughtException'))}finally{clearTimeout(timer)}
});

test('release page serves illustrated instructions and APK downloads support range without exposing private data',async()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'recorder-download-')),old=process.env.RELEASE_DOWNLOAD_DIR;process.env.RELEASE_DOWNLOAD_DIR=dir;
 try{const manifest=require('../public/releases/release.json'),data=Buffer.from('isolated-apk-download-fixture');fs.writeFileSync(path.join(dir,manifest.file),data);const redirect=await fetch(base+'/releases',{redirect:'manual'});assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'releases/');const page=await fetch(base+'/releases/');assert.equal(page.status,200);assert((await page.text()).includes('先连接学校'));const image=await fetch(base+'/releases/images/home.png');assert.equal(image.status,200);const download=await fetch(base+'/downloads/latest.apk');assert.equal(download.status,200);assert(download.headers.get('content-type').includes('android.package-archive'));assert.deepEqual(Buffer.from(await download.arrayBuffer()),data);const partial=await fetch(base+'/downloads/'+manifest.file,{headers:{Range:'bytes=0-3'}});assert.equal(partial.status,206);assert.equal(Buffer.from(await partial.arrayBuffer()).toString(),'isol');assert.equal((await fetch(base+'/downloads/.env')).status,404);assert.equal((await fetch(base+'/releases/../.env')).status,404)}finally{if(old===undefined)delete process.env.RELEASE_DOWNLOAD_DIR;else process.env.RELEASE_DOWNLOAD_DIR=old;fs.rmSync(dir,{recursive:true,force:true})}
});
