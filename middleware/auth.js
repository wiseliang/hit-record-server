module.exports = function authMiddleware(req, res, next) {
  const openid = req.headers['x-openid'] || req.query.openid || req.body.openid
  if (!openid) {
    return res.status(401).json({ error: '未登录，请先授权' })
  }
  req.openid = openid
  next()
}
