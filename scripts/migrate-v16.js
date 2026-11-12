const pool = require("../config/database");
async function migrate() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS overview_partitions(snapshot_id VARCHAR(64) NOT NULL,week INT NOT NULL,payload JSON NOT NULL,PRIMARY KEY(snapshot_id,week),FOREIGN KEY(snapshot_id) REFERENCES overview_snapshots(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  );
  const [columns] = await pool.query(
    "SHOW COLUMNS FROM school_login_sessions LIKE 'account_key'",
  );
  if (!columns.length)
    await pool.query(
      "ALTER TABLE school_login_sessions ADD COLUMN account_key VARCHAR(64) NULL",
    );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS school_form_options(openid VARCHAR(128) PRIMARY KEY,connection_id VARCHAR(64) NOT NULL,payload JSON NOT NULL,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  );
  await require("./migrate-v18").migrate();
}
module.exports = { migrate };
