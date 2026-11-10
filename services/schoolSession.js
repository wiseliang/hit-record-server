const { AppError } = require("../utils/errors");
const URL = "https://xuegong.hitwh.edu.cn/zhxy-xgzs/xg_fdygzrz/rzgl";
const DAY = 24 * 60 * 60 * 1000,
  restoring = new Map();
async function check(page) {
  if (!page || page.isClosed()) return false;
  let u;
  try {
    u = new global.URL(page.url());
  } catch {
    return false;
  }
  if (
    u.hostname !== "xuegong.hitwh.edu.cn" ||
    /login|authserver|\/cas/i.test(u.pathname)
  )
    return false;
  let response;
  try {
    response = await page.request.post(URL + "/getXsList", { timeout: 10000 });
  } catch {
    throw new AppError(
      503,
      "SCHOOL_UNAVAILABLE",
      "学校暂时没有响应，请稍后重试，已保存连接仍保留",
    );
  }
  if (response.status?.() >= 500)
    throw new AppError(
      503,
      "SCHOOL_UNAVAILABLE",
      "学校服务暂时不可用，请稍后重试",
    );
  if (!response.ok()) return false;
  let body;
  try {
    body = await response.json();
  } catch {
    return false;
  }
  return body.isSuccess === true && Array.isArray(body.module);
}
async function validSchoolSession(page) {
  try {
    return await check(page);
  } catch {
    return false;
  }
}
async function requireSchoolSession(session) {
  if (!session || session.step !== "ready")
    throw new AppError(
      401,
      "SCHOOL_AUTH_REQUIRED",
      "学校连接已失效，请在账号入口重新登录",
    );
  if (session.authExpiresAt && session.authExpiresAt <= Date.now())
    throw new AppError(
      401,
      "SCHOOL_AUTH_REQUIRED",
      "学校连接保留期已结束，请重新登录",
    );
  if (
    session._validatedAt &&
    Date.now() - session._validatedAt < 60000 &&
    session.page &&
    !session.page.isClosed()
  )
    return;
  if (!(await check(session.page)))
    throw new AppError(
      401,
      "SCHOOL_AUTH_REQUIRED",
      "学校连接已失效，请在账号入口重新登录",
    );
  session._validatedAt = Date.now();
}
async function persist(openid, session) {
  if (
    !openid ||
    session.step !== "ready" ||
    typeof session.page?.context !== "function"
  )
    return;
  const pool = require("../config/database"),
    { encrypt } = require("../utils/crypto");
  session.authExpiresAt ??= Date.now() + DAY;
  if (session.authExpiresAt <= Date.now()) return;
  const state = await session.page.context().storageState(),
    expiry = new Date(session.authExpiresAt)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
  await pool.query(
    "INSERT INTO school_login_sessions(openid,state_encrypted,calendar,profile,expires_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE state_encrypted=VALUES(state_encrypted),calendar=VALUES(calendar),profile=VALUES(profile),expires_at=VALUES(expires_at)",
    [
      openid,
      encrypt(JSON.stringify(state)),
      JSON.stringify(session.calendar || {}),
      session.profile || "",
      expiry,
    ],
  );
}
async function stored(openid) {
  const [rows] = await require("../config/database").query(
    "SELECT *,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),expires_at) AS ttl FROM school_login_sessions WHERE openid=? AND expires_at>UTC_TIMESTAMP()",
    [openid],
  );
  return rows[0];
}
async function forget(openid) {
  await require("../config/database").query(
    "DELETE FROM school_login_sessions WHERE openid=?",
    [openid],
  );
}
async function getSession(openid) {
  const { pendingLogins } = require("./login");
  let current = pendingLogins.get(openid);
  if (current?.step === "ready" && current.page?.isClosed()) {
    pendingLogins.delete(openid);
    current = null;
  }
  if (current) {
    try {
      await requireSchoolSession(current);
      if (
        !current.busyPlan &&
        current.calendar?.checkedAt?.slice(0, 10) !==
          new Date().toISOString().slice(0, 10)
      ) {
        current.calendar =
          await require("./academicCalendar").syncSchoolCalendar(current.page);
        await persist(openid, current);
      }
      return current;
    } catch (e) {
      if (e.code === "SCHOOL_AUTH_REQUIRED") {
        pendingLogins.delete(openid);
        await forget(openid);
        await require("./browser")
          .releaseContext(current.slot)
          .catch(() => {});
      }
      throw e;
    }
  }
  if (restoring.has(openid)) return restoring.get(openid);
  const promise = (async () => {
    const active = await require("../models/tasksV12").active(openid);
    if (active)
      throw new AppError(
        409,
        "TASK_ACTIVE",
        "已有任务正在使用学校连接，请先查看任务",
        { taskUuid: active.task_uuid },
      );
    const row = await stored(openid);
    if (!row)
      throw new AppError(401, "SCHOOL_AUTH_REQUIRED", "请先在账号入口连接学校");
    const browser = require("./browser"),
      { decrypt } = require("../utils/crypto");
    let state;
    try {
      state = JSON.parse(decrypt(row.state_encrypted));
    } catch {
      await forget(openid);
      throw new AppError(
        401,
        "SCHOOL_AUTH_REQUIRED",
        "保存的学校连接无法恢复，请重新登录",
      );
    }
    const { slot, page } = await browser.acquireContext({
      storageState: state,
    });
    try {
      await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 25000 });
      if (!(await check(page))) {
        await forget(openid);
        throw new AppError(
          401,
          "SCHOOL_AUTH_REQUIRED",
          "学校已要求重新登录，请前往账号入口",
        );
      }
      await page.waitForFunction(
        () =>
          typeof window.$ === "function" &&
          !!$("#gzrz_zc").data("kendoDropDownList"),
        undefined,
        { timeout: 15000 },
      );
      const session = {
        slot,
        page,
        step: "ready",
        _openid: openid,
        profile: row.profile || "",
        calendar: await require("./academicCalendar").syncSchoolCalendar(page),
        authExpiresAt: Date.now() + row.ttl * 1000,
        _validatedAt: Date.now(),
      };
      pendingLogins.set(openid, session);
      return session;
    } catch (e) {
      await browser.releaseContext(slot).catch(() => {});
      throw e;
    }
  })();
  restoring.set(openid, promise);
  try {
    return await promise;
  } finally {
    restoring.delete(openid);
  }
}
async function status(openid) {
  const { pendingLogins } = require("./login"),
    session = pendingLogins.peek(openid),
    row = await stored(openid),
    active = await require("../models/tasksV12").active(openid);
  const ready = session?.step === "ready" && session.authExpiresAt > Date.now(),
    saved = !!row;
  if (session && session.step !== "ready")
    return {
      hasActiveSession: false,
      step: session.step,
      captchaImage: session.captchaImage || null,
    };
  let calendar =
    session?.calendar ||
    require("../models/tasksV12").parse(row?.calendar, null);
  if (calendar?.startDate)
    calendar = require("../utils/week").withSemester(calendar, () => ({
      ...require("../utils/week").getWeekInfo(),
      verified: true,
    }));
  return {
    hasActiveSession: ready || saved,
    step: ready || saved ? "ready" : "none",
    resumable: saved,
    busy: !!session?.busyPlan || !!active,
    taskUuid: active?.task_uuid,
    calendar,
    profile: session?.profile || row?.profile || "",
    expiresAt: row
      ? new Date(Date.now() + row.ttl * 1000).toISOString()
      : session?.authExpiresAt
        ? new Date(session.authExpiresAt).toISOString()
        : null,
    retentionHours: 24,
  };
}
module.exports = {
  validSchoolSession,
  requireSchoolSession,
  persist,
  stored,
  forget,
  getSession,
  status,
  restoring,
};
