const pool=require('../config/database');
async function migrate(){await pool.query(`CREATE TABLE IF NOT EXISTS school_device_states(
 openid VARCHAR(128) NOT NULL,account_key CHAR(64) NOT NULL,state_encrypted MEDIUMTEXT NOT NULL,
 expires_at DATETIME NOT NULL,validated_at DATETIME NOT NULL,trust_selected_at DATETIME NULL,
 PRIMARY KEY(openid,account_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)}
module.exports={migrate};
