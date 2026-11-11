// Dedicated read-only VPN/academic entry. Never restores the legacy shared cookie file.
const browser = require("./browser"),
  login = require("./login"),
  { SessionStore } = require("./sessionStore"),
  { AppError } = require("../utils/errors");
const sessions = new SessionStore({
  ttlMs: 10 * 60000,
  maxAgeMs: 15 * 60000,
  onExpire: async (s) => {
    s.credential = null;
    if (s.slot) await browser.releaseContext(s.slot);
  },
});
const ENTRY =
  "https://ids.hit.edu.cn/authserver/login?service=https%3A%2F%2Fivpn.hitwh.edu.cn%2Fauth%2Fcas_validate%3Fentry_id%3D2";
function view(s) {
  return s
    ? {
        step: s.step,
        busy: !!s.busy,
        message: s.message || "",
        qrcode: s.qrcode || null,
        captchaImage: s.captchaImage || null,
        connected: s.step === "ready",
        expiresAt: new Date(s._lastUsed + 10 * 60000).toISOString(),
      }
    : { step: "none", connected: false };
}
async function inspect(s) {
  const page = s.page,
    url = new URL(page.url());
  if (url.hostname === "ids.hit.edu.cn") {
    if (await page.locator("#dynamicCode").count()) {
      s.step = "code";
      s.message = "请填写本次学校发送的二次验证码";
      return;
    }
    s.step = "login_required";
    s.message = "学校仍停留在认证页面，请重新发起连接";
    return;
  }
  const text = await page.locator("body").innerText({ timeout: 5000 });
  if (
    /jwts|eams|8118/.test(url.host) &&
    /教学管理|成绩管理|课程管理|本科教学/.test(text) &&
    !(await page.locator('input[type="password"]:visible').count())
  ) {
    s.step = "ready";
    s.message = "已进入新教务系统，本入口仅验证连接，不执行数据修改";
    s.credential = null;
    return;
  }
  s.step = "portal";
  s.message = "VPN 已连接，正在检查新教务入口";
}
async function advance(s) {
  let page = s.page;
  if (page.url().includes("/auth/cas_validate"))
    await page.goto("https://ivpn.hitwh.edu.cn/portal/", {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });
  if (/\/portal|ivpn\.hitwh\.edu\.cn\/$/.test(page.url())) {
    s.step = "portal";
    s.message = "正在进入新教务系统";
    const link = page.getByText("新教务系统", { exact: true }).first();
    await link.waitFor({ state: "visible", timeout: 15000 });
    const next = page
      .context()
      .waitForEvent("page", { timeout: 5000 })
      .catch(() => null);
    await link.click({ timeout: 10000 });
    const opened = await next;
    if (opened) {
      s.page = page = opened;
      await page.waitForLoadState("domcontentloaded", { timeout: 20000 });
    }
  }
  if (
    (await page.locator('input[type="password"]:visible').count()) &&
    new URL(page.url()).hostname === "ids.hit.edu.cn"
  ) {
    const result = await login.performAuthserverLogin(
      page,
      s.credential.studentId,
      s.credential.password,
    );
    return accept(s, result);
  }
  await inspect(s);
  if (s.step === "portal") {
    s.step = "entry_unverified";
    s.message =
      "VPN 门户已打开，但尚未取得新教务系统登录证据；请稍后检查，不视为登录成功";
  }
}
async function accept(s, result = {}) {
  if (result.needsCode) {
    s.step = "code";
    s.message = "学校已请求二次验证码，请填写最新验证码";
    return;
  }
  if (result.needsCaptcha) {
    s.step = "captcha";
    s.captchaImage = result.captchaImage;
    s.message = "请填写图片验证码";
    return;
  }
  if (result.loginFailed)
    throw new AppError(
      401,
      "ACADEMIC_LOGIN_FAILED",
      result.message || "学校账号验证未通过",
    );
  await advance(s);
}
function run(s, fn) {
  if (s.busy)
    throw new AppError(
      409,
      "ACADEMIC_LOGIN_BUSY",
      "教务连接正在处理中，请稍候",
    );
  s.busy = true;
  s._lastUsed = Date.now();
  s.job = (async () => {
    let timer;
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AppError(
                  504,
                  "ACADEMIC_LOGIN_TIMEOUT",
                  "教务连接检查超时，请重新发起",
                ),
              ),
            80000,
          );
        }),
      ]);
    } catch (e) {
      s.step = "failed";
      s.message = e.message;
      s.credential = null;
      if (s.slot) await browser.releaseContext(s.slot);
    } finally {
      clearTimeout(timer);
      s.busy = false;
      s._lastUsed = Date.now();
    }
  })();
  return view(s);
}
async function start(openid) {
  const old = sessions.peek(openid);
  if (old?.busy)
    throw new AppError(409, "ACADEMIC_LOGIN_BUSY", "正在连接，请稍候");
  await sessions.dispose(openid);
  const credential = await require("../models/credential").getCredential(
    openid,
  );
  if (!credential)
    throw new AppError(400, "CREDENTIAL_REQUIRED", "请先保存学校账号密码");
  const s = { step: "connecting", credential, message: "正在连接学校 VPN" };
  sessions.set(openid, s);
  return run(s, async () => {
    const { slot, page } = await browser.acquireContext({
      ignoreHTTPSErrors: true,
    });
    s.slot = slot;
    s.page = page;
    await page.goto(ENTRY, { waitUntil: "domcontentloaded", timeout: 30000 });
    await accept(
      s,
      await login.performAuthserverLogin(
        page,
        credential.studentId,
        credential.password,
      ),
    );
  });
}
async function code(openid, value) {
  const s = sessions.get(openid);
  const pattern = s?.step === "captcha" ? /^[a-zA-Z0-9]{4,8}$/ : /^\d{4,8}$/;
  if (typeof value !== "string" || !pattern.test(value.trim()))
    throw new AppError(400, "INVALID_CODE", "请填写4至8位本次学校验证码");
  if (!s || !["code", "captcha"].includes(s.step))
    throw new AppError(
      409,
      "ACADEMIC_SESSION_EXPIRED",
      "教务验证会话已过期或状态已变化，请重新连接",
    );
  return run(s, async () => {
    if (s.step === "captcha") {
      await accept(
        s,
        await login.submitCaptcha(
          s.page,
          value.trim(),
          s.credential.studentId,
          s.credential.password,
        ),
      );
    } else {
      await login.submitCode(s.page, value.trim());
      await advance(s);
    }
  });
}
async function status(openid) {
  const s = sessions.get(openid);
  if (s && !s.busy && s.step === "entry_unverified")
    return run(s, () => advance(s));
  return view(s);
}
async function release(openid) {
  const s = sessions.peek(openid);
  if (s?.busy)
    throw new AppError(409, "ACADEMIC_LOGIN_BUSY", "正在处理连接，请稍后断开");
  await sessions.dispose(openid);
  return view(null);
}
module.exports = { start, code, status, release, sessions, view };
