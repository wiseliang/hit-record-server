const pool=require('../config/database');
async function migrate(){await pool.query(`CREATE TABLE IF NOT EXISTS academic_reviews(
 id CHAR(36) NOT NULL PRIMARY KEY,openid VARCHAR(128) NOT NULL,account_key CHAR(64) NOT NULL,
 cohort_key CHAR(64) NOT NULL,student_id VARCHAR(64) NOT NULL,from_code VARCHAR(80) NOT NULL,
 to_code VARCHAR(80) NOT NULL DEFAULT '',outcome VARCHAR(16) NOT NULL,reason VARCHAR(500) NOT NULL,
 archive_fingerprint CHAR(64) NOT NULL,active TINYINT NOT NULL DEFAULT 1,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,revoked_at TIMESTAMP NULL,
 KEY owner_cohort(openid,account_key,cohort_key),KEY owner_student(openid,account_key,cohort_key,student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)}
module.exports={migrate};
