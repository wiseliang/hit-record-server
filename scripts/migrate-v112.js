const pool=require('../config/database');
async function preciseJobTimes(db,table){
 const [columns]=await db.query('SHOW COLUMNS FROM '+table);
 for(const name of ['created_at','updated_at']){
  const c=columns.find(x=>x.Field===name);if(!c||/\(6\)/.test(c.Type))continue;
  await db.query('ALTER TABLE '+table+' MODIFY '+name+' '+(c.Type.startsWith('datetime')?'DATETIME(6)':'TIMESTAMP(6)')+' NOT NULL DEFAULT CURRENT_TIMESTAMP(6)'+(name==='updated_at'?' ON UPDATE CURRENT_TIMESTAMP(6)':''));
 }
}
async function migrate(){for(const table of ['academic_jobs','academic_photo_jobs','academic_photo_exports'])await preciseJobTimes(pool,table);}
module.exports={migrate,preciseJobTimes};
