const pool=require('../config/database'),access=require('./academicAccess'),d=require('./academicDashboard'),grades=require('./academicGrades'),{AppError}=require('../utils/errors'),{encrypt,decrypt}=require('../utils/crypto'),{randomUUID,createHash}=require('crypto');
const parse=v=>typeof v==='string'?JSON.parse(v):v,busy=new Map();
const args=a=>[a.openid,a.accountKey];
async function ownStudents(openid){const first=await d.dashboard(openid,{limit:100}),out=[...first.students];while(out.length<first.total){const next=await d.dashboard(openid,{offset:out.length,limit:100});if(!next.students.length)break;out.push(...next.students)}return out}
async function allowed(openid,id){if(typeof id!=='string'||!/^\d{8,16}$/.test(id))throw new AppError(400,'INVALID_STUDENT_ID','学生学号格式无效');const a=await grades.actor(openid),saved=await d.managedRoster(a),ids=d.memberSet(saved);if(ids?!ids.has(id):!(await d.dashboard(openid,{q:id,limit:5})).students.some(x=>x.studentId===id))throw new AppError(404,'ACADEMIC_STUDENT_NOT_FOUND','该生不在你当前所带名单中');return a}
function photoMime(bytes){if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';if(bytes.length>8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';return null}
function verifyDetail(html,id){const m=html.match(/var\s+xh\s*=\s*new String\(\s*["']?(\d+)["']?\s*\)/);return m?.[1]===id&&/id=["']zhaopian["']/.test(html)&&html.includes('/xswhxx/showPhoto1?xh=')}
async function fetchPhoto(s,id){
 const detail=await s.page.request.get(access.ORIGIN+'/pub/queryXsxxView?xh='+encodeURIComponent(id),{timeout:15000,maxRedirects:0});
 if(detail.status()>=300&&detail.status()<400)throw new AppError(409,'ACADEMIC_AUTH_REQUIRED','教务连接过期，请重新连接后继续保存照片');
 if(!detail.ok())throw new AppError(502,'ACADEMIC_PHOTO_UNAVAILABLE','学校学生详情暂不可读');const html=await detail.text();
 if(/id=["'](?:password|dynamicCode)["']/.test(html))throw new AppError(409,'ACADEMIC_AUTH_REQUIRED','教务需要重新认证，请连接后继续保存照片');
 if(!verifyDetail(html,id))throw new AppError(502,'ACADEMIC_PHOTO_ID_MISMATCH','未能核对学生详情的学号和照片入口，未保存照片');
 const response=await s.page.request.get(access.ORIGIN+'/xswhxx/showPhoto1?xh='+encodeURIComponent(Buffer.from(id).toString('base64')),{timeout:15000,maxRedirects:0});
 if(response.status()>=300&&response.status()<400)throw new AppError(409,'ACADEMIC_AUTH_REQUIRED','教务连接过期，请重新连接后继续保存照片');
 const bytes=await response.body(),mime=photoMime(bytes);
 if(!response.ok()||!mime||bytes.length<256||bytes.length>2*1024*1024)throw new AppError(502,'ACADEMIC_PHOTO_INVALID','学校未返回可保存的有效照片，保留原有照片');
 return {bytes,mime,sha256:createHash('sha256').update(bytes).digest('hex')};
}
async function store(a,id,photo){await pool.query('INSERT INTO academic_student_photos(openid,account_key,student_id,mime,bytes,sha256,encrypted_photo,checked_at) VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE mime=VALUES(mime),bytes=VALUES(bytes),sha256=VALUES(sha256),encrypted_photo=VALUES(encrypted_photo),checked_at=VALUES(checked_at)',[...args(a),id,photo.mime,photo.bytes.length,photo.sha256,encrypt(photo.bytes.toString('base64'))])}
async function view(openid,id){const a=await allowed(openid,id),[rows]=await pool.query('SELECT mime,sha256,checked_at,encrypted_photo FROM academic_student_photos WHERE openid=? AND account_key=? AND student_id=?',[...args(a),id]);return rows[0]?{available:true,mime:rows[0].mime,checkedAt:rows[0].checked_at,imageData:'data:'+rows[0].mime+';base64,'+decrypt(rows[0].encrypted_photo)}:{available:false}}
async function saveOne(openid,id){const a=await allowed(openid,id);await access.withSession(openid,async s=>store(a,id,await fetchPhoto(s,id)));return view(openid,id)}
async function jobView(a,id){const [rows]=await pool.query('SELECT id,status,payload,updated_at FROM academic_photo_jobs WHERE id=? AND openid=? AND account_key=?',[id,...args(a)]);if(!rows.length)throw new AppError(404,'PHOTO_JOB_NOT_FOUND','照片任务不存在');return {...rows[0],payload:parse(rows[0].payload)}}
async function update(a,id,status,payload,finish=false){await pool.query("UPDATE academic_photo_jobs SET status=IF(status='pause_requested' AND ?=0,status,?),payload=?,active_key=IF(?,NULL,active_key) WHERE id=? AND openid=? AND account_key=?",[finish?1:0,status,JSON.stringify(payload),finish?1:0,id,...args(a)])}
async function run(a,id){let payload;try{payload=(await jobView(a,id)).payload;await update(a,id,'running',payload);
 await access.withSession(a.openid,async s=>{
  const students=await ownStudents(a.openid),ids=new Set(students.map(x=>x.studentId));if(!ids.size)throw new AppError(400,'MANAGED_REQUIRED','没有可保存照片的所带学生，请先匹配名单');
  if(payload.skipExisting){const [existing]=await pool.query('SELECT student_id FROM academic_student_photos WHERE openid=? AND account_key=?',args(a));payload.done=[...new Set([...(payload.done||[]),...existing.filter(x=>ids.has(x.student_id)).map(x=>x.student_id)])]}
  payload.total=students.length;payload.done=(payload.done||[]).filter(x=>ids.has(x));payload.success=payload.done.length;payload.failures=[];
  let consecutiveNetworkErrors=0;
  for(const student of students){
   const latest=await jobView(a,id);if(latest.status==='pause_requested'){payload.current=null;await update(a,id,'paused',payload,true);return}
   if((await access.identity(a.openid)).accountKey!==a.accountKey)throw new AppError(409,'SCHOOL_ACCOUNT_CHANGED','学校账号变化，照片任务已停止');
   if(payload.done.includes(student.studentId))continue;payload.current=student.studentId;await update(a,id,'running',payload);
   try{await store(a,student.studentId,await fetchPhoto(s,student.studentId));payload.done.push(student.studentId);payload.success++;consecutiveNetworkErrors=0}catch(e){if(e.code==='ACADEMIC_AUTH_REQUIRED')throw e;payload.failures.push({studentId:student.studentId,message:e instanceof AppError?e.message:'照片读取失败，可恢复重试'});if(!(e instanceof AppError)&&++consecutiveNetworkErrors>=3)throw new AppError(503,'PHOTO_RETRY_LATER','学校照片服务连续未响应，任务已暂停；可稍后从已保存进度继续')}
   await update(a,id,'running',payload);await new Promise(r=>setTimeout(r,250));
  }
  payload.current=null;await update(a,id,payload.failures.length?'partial':'completed',payload,true);
 });
 }catch(e){payload??={};payload.current=null;payload.errorCode=e.code||'PHOTO_SAVE_FAILED';payload.message=e instanceof AppError?e.message:'照片保存中断，可恢复重试';await update(a,id,['ACADEMIC_AUTH_REQUIRED','PHOTO_RETRY_LATER'].includes(e.code)?'paused':'failed',payload,true).catch(()=>{})}}
async function start(openid,body={}){const a=await grades.actor(openid),status=await access.status(openid);if(!status.connected)throw new AppError(409,'ACADEMIC_AUTH_REQUIRED','请先连接教务');if(status.busy)throw new AppError(409,'ACADEMIC_BUSY','教务正在处理任务，请稍后保存照片');const id=body.resumeId||randomUUID();let payload={total:0,success:0,done:[],failures:[],skipExisting:body.skipExisting===true};
 if(body.resumeId){const old=await jobView(a,id);if(!['paused','partial','failed'].includes(old.status))throw new AppError(409,'PHOTO_BUSY','该照片任务仍在运行或已经完成');payload=old.payload;delete payload.message}
 try{if(body.resumeId){const [changed]=await pool.query("UPDATE academic_photo_jobs SET status='pending',active_key=?,payload=? WHERE id=? AND openid=? AND account_key=? AND active_key IS NULL AND status IN ('paused','partial','failed')",[require('./gradeAnalysis').digest(args(a)),JSON.stringify(payload),id,...args(a)]);if(!changed.affectedRows)throw new AppError(409,'PHOTO_BUSY','照片任务已变化，请刷新')}
 else await pool.query("INSERT INTO academic_photo_jobs(id,openid,account_key,active_key,status,payload) VALUES (?,?,?,?,'pending',?)",[id,...args(a),require('./gradeAnalysis').digest(args(a)),JSON.stringify(payload)]);
 }catch(e){if(e.code==='ER_DUP_ENTRY')throw new AppError(409,'PHOTO_BUSY','已有照片保存任务，请查看进度');throw e}
 if(!busy.has(id)){const task=run(a,id).finally(()=>busy.delete(id));busy.set(id,task)}return jobView(a,id)}
async function pause(openid,id){const a=await grades.actor(openid);await jobView(a,id);await pool.query("UPDATE academic_photo_jobs SET status='pause_requested' WHERE id=? AND openid=? AND account_key=? AND status IN ('pending','running')",[id,...args(a)]);return jobView(a,id)}
async function state(openid){const a=await grades.actor(openid),students=await ownStudents(openid),ids=new Set(students.map(x=>x.studentId)),[rows]=await pool.query('SELECT student_id,sha256 FROM academic_student_photos WHERE openid=? AND account_key=?',args(a)),saved=rows.filter(x=>ids.has(x.student_id)),[jobs]=await pool.query('SELECT id FROM academic_photo_jobs WHERE openid=? AND account_key=? ORDER BY created_at DESC LIMIT 1',args(a));const hashes=new Map();for(const p of saved)hashes.set(p.sha256,(hashes.get(p.sha256)||0)+1);return {total:ids.size,saved:saved.length,missing:ids.size-saved.length,duplicateImages:[...hashes.values()].filter(n=>n>1).reduce((n,x)=>n+x,0),job:jobs.length?await jobView(a,jobs[0].id):null}}
async function recover(){await pool.query("UPDATE academic_photo_jobs SET status='paused',active_key=NULL WHERE active_key IS NOT NULL")}
module.exports={fetchPhoto,photoMime,verifyDetail,view,saveOne,start,pause,state,jobView,recover,busy};
