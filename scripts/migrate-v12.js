const pool = require("../config/database");
async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS app_accounts (
    openid VARCHAR(128) PRIMARY KEY, recovery_hash CHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_sessions (
    id VARCHAR(64) PRIMARY KEY, openid VARCHAR(128) NOT NULL,
    refresh_hash CHAR(64) NOT NULL UNIQUE, expires_at DATETIME NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX account_sessions(openid)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS task_operations (
    id VARCHAR(64) PRIMARY KEY, task_uuid VARCHAR(64) NOT NULL,
    student_id VARCHAR(32) NOT NULL, student_name VARCHAR(80) NOT NULL,
    week INT NOT NULL, type VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'planned',
    payload JSON NOT NULL, receipt JSON, reason TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX task_rows(task_uuid), UNIQUE KEY operation_row(task_uuid,student_id,week,type)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS task_plans (
    id VARCHAR(64) PRIMARY KEY, openid VARCHAR(128) NOT NULL, body_hash CHAR(64) NOT NULL,
    payload JSON NOT NULL, expires_at DATETIME NOT NULL, used_by VARCHAR(64),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX user_plans(openid)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS task_user_locks (
    openid VARCHAR(128) PRIMARY KEY, task_uuid VARCHAR(64), updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [accountColumns] = await pool.query("SHOW COLUMNS FROM app_accounts");
  if (!accountColumns.some((c) => c.Field === "legacy_blocked"))
    await pool.query(
      "ALTER TABLE app_accounts ADD COLUMN legacy_blocked BOOLEAN NOT NULL DEFAULT FALSE",
    );
  const [sessionColumns] = await pool.query("SHOW COLUMNS FROM app_sessions");
  for (const [name, type] of Object.entries({
    previous_refresh_hash: "CHAR(64)",
    previous_valid_until: "DATETIME",
    rotated_refresh: "TEXT",
  }))
    if (!sessionColumns.some((c) => c.Field === name))
      await pool.query(`ALTER TABLE app_sessions ADD COLUMN ${name} ${type}`);
  const [columns] = await pool.query("SHOW COLUMNS FROM tasks");
  const known = new Set(columns.map((c) => c.Field));
  for (const [name, definition] of Object.entries({
    request_id: "VARCHAR(80)",
    request_hash: "CHAR(64)",
    heartbeat_at: "DATETIME",
    failure_reason: "TEXT",
    retry_of: "VARCHAR(64)",
  })) {
    if (!known.has(name))
      await pool.query(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
  }
  const [indexes] = await pool.query("SHOW INDEX FROM tasks");
  if (!indexes.some((i) => i.Key_name === "user_request"))
    await pool.query(
      "ALTER TABLE tasks ADD UNIQUE KEY user_request(openid,request_id)",
    );
  await require("./migrate-v13").migrate();
}
if (require.main === module)
  migrate()
    .then(() => {
      console.log("v1.2 additive schema ready");
      return pool.end();
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
      pool.end();
    });
module.exports = { migrate };
