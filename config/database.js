const mysql = require("mysql2/promise");
const config = require("./index");

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 8, // Short queries only; workers do not hold connections
  queueLimit: 40, // Bound queued database requests
  charset: "utf8mb4",
  connectTimeout: 5000, // 连接超时 5s，快速失败避免堆积
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000, // 10s keepalive 减少重连开销
});

module.exports = pool;
