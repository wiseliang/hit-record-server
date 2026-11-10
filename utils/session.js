const crypto = require('crypto')
const config = require('../config')

function secret() {
  const key = config.auth.secret
  if (!key || Buffer.byteLength(key) < 32) throw new Error('AUTH_SECRET must contain at least 32 bytes')
  return key
}
function issueToken(openid) {
  const payload = Buffer.from(JSON.stringify({ sub: openid, exp: Math.floor(Date.now()/1000) + 30*86400 })).toString('base64url')
  const signature = crypto.createHmac('sha256', secret()).update(payload).digest('base64url')
  return payload + '.' + signature
}
function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 2048) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const expected = crypto.createHmac('sha256', secret()).update(parts[0]).digest()
  const actual = Buffer.from(parts[1], 'base64url')
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    return typeof data.sub === 'string' && data.sub && Number.isFinite(data.exp) && data.exp > Date.now()/1000 ? data.sub : null
  } catch (_) { return null }
}
function bearer(req) {
  const match = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')
  return match ? match[1] : null
}
module.exports = { issueToken, verifyToken, bearer }
