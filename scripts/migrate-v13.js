const pool = require("../config/database");
async function migrate() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS worklog_snapshots(id VARCHAR(64) PRIMARY KEY,openid VARCHAR(128) NOT NULL,payload JSON NOT NULL,expires_at DATETIME NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX owner_snapshot(openid)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
  const [columns] = await pool.query("SHOW COLUMNS FROM task_operations");
  if (!columns.some((c) => c.Field === "occurrence"))
    await pool.query(
      "ALTER TABLE task_operations ADD COLUMN occurrence INT NOT NULL DEFAULT 1",
    );
  const [indexes] = await pool.query("SHOW INDEX FROM task_operations");
  if (!indexes.some((i) => i.Key_name === "operation_occurrence"))
    await pool.query(
      "ALTER TABLE task_operations ADD UNIQUE KEY operation_occurrence(task_uuid,student_id,week,type,occurrence)",
    );
  if (indexes.some((i) => i.Key_name === "operation_row"))
    await pool.query("ALTER TABLE task_operations DROP INDEX operation_row");
}
module.exports = { migrate };
