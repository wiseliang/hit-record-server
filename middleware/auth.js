const { verifyToken, bearer, tokenClaims } = require("../utils/session");
module.exports = async function authMiddleware(req, res, next) {
  try {
    const openid = verifyToken(bearer(req));
    if (!openid)
      return res.status(401).json({
        code: "AUTH_REQUIRED",
        error: "登录已失效，请恢复登录",
        retryable: false,
      });
    const claims = tokenClaims(bearer(req));
    if (
      (claims?.sid &&
        !(await require("../services/identity").validSession(
          claims.sid,
          openid,
        ))) ||
      (!claims?.sid &&
        (await require("../services/identity").legacyBlocked(openid)))
    )
      return res.status(401).json({
        code: "AUTH_REQUIRED",
        error: "登录已失效，请恢复登录",
        retryable: false,
      });
    req.openid = openid;
    // Existing route handlers may read identity from any of these locations.
    // Reject attempts to override it, then supply only the verified identity.
    for (const value of [
      req.headers["x-openid"],
      req.query.openid,
      req.body?.openid,
    ]) {
      if (value && value !== openid)
        return res.status(403).json({ error: "用户身份不匹配" });
    }
    req.headers["x-openid"] = openid;
    req.query.openid = openid;
    if (req.body && typeof req.body === "object") req.body.openid = openid;
    next();
  } catch (e) {
    next(e);
  }
};
