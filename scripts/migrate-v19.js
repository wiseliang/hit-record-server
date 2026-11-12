const pool=require("../config/database");
async function migrate(){
 const [columns]=await pool.query("SHOW COLUMNS FROM app_sessions LIKE 'refresh_operation_hash'");
 if(!columns.length)await pool.query("ALTER TABLE app_sessions ADD COLUMN refresh_operation_hash CHAR(64) NULL");
 await pool.query("CREATE TABLE IF NOT EXISTS school_account_bindings(account_key CHAR(64) PRIMARY KEY,openid VARCHAR(128) NOT NULL UNIQUE,source VARCHAR(48) NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
 // A saved password is not proof. Backfill only formerly verified school sessions.
 await pool.query("INSERT IGNORE INTO school_account_bindings(account_key,openid,source) SELECT s.account_key,MIN(s.openid),'verified_session_migration' FROM school_login_sessions s JOIN app_accounts a ON a.openid=s.openid WHERE CHAR_LENGTH(s.account_key)=64 GROUP BY s.account_key HAVING COUNT(DISTINCT s.openid)=1");
}
module.exports={migrate};
