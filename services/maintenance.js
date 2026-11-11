const pool = require("../config/database");
async function cleanup() {
  const result = {};
  for (const table of [
    "academic_snapshots",
    "worklog_snapshots",
    "overview_snapshots",
    "task_plans",
  ]) {
    const extra = table === "task_plans" ? " AND used_by IS NULL" : "";
    const [r] = await pool.query(
      `DELETE FROM ${table} WHERE expires_at<UTC_TIMESTAMP() AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.state'))<>'scanning'${extra} LIMIT 500`,
    );
    result[table] = r.affectedRows;
  }
  const [sessions] = await pool.query(
    "DELETE FROM app_sessions WHERE expires_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 7 DAY) LIMIT 500",
  );
  result.expiredSessions = sessions.affectedRows;
  return result;
}
module.exports = { cleanup };
