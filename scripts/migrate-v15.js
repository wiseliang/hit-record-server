const pool = require("../config/database");
async function migrate() {
  const [columns] = await pool.query(
    "SHOW COLUMNS FROM school_login_sessions LIKE 'connection_id'",
  );
  if (!columns.length)
    await pool.query(
      "ALTER TABLE school_login_sessions ADD COLUMN connection_id VARCHAR(64) NULL",
    );
  await pool.query(
    "UPDATE school_login_sessions SET connection_id=UUID() WHERE connection_id IS NULL",
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS overview_snapshots(id VARCHAR(64) PRIMARY KEY,openid VARCHAR(128) NOT NULL,connection_id VARCHAR(64) NOT NULL,kind VARCHAR(20) NOT NULL,payload JSON NOT NULL,expires_at DATETIME NOT NULL,created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6),INDEX overview_owner(openid,kind,created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
  await require("./migrate-v16").migrate();
  const [created] = await pool.query(
    "SHOW COLUMNS FROM overview_snapshots LIKE 'created_at'",
  );
  if (created[0]?.Type !== "timestamp(6)")
    await pool.query(
      "ALTER TABLE overview_snapshots MODIFY created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)",
    );
}
module.exports = { migrate };
