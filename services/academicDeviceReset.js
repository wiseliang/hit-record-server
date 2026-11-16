async function forget(openid){
 const access=require('./academicAccess'),school=require('./schoolSession'),{pendingLogins}=require('./login');
 const academic=access.sessions.peek(openid),session=pendingLogins.peek(openid);
 if(academic?.busy||academic?.busyPlan||session?.busyPlan||(session&&session.step!=='ready'))throw new (require('../utils/errors').AppError)(409,'ACADEMIC_BUSY','请等待当前查询或认证结束，再清除登录信息');
 if(await require('../models/tasksV12').active(openid))throw new (require('../utils/errors').AppError)(409,'TASK_ACTIVE','请先结束当前任务，再清除登录信息');
 const pool=require('../config/database');
 for(const table of ['academic_jobs','academic_photo_jobs','academic_photo_exports','recognition_jobs']){
  const [rows]=await pool.query("SELECT COUNT(*) AS n FROM "+table+" WHERE openid=? AND status IN ('pending','running','downloading','writing','pause_requested')",[openid]);
  if(Number(rows[0]?.n))throw new (require('../utils/errors').AppError)(409,'ACADEMIC_BUSY','请先暂停当前同步或导出任务，再清除登录信息');
 }
 await access.release(openid);await pendingLogins.dispose(openid);await school.forget(openid);await require('./schoolDeviceState').store().forget(openid);
 return {cleared:true,message:'已清除长期登录信息并断开学校及教务连接，已保存成绩和照片保留'};
}
module.exports={forget};
