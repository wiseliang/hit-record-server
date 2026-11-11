const express = require("express"),
  crypto = require("crypto"),
  axios = require("axios");
const router = express.Router(),
  config = require("../config"),
  identity = require("../services/identity");
const { verifyToken, bearer, tokenClaims } = require("../utils/session");
const { AppError } = require("../utils/errors"),
  { rateLimit } = require("../middleware/rateLimit");
const credential = require("../models/credential"),
  login = require("../services/login"),
  browser = require("../services/browser");
const { pendingLogins } = login,
  { SessionStore } = require("../services/sessionStore");
const {
  requireSchoolSession,
  validSchoolSession,
} = require("../services/schoolSession");
const { syncSchoolCalendar } = require("../services/academicCalendar");
const { getStudentList } = require("../services/navigator");
const qrSessions = new SessionStore({
  ttlMs: 5 * 60000,
  maxAgeMs: 5 * 60000,
  onExpire: (s) => browser.releaseContext(s.slot),
});
const busy = new Set();
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const authLimit = rateLimit({
  max: 12,
  windowMs: 60000,
  key: (req) => "auth:" + req.ip,
});
router.post(
  "/login",
  authLimit,
  asyncRoute(async (req, res) => {
    let openid;
    if (req.body.platform === "android") {
      const token = bearer(req);
      openid = token
        ? verifyToken(token)
        : "android_" + crypto.randomBytes(24).toString("hex");
      if (!openid)
        throw new AppError(
          401,
          "SESSION_RECOVERY_REQUIRED",
          "本机身份需要恢复，请使用恢复码",
        );
      if (token && openid) {
        const claims = tokenClaims(token);
        if (
          (claims?.sid && !(await identity.validSession(claims.sid, openid))) ||
          (!claims?.sid && (await identity.legacyBlocked(openid)))
        )
          throw new AppError(
            401,
            "SESSION_RECOVERY_REQUIRED",
            "该设备身份已撤销，请使用恢复码",
          );
      }
    } else {
      if (!config.wechat.appId || !config.wechat.appSecret)
        throw new AppError(503, "WECHAT_UNAVAILABLE", "微信登录暂未配置");
      const { data } = await axios.get(
        "https://api.weixin.qq.com/sns/jscode2session",
        {
          params: {
            appid: config.wechat.appId,
            secret: config.wechat.appSecret,
            js_code: req.body.code,
            grant_type: "authorization_code",
          },
          timeout: 10000,
        },
      );
      if (!data.openid)
        throw new AppError(401, "WECHAT_LOGIN_FAILED", "微信登录失败，请重试");
      openid = data.openid;
    }
    res.json({
      ...(await identity.openSession(openid)),
      hasCredential: await credential.hasCredential(openid),
    });
  }),
);
router.post(
  "/refresh",
  rateLimit({ max: 30, key: (req) => "refresh:" + req.ip }),
  asyncRoute(async (req, res) =>
    res.json(await identity.refresh(req.body.refreshToken)),
  ),
);
router.post(
  "/recover",
  rateLimit({ max: 5, windowMs: 300000, key: (req) => "recover:" + req.ip }),
  asyncRoute(async (req, res) =>
    res.json(await identity.recover(req.body.recoveryKey)),
  ),
);
router.use(require("../middleware/auth"));
router.use((req, res, next) => {
  Promise.resolve()
    .then(async () => {
      const changing =
        (req.method === "POST" && req.path !== "/recovery-key") ||
        ["/academic-calendar", "/student-list"].includes(req.path);
      if (!changing) return next();
      const pending = pendingLogins.peek(req.openid);
      if (pending?.busyPlan)
        throw new AppError(
          409,
          "SCAN_ACTIVE",
          "当前正在检查记录，请等待完成或先取消检查",
        );
      const active = await require("../models/tasksV12").active(req.openid);
      if (active)
        throw new AppError(
          409,
          "TASK_ACTIVE",
          "当前有录入任务，请先查看并结束它",
          { taskUuid: active.task_uuid },
        );
      next();
    })
    .catch(next);
});
router.post(
  "/recovery-key",
  asyncRoute(async (req, res) =>
    res.json({ recoveryKey: await identity.rotateRecovery(req.openid) }),
  ),
);
router.get(
  "/credential",
  asyncRoute(async (req, res) => {
    const c = await credential.getCredential(req.openid);
    res.json({
      hasCredential: !!c,
      maskedId: c ? c.studentId.replace(/.(?=.{2})/g, "*") : "",
      canEditCalendar: config.auth.adminOpenids.includes(req.openid),
    });
  }),
);
router.post(
  "/credential",
  asyncRoute(async (req, res) => {
    const { studentId, password } = req.body;
    if (
      typeof studentId !== "string" ||
      !studentId.trim() ||
      typeof password !== "string" ||
      !password
    )
      throw new AppError(400, "INVALID_CREDENTIAL", "请填写完整账号和密码");
    await credential.saveCredential(req.openid, studentId.trim(), password);
    res.json({ success: true, message: "已加密保存，学校认证将在登录时验证" });
  }),
);
async function releaseUser(openid) {
  if (pendingLogins.peek(openid)?.busyPlan)
    throw new AppError(409, "SCAN_ACTIVE", "请先结束正在读取或核对的操作");
  const active =
    (await require("../models/tasksV12").active(openid)) ||
    [...require("../services/taskRunner").live.values()].find(
      (x) => x.openid === openid,
    );
  if (active)
    throw new AppError(
      409,
      "TASK_ACTIVE",
      "请先结束当前任务，再断开或切换学校账号",
      { taskUuid: active.task_uuid || active.uuid },
    );
  await Promise.all([
    pendingLogins.dispose(openid),
    qrSessions.dispose(openid),
  ]);
  await require("../services/schoolSession").forget(openid);
}
router.delete(
  "/credential",
  asyncRoute(async (req, res) => {
    const [active] = await require("../config/database").query(
      "SELECT task_uuid FROM tasks WHERE openid=? AND status IN ('queued','running','awaiting_input','pause_requested','paused','cancel_requested') LIMIT 1",
      [req.openid],
    );
    if (active.length)
      throw new AppError(
        409,
        "TASK_ACTIVE",
        "请先结束当前任务，再删除学校凭证",
        { taskUuid: active[0].task_uuid },
      );
    if (busy.has(req.openid))
      throw new AppError(409, "LOGIN_BUSY", "登录处理中，请稍后删除凭证");
    await releaseUser(req.openid);
    await require("../config/database").query(
      "DELETE FROM credentials WHERE openid=?",
      [req.openid],
    );
    res.json({
      success: true,
      message: "服务器凭证与学校会话已清除，历史记录保留",
    });
  }),
);
router.post(
  "/release",
  asyncRoute(async (req, res) => {
    if (busy.has(req.openid))
      throw new AppError(409, "LOGIN_BUSY", "登录请求处理中，请稍后取消");
    await releaseUser(req.openid);
    res.json({ success: true });
  }),
);
async function ready(openid, session) {
  const page = await login.navigateToWorkLog(session.page);
  session.page = page;
  await browser.keepOnly(session.slot, page);
  if (!(await validSchoolSession(page)))
    throw new AppError(401, "SCHOOL_AUTH_REQUIRED", "学校尚未完成登录，请重试");
  session.step = "ready";
  session.calendar = await syncSchoolCalendar(page);
  if (session.remember && session.studentId && session.password)
    await credential.saveCredential(
      openid,
      session.studentId,
      session.password,
    );
  session.password = "";
  session.remember = false;
  qrSessions.delete(openid);
  session._openid = openid;
  session._validatedAt = Date.now();
  session.authExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
  if (typeof page.locator === "function")
    session.profile = await page
      .locator("#headerPageYhxm")
      .innerText({ timeout: 2000 })
      .catch(() => "");
  pendingLogins.set(openid, session);
  await require("../services/schoolSession").persist(openid, session);
  return {
    success: true,
    loggedIn: true,
    step: "ready",
    calendar: session.calendar,
  };
}
function challenge(session, result) {
  if (result.loginFailed)
    throw new AppError(
      401,
      "SCHOOL_LOGIN_FAILED",
      result.message || "学校账号或密码验证失败",
    );
  if (result.needsCaptcha || result.retry) {
    session.step = "captcha";
    session.captchaImage = result.captchaImage;
    return {
      step: "captcha",
      needsCaptcha: true,
      captchaImage: result.captchaImage,
      message: result.message || "请输入图片验证码",
    };
  }
  if (result.needsCode || result.needsMfa) {
    session.step = "mfa";
    return {
      step: "mfa",
      needsCode: true,
      message: "请查看 HIT APP 本次验证码",
    };
  }
  return null;
}
async function exclusive(openid, fn) {
  if (pendingLogins.peek(openid)?.busyPlan)
    throw new AppError(409, "SCAN_ACTIVE", "学校正在处理其他操作，请稍后");
  if (busy.has(openid))
    throw new AppError(409, "LOGIN_BUSY", "登录请求处理中，请稍候");
  busy.add(openid);
  try {
    return await fn();
  } finally {
    busy.delete(openid);
  }
}
router.post(
  "/start-login",
  rateLimit({ max: 6, key: (req) => "school-login:" + req.openid }),
  asyncRoute(async (req, res) =>
    res.json(
      await exclusive(req.openid, async () => {
        const supplied =
          typeof req.body.studentId === "string" &&
          typeof req.body.password === "string" &&
          req.body.password;
        const c = supplied
          ? {
              studentId: req.body.studentId.trim(),
              password: req.body.password,
            }
          : await credential.getCredential(req.openid);
        if (!c || !c.studentId || !c.password)
          throw new AppError(
            400,
            "CREDENTIAL_REQUIRED",
            "请输入学校账号和密码，或改用二维码登录",
          );
        await releaseUser(req.openid);
        const { slot, page } = await browser.acquireContext(),
          session = {
            slot,
            page,
            ...c,
            remember: !!req.body.remember,
            step: "authenticating",
          };
        pendingLogins.set(req.openid, session);
        try {
          const result = await login.startLogin(page, c.studentId, c.password);
          return (
            challenge(session, result) || (await ready(req.openid, session))
          );
        } catch (e) {
          await pendingLogins.dispose(req.openid);
          throw e;
        }
      }),
    ),
  ),
);
router.post(
  "/submit-captcha",
  asyncRoute(async (req, res) =>
    res.json(
      await exclusive(req.openid, async () => {
        const session = pendingLogins.get(req.openid);
        if (!session || session.step !== "captcha")
          throw new AppError(
            409,
            "CHALLENGE_EXPIRED",
            "图片验证码已过期，请重新登录",
          );
        const result = await login.submitCaptcha(
          session.page,
          String(req.body.captcha || ""),
          session.studentId,
          session.password,
        );
        return challenge(session, result) || (await ready(req.openid, session));
      }),
    ),
  ),
);
router.post(
  "/submit-code",
  asyncRoute(async (req, res) =>
    res.json(
      await exclusive(req.openid, async () => {
        const session = pendingLogins.get(req.openid);
        if (!session || session.step !== "mfa")
          throw new AppError(
            409,
            "CHALLENGE_EXPIRED",
            "动态验证码会话已过期，请重新登录",
          );
        await login.submitCode(session.page, String(req.body.code || ""));
        return ready(req.openid, session);
      }),
    ),
  ),
);
router.get(
  "/session-status",
  asyncRoute(async (req, res) =>
    res.json(await require("../services/schoolSession").status(req.openid)),
  ),
);
router.get(
  "/academic-calendar",
  asyncRoute(async (req, res) => {
    const session = await require("../services/schoolSession").getSession(
      req.openid,
    );
    await requireSchoolSession(session);
    session.calendar = await syncSchoolCalendar(session.page);
    res.json(session.calendar);
  }),
);
router.get(
  "/student-list",
  asyncRoute(async (req, res) =>
    res.json(
      await exclusive(req.openid, async () => {
        const session = await require("../services/schoolSession").getSession(
          req.openid,
        );
        await requireSchoolSession(session);
        if (!session.calendar?.verified)
          session.calendar = await syncSchoolCalendar(session.page);
        const week = Number(req.query.week);
        if (!Number.isInteger(week) || week < 1 || week > session.calendar.week)
          throw new AppError(400, "INVALID_WEEK", "请选择学校当前学期内的周次");
        const students = await require("../utils/week").withSemester(
          session.calendar,
          () => getStudentList(session.page, week),
        );
        return {
          students,
          week,
          calendarStartDate: session.calendar.startDate,
        };
      }),
    ),
  ),
);
router.post(
  "/qrcode-start",
  rateLimit({ max: 5, key: (req) => "qr:" + req.openid }),
  asyncRoute(async (req, res) =>
    res.json(
      await exclusive(req.openid, async () => {
        await releaseUser(req.openid);
        const { slot, page } = await browser.acquireContext(),
          session = { slot, page, step: "qr", target: "xuegong" };
        qrSessions.set(req.openid, session);
        try {
          await page.goto(
            "https://ids.hit.edu.cn/authserver/login?service=" +
              encodeURIComponent("https://xuegong.hitwh.edu.cn/cas"),
            { waitUntil: "domcontentloaded", timeout: 25000 },
          );
          if (await validSchoolSession(page)) return ready(req.openid, session);
          if (/reAuth|multifactor/.test(page.url())) {
            session.needsMfa = true;
            session.step = "mfa";
            return { needsMfa: true, step: "mfa", expiresIn: 300 };
          }
          const image = await login.captureQrCode(page);
          if (!image.qrcode)
            throw new AppError(
              502,
              "QR_UNAVAILABLE",
              "暂未获取到二维码，请重试或使用密码登录",
            );
          session.qrcode = image.qrcode;
          return {
            hasQrCode: true,
            qrcode: image.qrcode,
            step: "qr",
            expiresIn: 300,
            message: "请用 HIT APP 扫码；同机可分享图片到支持识别的应用",
          };
        } catch (e) {
          await qrSessions.dispose(req.openid);
          throw e;
        }
      }),
    ),
  ),
);
router.post(
  "/qrcode-wait",
  asyncRoute(async (req, res) =>
    res.json(
      await exclusive(req.openid, async () => {
        const session = qrSessions.get(req.openid);
        if (!session) {
          const p = pendingLogins.get(req.openid);
          if (p?.step === "ready")
            return { loggedIn: true, step: "ready", calendar: p.calendar };
          throw new AppError(409, "QR_EXPIRED", "二维码已过期，请刷新二维码");
        }
        if (/reAuth|multifactor/.test(session.page.url())) {
          session.needsMfa = true;
          session.step = "mfa";
          return { needsMfa: true, step: "mfa" };
        }
        if (!(await validSchoolSession(session.page)))
          return { loggedIn: false, step: "qr" };
        return ready(req.openid, session);
      }),
    ),
  ),
);
router.post(
  "/qrcode-submit-code",
  asyncRoute(async (req, res) =>
    res.json(
      await exclusive(req.openid, async () => {
        const session = qrSessions.get(req.openid);
        if (!session || !session.needsMfa)
          throw new AppError(
            409,
            "CHALLENGE_EXPIRED",
            "扫码验证已过期，请重新获取二维码",
          );
        await login.submitCode(session.page, String(req.body.code || ""));
        return ready(req.openid, session);
      }),
    ),
  ),
);
router.post(
  "/resend-code",
  rateLimit({ max: 1, windowMs: 60000, key: (req) => "resend:" + req.openid }),
  asyncRoute(async (req, res) => {
    const s = pendingLogins.get(req.openid) || qrSessions.get(req.openid);
    if (!s)
      throw new AppError(409, "CHALLENGE_EXPIRED", "验证已过期，请重新登录");
    await s.page.evaluate(() => {
      const b =
        document.getElementById("getDynamicCode") ||
        Array.from(document.querySelectorAll("button")).find(
          (b) =>
            b.offsetParent !== null &&
            /获取验证码|Obtain|Send/.test(b.textContent),
        );
      if (!b) throw Error("验证码按钮暂不可用");
      b.click();
    });
    res.json({ success: true, retryAfter: 60 });
  }),
);
module.exports = router;
module.exports.ready = ready;
module.exports.releaseUser = releaseUser;
module.exports.qrSessions = qrSessions;
module.exports.busy = busy;
