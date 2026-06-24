const mysql = require('mysql2/promise')
const config = require('./index')

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 3,          // 2核2G优化：10→3，每连接 ~4-10MB
  queueLimit: 5,               // 最多排队 5 个请求
  charset: 'utf8mb4',
  connectTimeout: 5000,        // 连接超时 5s，快速失败避免堆积
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000 // 10s keepalive 减少重连开销
})

module.exports = pool
