const pool = require("../config/database");
async function migrate() {
  for (const sql of [
    "CREATE TABLE IF NOT EXISTS academic_profiles(openid VARCHAR(128) NOT NULL,account_key CHAR(64) NOT NULL,revision INT NOT NULL DEFAULT 1,payload JSON NOT NULL,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,PRIMARY KEY(openid,account_key))",
    "CREATE TABLE IF NOT EXISTS academic_rosters(openid VARCHAR(128) NOT NULL,account_key CHAR(64) NOT NULL,cohort_key CHAR(64) NOT NULL,payload JSON NOT NULL,checked_at DATETIME NOT NULL,PRIMARY KEY(openid,account_key,cohort_key))",
    "CREATE TABLE IF NOT EXISTS academic_archives(openid VARCHAR(128) NOT NULL,account_key CHAR(64) NOT NULL,cohort_key CHAR(64) NOT NULL,student_id VARCHAR(32) NOT NULL,payload JSON NOT NULL,checked_at DATETIME NOT NULL,PRIMARY KEY(openid,account_key,cohort_key,student_id))",
    "CREATE TABLE IF NOT EXISTS academic_links(id CHAR(36) PRIMARY KEY,openid VARCHAR(128) NOT NULL,account_key CHAR(64) NOT NULL,cohort_key CHAR(64) NOT NULL,student_id VARCHAR(32) NOT NULL DEFAULT '*',from_code VARCHAR(80) NOT NULL,to_code VARCHAR(80) NOT NULL,reason VARCHAR(500) NOT NULL,active TINYINT NOT NULL DEFAULT 1,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,revoked_at DATETIME NULL,INDEX actor(openid,account_key,cohort_key))",
    "CREATE TABLE IF NOT EXISTS academic_jobs(id CHAR(36) PRIMARY KEY,openid VARCHAR(128) NOT NULL,account_key CHAR(64) NOT NULL,active_key CHAR(64) NULL UNIQUE,status VARCHAR(24) NOT NULL,payload JSON NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,INDEX actor(openid,account_key,created_at))",
    "CREATE TABLE IF NOT EXISTS academic_sessions(openid VARCHAR(128) NOT NULL,account_key CHAR(64) NOT NULL,state_encrypted MEDIUMTEXT NOT NULL,expires_at DATETIME NOT NULL,PRIMARY KEY(openid,account_key))",
  ]) await pool.query(sql + " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
  await require("./migrate-v19").migrate();
}
module.exports = { migrate };
if (require.main === module) migrate().then(()=>pool.end()).catch(e=>{console.error(e.code||e.name);process.exitCode=1;pool.end()});
