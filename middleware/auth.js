const { verifyToken, bearer } = require('../utils/session')
module.exports = function authMiddleware(req, res, next) {
  try {
    const openid = verifyToken(bearer(req))
    if (!openid) return res.status(401).json({ error: '登录已失效，请重新登录' })
    req.openid = openid
    // Existing route handlers may read identity from any of these locations.
    // Reject attempts to override it, then supply only the verified identity.
    for (const value of [req.headers['x-openid'], req.query.openid, req.body?.openid]) {
      if (value && value !== openid) return res.status(403).json({ error: '用户身份不匹配' })
    }
    req.headers['x-openid'] = openid
    req.query.openid = openid
    if (req.body && typeof req.body === 'object') req.body.openid = openid
    next()
  } catch (e) { next(e) }
}
