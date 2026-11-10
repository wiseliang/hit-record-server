const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

module.exports = {
  port: process.env.PORT || 3000,
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hit_record'
  },
  encryption: {
    key: process.env.ENCRYPTION_KEY || 'hit-record-default-key-32chr!',
    algorithm: 'aes-256-cbc'
  },
  auth: { secret: process.env.AUTH_SECRET || '', adminOpenids: (process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean) },
  wechat: {
    appId: process.env.WX_APPID || '',
    appSecret: process.env.WX_APPSECRET || ''
  }
}
