const { AppError } = require("../utils/errors");
async function validSchoolSession(page) {
  try {
    if (!page || page.isClosed()) return false;
    const u = new URL(page.url());
    if (
      u.hostname !== "xuegong.hitwh.edu.cn" ||
      /login|authserver|\/cas/i.test(u.pathname)
    )
      return false;
    const response = await page.request.post(
      "https://xuegong.hitwh.edu.cn/zhxy-xgzs/xg_fdygzrz/rzgl/getXsList",
      { timeout: 10000 },
    );
    if (!response.ok()) return false;
    const body = await response.json();
    return body.isSuccess === true && Array.isArray(body.module);
  } catch {
    return false;
  }
}
async function requireSchoolSession(session) {
  if (
    !session ||
    session.step !== "ready" ||
    !(await validSchoolSession(session.page))
  )
    throw new AppError(
      401,
      "SCHOOL_AUTH_REQUIRED",
      "学校登录已过期，请重新验证",
    );
}
module.exports = { validSchoolSession, requireSchoolSession };
