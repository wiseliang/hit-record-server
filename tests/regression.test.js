const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const crypto = require("node:crypto");
process.env.AUTH_SECRET = crypto.randomBytes(32).toString("hex");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-regression-"));
process.env.SEMESTER_CONFIG_PATH = path.join(temp, "semester.json");
const { after } = require("node:test");
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const session = require("../utils/session");
const logger = { info() {}, warn() {}, error() {} };
function load(relative, overrides = {}, extras = {}, suffix = "") {
  const filename = path.resolve(__dirname, "..", relative);
  const local = require("node:module").createRequire(filename);
  const context = {
    module: { exports: {} },
    require: (n) => (Object.hasOwn(overrides, n) ? overrides[n] : local(n)),
    process,
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    __dirname: path.dirname(filename),
    ...extras,
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8") + suffix, context, {
    filename,
  });
  return context.module.exports;
}
test("signed sessions reject forged, expired and malformed tokens", () => {
  const token = session.issueToken("alice");
  assert.equal(session.verifyToken(token), "alice");
  assert.equal(session.verifyToken(token + "x"), null);
  assert.equal(session.verifyToken("alice"), null);
  const payload = Buffer.from(
    JSON.stringify({ sub: "alice", exp: 1 }),
  ).toString("base64url");
  const expired =
    payload +
    "." +
    crypto
      .createHmac("sha256", process.env.AUTH_SECRET)
      .update(payload)
      .digest("base64url");
  assert.equal(session.verifyToken(expired), null);
});
test("semester updates propagate to already imported functions without timezone drift", () => {
  const week = require("../utils/week");
  const current = week.getCurrentWeek,
    range = week.getWeekRange;
  week.setWeekStart("2026-09-07");
  assert.equal(current(new Date("2026-11-10T00:00:00+08:00")), 10);
  assert.equal(range(1), "09/07-09/13");
  week.setWeekStart("2026-11-09");
  assert.equal(current(new Date("2026-11-10T00:00:00+08:00")), 1);
  assert.equal(current(new Date("2026-11-16T00:00:00+08:00")), 2);
  assert.equal(range(2), "11/16-11/22");
  assert.throws(() => week.setWeekStart("2026-02-30"));
  assert.throws(() => week.setWeekStart("2026-11-10"));
  assert.equal(week.getWeekStart(), "2026-11-09");
});
test("browser sessions are isolated, capacity bounded, queue resumed and duplicate release safe", async () => {
  let created = 0,
    live = 0,
    maxLive = 0,
    launches = 0;
  const contexts = [];
  const browser = load("services/browser.js", {
    playwright: {
      chromium: {
        launch: async () => {
          launches++;
          return {
            isConnected: () => true,
            newContext: async () => {
              await new Promise((r) => setImmediate(r));
              created++;
              live++;
              maxLive = Math.max(maxLive, live);
              const c = {
                id: created,
                cookies: [],
                newPage: async () => ({}),
                close: async () => {
                  live--;
                },
              };
              contexts.push(c);
              return c;
            },
            close: async () => {},
          };
        },
      },
    },
    "../utils/logger": logger,
  });
  try {
    const slots = await Promise.all([
      browser.acquireContext(),
      browser.acquireContext(),
      browser.acquireContext(),
    ]);
    slots[0].slot.context.cookies.push("alice");
    const next = browser.acquireContext();
    await new Promise((r) => setImmediate(r));
    assert.equal(browser.queueLength(), 1);
    await browser.releaseContext(slots[0].slot);
    const bob = await next;
    assert.notEqual(bob.slot.context, slots[0].slot.context);
    assert.deepEqual(bob.slot.context.cookies, []);
    assert.equal(maxLive, 3);
    assert.equal(launches, 1);
    await browser.releaseContext(slots[0].slot);
    assert.equal(browser.activeCount(), 3);
    await Promise.all([
      browser.releaseContext(bob.slot),
      ...slots.slice(1).map((s) => browser.releaseContext(s.slot)),
    ]);
    assert.equal(live, 0);
  } finally {
    await browser.shutdown();
  }
});
test("school calendar derives the semester from authoritative year/term/week", () => {
  const { deriveSemester } = require("../services/academicCalendar");
  const snapshot = deriveSemester(
    [{ nddm: "16", xqdm: "02", zdm: "11" }],
    [{ dmz: "16", dmmc: "2026—2027" }],
    new Date("2026-11-10T00:30:00+08:00"),
  );
  assert.equal(snapshot.startDate, "2026-08-31");
  assert.equal(snapshot.semester, "秋季");
  assert.equal(snapshot.academicYear, "2026—2027");
  assert.equal(snapshot.schoolWeek, 11);
  assert.throws(
    () => deriveSemester([{ nddm: "16", xqdm: "02", zdm: "bad" }], []),
    /周次/,
  );
  assert.throws(
    () =>
      deriveSemester(
        [{ nddm: "16", xqdm: "99", zdm: "11" }],
        [{ dmz: "16", dmmc: "2026—2027" }],
      ),
    /学年或学期/,
  );
});
test("concurrent tasks retain their own semester despite a global semester update", async () => {
  const week = require("../utils/week");
  const autumn = {
    startDate: "2026-08-31",
    academicYear: "2026—2027",
    semester: "秋季",
  };
  const spring = {
    startDate: "2027-03-08",
    academicYear: "2026—2027",
    semester: "春季",
  };
  await Promise.all([
    week.withSemester(autumn, async () => {
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(week.getWeekRange(1), "08/31-09/06");
      assert.equal(week.getAcademicTerm().semester, "秋季");
    }),
    week.withSemester(spring, async () => {
      week.setWeekStart("2028-03-06");
      await new Promise((r) => setTimeout(r, 1));
      assert.equal(week.getWeekRange(1), "03/08-03/14");
      assert.equal(week.getAcademicTerm().academicYear, "2026—2027");
    }),
  ]);
  assert.equal(week.getWeekStart(), "2028-03-06");
  week.setWeekStart("2026-08-31");
});

test("explicit dates reject missing, future and wrong-week values", () => {
  const week = require("../utils/week"),
    { validateRecordDateTime } = require("../services/companion");
  week.setWeekStart("2026-08-31");
  assert.equal(
    validateRecordDateTime(1, "2026-08-31 09:15:00"),
    "2026/08/31 09:15:00",
  );
  for (const value of [undefined, "2026-09-07 09:00:00", "2026-08-31 29:00:00"])
    assert.throws(() => validateRecordDateTime(1, value));
});
test("idle sessions release contexts exactly once and active access renews TTL", async () => {
  let now = 0,
    released = [];
  const { SessionStore } = require("../services/sessionStore"),
    store = new SessionStore({
      ttlMs: 100,
      now: () => now,
      onExpire: (s) => released.push(s.id),
    });
  store.set("a", { id: 1 });
  store.set("b", { id: 2 });
  now = 90;
  store.get("a");
  now = 110;
  await store.prune();
  assert.equal(store.has("a"), true);
  assert.equal(store.has("b"), false);
  assert.deepEqual(released, [2]);
  await store.dispose("b");
  now = 200;
  await store.prune();
  assert.deepEqual(released, [2, 1]);
  store.close();
});
test("matching receipts requires both timestamp and actual content", () => {
  const { matches } = require("../services/recordDriver"),
    payload = { content: "实际谈话内容", recordedAt: "2026/08/31 09:00:00" };
  assert.equal(
    matches(
      { id: "1", time: "2026-08-31 09:00:00", note: "实际谈话内容" },
      payload,
    ),
    true,
  );
  assert.equal(
    matches({ time: "2026-08-31 09:00:00", note: "其他内容" }, payload),
    false,
  );
  assert.equal(
    matches({ time: "2026-09-01 09:00:00", note: "实际谈话内容" }, payload),
    false,
  );
});
after(() => require("../config/database").end());

test("QR with MFA transfers verified school context to task login store", async () => {
  const pending = new Map(),
    page = {},
    slot = {},
    calendar = { verified: true, startDate: "2026-08-31" };
  let saved = 0;
  const router = load("routes/auth.js", {
    "../services/login": {
      pendingLogins: pending,
      navigateToWorkLog: async () => page,
    },
    "../services/browser": {
      keepOnly: async (s, p) => {
        assert.equal(s, slot);
        assert.equal(p, page);
      },
      releaseContext: async () => {},
    },
    "../services/schoolSession": { validSchoolSession: async () => true, persist: async () => {} },
    "../services/academicCalendar": {
      syncSchoolCalendar: async () => calendar,
    },
    "../models/credential": { saveCredential: async () => saved++ },
  });
  const session = { page, slot, step: "mfa", needsMfa: true };
  router.qrSessions.set("qr-user", session);
  const result = await router.ready("qr-user", session);
  assert.equal(result.loggedIn, true);
  assert.equal(router.qrSessions.has("qr-user"), false);
  assert.equal(pending.get("qr-user"), session);
  assert.equal(session.step, "ready");
  assert.equal(session.calendar, calendar);
  assert.equal(saved, 0);
  router.qrSessions.close();
});
test("a public-looking school title does not count as authenticated private access", async () => {
  const { validSchoolSession } = require("../services/schoolSession"),
    url = () => "https://xuegong.hitwh.edu.cn/zhxy-xgzs/xg_fdygzrz/rzgl";
  const page = (body) => ({
    url,
    isClosed: () => false,
    request: { post: async () => ({ ok: () => true, json: async () => body }) },
  });
  assert.equal(
    await validSchoolSession(page({ isSuccess: false, module: [] })),
    false,
  );
  assert.equal(
    await validSchoolSession(page({ isSuccess: true, module: [] })),
    true,
  );
  assert.equal(
    await validSchoolSession({
      url: () => "https://ids.hit.edu.cn/authserver/login",
      isClosed: () => false,
    }),
    false,
  );
});
test("QR has an absolute expiration even when polling refreshes idle time", async () => {
  let now = 0,
    count = 0;
  const { SessionStore } = require("../services/sessionStore"),
    store = new SessionStore({
      ttlMs: 100,
      maxAgeMs: 100,
      now: () => now,
      onExpire: () => count++,
    });
  store.set("qr", { page: "fake" });
  now = 90;
  store.get("qr");
  now = 101;
  await store.prune();
  assert.equal(store.has("qr"), false);
  assert.equal(count, 1);
  store.close();
});

test("logs redact credentials, challenge values and diagnostic body text", () => {
  const { clean } = require("../utils/logger"),
    result = clean({
      password: "test-private-value",
      token: "opaque",
      bodyText: "page containing private identity",
      url: "https://example.invalid/login?ticket=private",
      metadata: JSON.stringify({
        password: "test-private-value",
        code: "123456",
      }),
    });
  assert.equal(result.password, "[redacted]");
  assert.equal(result.bodyText, "[redacted]");
  assert.equal(result.url, "https://example.invalid/login");
  assert.equal(JSON.stringify(result).includes("test-private-value"), false);
});
