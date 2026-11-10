const pool = require("../config/database");
async function migrate() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS school_login_sessions(openid VARCHAR(128) PRIMARY KEY,state_encrypted MEDIUMTEXT NOT NULL,calendar JSON,profile VARCHAR(120),expires_at DATETIME NOT NULL,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS academic_snapshots(id VARCHAR(64) PRIMARY KEY,openid VARCHAR(128) NOT NULL,payload JSON NOT NULL,expires_at DATETIME NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX academic_owner(openid)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
}
module.exports = { migrate };
