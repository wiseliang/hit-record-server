const {AppError}=require('../utils/errors');
const parse=x=>typeof x==='string'?JSON.parse(x):x;
class RecognitionStore {
 constructor(pool){this.pool=pool;}
 async migrate(){
  await this.pool.query(`CREATE TABLE IF NOT EXISTS recognition_settings (
   subject CHAR(64) PRIMARY KEY,openid VARCHAR(128) NOT NULL,revision BIGINT NOT NULL DEFAULT 1,enabled BOOLEAN NOT NULL DEFAULT FALSE,last_check BIGINT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await this.pool.query(`CREATE TABLE IF NOT EXISTS recognition_consents (
   subject CHAR(64) NOT NULL,student_id VARCHAR(16) NOT NULL,reference VARCHAR(160) NOT NULL,active BOOLEAN NOT NULL,recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
   PRIMARY KEY(subject,student_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await this.pool.query(`CREATE TABLE IF NOT EXISTS recognition_consent_events (
   id CHAR(36) PRIMARY KEY,subject CHAR(64) NOT NULL,openid VARCHAR(128) NOT NULL,student_id VARCHAR(16) NOT NULL,reference VARCHAR(160) NOT NULL,active BOOLEAN NOT NULL,recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX consent_history(subject,student_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await this.pool.query(`CREATE TABLE IF NOT EXISTS recognition_jobs (
   id CHAR(36) PRIMARY KEY,subject CHAR(64) NOT NULL,openid VARCHAR(128) NOT NULL,revision BIGINT NOT NULL,active_key CHAR(64) UNIQUE,status VARCHAR(32) NOT NULL,payload JSON NOT NULL,
   lease_owner CHAR(36),lease_until BIGINT,created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6),updated_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),INDEX owner_jobs(subject,created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await require('../scripts/migrate-v112').preciseJobTimes(this.pool,'recognition_jobs');
 }
 async setting(a){await this.pool.query('INSERT IGNORE INTO recognition_settings(subject,openid) VALUES (?,?)',[a.subject,a.openid]);const [r]=await this.pool.query('SELECT * FROM recognition_settings WHERE subject=? AND openid=?',[a.subject,a.openid]);if(!r[0])throw new AppError(409,'IDENTITY_CHANGED','学校身份关联已变化');return r[0];}
 async consents(subject){const [r]=await this.pool.query('SELECT student_id,reference,active FROM recognition_consents WHERE subject=?',[subject]);return r;}
 async grant(a,items){const c=await this.pool.getConnection();try{await c.beginTransaction();await c.query('SELECT subject FROM recognition_settings WHERE subject=? FOR UPDATE',[a.subject]);for(const x of items){await c.query('INSERT INTO recognition_consents(subject,student_id,reference,active) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE reference=VALUES(reference),active=VALUES(active)',[a.subject,x.studentId,x.reference,x.active?1:0]);await c.query('INSERT INTO recognition_consent_events(id,subject,openid,student_id,reference,active) VALUES (?,?,?,?,?,?)',[require('crypto').randomUUID(),a.subject,a.openid,x.studentId,x.reference,x.active?1:0]);}await c.query('UPDATE recognition_settings SET revision=revision+1 WHERE subject=?',[a.subject]);await c.query("UPDATE recognition_jobs SET status='cancelled',active_key=NULL WHERE subject=? AND active_key IS NOT NULL",[a.subject]);await c.commit();}catch(e){await c.rollback();throw e}finally{c.release()}}
 async configure(a,enabled){await this.pool.query('UPDATE recognition_settings SET enabled=? WHERE subject=?',[enabled?1:0,a.subject]);}
 async latest(subject){const [r]=await this.pool.query('SELECT * FROM recognition_jobs WHERE subject=? ORDER BY created_at DESC,id DESC LIMIT 1',[subject]);return r[0]?{...r[0],payload:parse(r[0].payload)}:null;}
 async job(a,id){const [r]=await this.pool.query('SELECT * FROM recognition_jobs WHERE id=? AND subject=? AND openid=?',[id,a.subject,a.openid]);if(!r[0])throw new AppError(404,'RECOGNITION_JOB_NOT_FOUND','同步任务不存在');return {...r[0],payload:parse(r[0].payload)};}
 async start(a,id,payload){
  const c=await this.pool.getConnection();try{await c.beginTransaction();const [settings]=await c.query('SELECT * FROM recognition_settings WHERE subject=? FOR UPDATE',[a.subject]);const [active]=await c.query('SELECT * FROM recognition_jobs WHERE active_key=?',[a.subject]);if(active[0]){await c.commit();return {...active[0],payload:parse(active[0].payload)}}
   const revision=Number(settings[0].revision)+1;await c.query('UPDATE recognition_settings SET revision=?,last_check=? WHERE subject=?',[revision,Date.now(),a.subject]);
   await c.query("INSERT INTO recognition_jobs(id,subject,openid,revision,active_key,status,payload) VALUES (?,?,?,?,?,'pending',?)",[id,a.subject,a.openid,revision,a.subject,JSON.stringify(payload)]);await c.commit();return this.job(a,id);
  }catch(e){await c.rollback();throw e}finally{c.release()}
 }
 async claim(owner){
  // A crashed request is never blindly repeated; on resume the stable source key resolves any committed person.
  await this.pool.query("UPDATE recognition_jobs SET status='paused',active_key=NULL,lease_owner=NULL WHERE status IN ('running','pause_requested') AND lease_until<?",[Date.now()]);
  const [r]=await this.pool.query("SELECT * FROM recognition_jobs WHERE status='pending' ORDER BY created_at LIMIT 1");if(!r[0])return null;
  const [u]=await this.pool.query("UPDATE recognition_jobs SET status='running',lease_owner=?,lease_until=? WHERE id=? AND status='pending'",[owner,Date.now()+300000,r[0].id]);return u.affectedRows?{...r[0],status:'running',lease_owner:owner,payload:parse(r[0].payload)}:null;
 }
 async save(job,payload,status='running'){
  const [changed]=await this.pool.query("UPDATE recognition_jobs SET status=IF(status='pause_requested' AND ?='running','paused',?),payload=?,lease_until=?,active_key=IF(status='running',active_key,NULL) WHERE id=? AND lease_owner=? AND status IN ('running','pause_requested')",[status,status,JSON.stringify(payload),Date.now()+300000,job.id,job.lease_owner]);
  if(!changed.affectedRows)throw new AppError(409,'SYNC_CANCELLED','同步任务状态已变化');
  const [rows]=await this.pool.query('SELECT status FROM recognition_jobs WHERE id=?',[job.id]);return rows[0].status;
 }
 async pause(a,id){await this.job(a,id);await this.pool.query("UPDATE recognition_jobs SET status=IF(status='pending','paused','pause_requested'),active_key=IF(status='paused',NULL,active_key) WHERE id=? AND status IN ('pending','running')",[id]);return this.job(a,id);}
 async resume(a,id){const j=await this.job(a,id);if(!['paused','partial','failed','awaiting_auth','awaiting_setup'].includes(j.status))throw new AppError(409,'SYNC_BUSY','该任务不能继续');
  const c=await this.pool.getConnection();try{await c.beginTransaction();const [s]=await c.query('SELECT revision FROM recognition_settings WHERE subject=? FOR UPDATE',[a.subject]);if(Number(s[0].revision)!==Number(j.revision))throw new AppError(409,'SCOPE_CHANGED','授权或名单任务已变化，请新建同步');await c.query("UPDATE recognition_jobs SET status='pending',active_key=?,lease_owner=NULL WHERE id=? AND status=?",[a.subject,id,j.status]);await c.commit();}catch(e){await c.rollback();if(e.code==='ER_DUP_ENTRY')throw new AppError(409,'SYNC_BUSY','已有运行中的同步任务');throw e}finally{c.release()}return this.job(a,id);
 }
}
module.exports={RecognitionStore};
