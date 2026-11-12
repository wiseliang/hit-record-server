const fs=require('fs/promises'),path=require('path'),pool=require('../config/database'),photos=require('./academicPhotos'),d=require('./academicDashboard'),grades=require('./academicGrades'),access=require('./academicAccess'),{AppError}=require('../utils/errors'),{digest}=require('./gradeAnalysis'),{decrypt}=require('../utils/crypto'),{randomUUID,createHash}=require('crypto'),{execFile}=require('child_process'),{promisify}=require('util');
const execute=promisify(execFile),parse=x=>typeof x==='string'?JSON.parse(x):x,busy=new Map(),active=['pending','downloading','writing','pause_requested'];
const args=a=>[a.openid,a.accountKey];
function root(){return path.resolve(process.env.PHOTO_EXPORT_ROOT||path.join(__dirname,'../.data/photo-exports'))}
function ownerRoot(a){return path.join(root(),digest(args(a)).slice(0,24))}
function location(a,id,revision){if(!/^[a-f0-9-]{36}$/.test(id)||!Number.isInteger(revision)||revision<1||revision>1000)throw new AppError(400,'INVALID_EXPORT_PATH','导出文件位置无效');return path.join(ownerRoot(a),id,'版本'+revision)}
async function currentStudents(openid){let first=await d.dashboard(openid,{limit:100}),students=[...first.students];while(students.length<first.total){const next=await d.dashboard(openid,{offset:students.length,limit:100});if(!next.students.length)throw new AppError(502,'EXPORT_ROSTER_INCOMPLETE','所带名单分页不完整，请刷新名单后重试');students.push(...next.students)}return students}
function makeRows(students){const seen=new Set();return students.map(s=>{if(!/^\d{8,16}$/.test(s.studentId)||seen.has(s.studentId)||!s.name)throw new AppError(502,'EXPORT_ROSTER_INVALID','所带名单学号、姓名异常，未生成导出');seen.add(s.studentId);const label=String(s.className||'');return {studentId:s.studentId,name:s.name,className:label,year:String(s.year||''),school:'哈尔滨工业大学（威海）',major:String(s.major||''),classNumber:String(s.classNumber||(/^[A-Za-z0-9_-]{3,32}$/.test(label)?label:''))}}).sort((a,b)=>a.className.localeCompare(b.className)||a.studentId.localeCompare(b.studentId))}
async function internal(a,id){if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw new AppError(400,'INVALID_EXPORT_ID','导出任务编号无效');const [r]=await pool.query('SELECT * FROM academic_photo_exports WHERE id=? AND openid=? AND account_key=?',[id,...args(a)]);if(!r.length)throw new AppError(404,'PHOTO_EXPORT_NOT_FOUND','照片导出任务不存在');return {...r[0],payload:parse(r[0].payload)}}
function publicView(a,job){const p=job.payload,ready=!!p.outputRevision&&['completed','partial'].includes(job.status);return {id:job.id,status:job.status,total:p.rows.length,saved:p.saved||0,missing:p.missing??p.rows.length,revision:p.revision,ruleVersion:'student-template-v2-8-columns',message:p.message||'',photoJobId:p.photoJobId||null,ready,folder:ready?location(a,job.id,p.outputRevision):null,downloadPath:ready?'/api/academic-grades/photo-exports/'+job.id+'/download':null,createdAt:job.created_at,updatedAt:job.updated_at}}
async function update(a,id,status,p,finish=false){await pool.query('UPDATE academic_photo_exports SET status=?,payload=?,active_key=IF(?,NULL,active_key) WHERE id=? AND openid=? AND account_key=?',[status,JSON.stringify(p),finish?1:0,id,...args(a)])}
async function unchanged(a,p){if((await grades.actor(a.openid)).accountKey!==a.accountKey)throw new AppError(409,'SCHOOL_ACCOUNT_CHANGED','学校账号已变化，请使用当前账号重新导出');const ids=d.memberSet(await d.managedRoster(a));if(!ids)throw new AppError(400,'MANAGED_REQUIRED','请先匹配学工所带学生名单');if(ids.size!==p.rows.length||p.rows.some(x=>!ids.has(x.studentId)))throw new AppError(409,'EXPORT_SCOPE_CHANGED','所带名单已变化，请新建导出任务，避免混入其他学生')}
async function cached(a,p){const [all]=await pool.query('SELECT student_id FROM academic_student_photos WHERE openid=? AND account_key=?',args(a));const ids=new Set(all.map(x=>x.student_id));return p.rows.filter(x=>ids.has(x.studentId)).length}
async function paused(a,id,p){const status=(await internal(a,id)).status;if(status!=='pause_requested')return false;if(p.ownsPhotoJob&&p.photoJobId){const j=await photos.jobView(a,p.photoJobId);if(['pending','running','pause_requested'].includes(j.status))await photos.pause(a.openid,p.photoJobId)}p.message='导出已暂停，已保存的照片保留，可继续';await update(a,id,'paused',p,true);return true}
async function build(a,id,p){
 await unchanged(a,p);const target=location(a,id,p.revision),working=target+'.working';
 await fs.mkdir(path.join(working,'照片'),{recursive:true,mode:0o700});for(const dir of [root(),ownerRoot(a),path.dirname(target),working,path.join(working,'照片')])await fs.chmod(dir,0o700);
 const rows=[];
 for(const person of p.rows){const [saved]=await pool.query('SELECT mime,sha256,encrypted_photo FROM academic_student_photos WHERE openid=? AND account_key=? AND student_id=?',[...args(a),person.studentId]);if(!saved.length){rows.push({...person,photos:[],reason:'照片尚未成功保存，请连接教务后继续导出'});continue}
  const image=saved[0],bytes=Buffer.from(decrypt(image.encrypted_photo),'base64');if(createHash('sha256').update(bytes).digest('hex')!==image.sha256||photos.photoMime(bytes)!==image.mime)throw new AppError(502,'EXPORT_PHOTO_CORRUPT','已有照片校验失败，请重新保存照片后再导出');
  const filename=person.studentId+(image.mime==='image/jpeg'?'.jpg':'.png');await fs.writeFile(path.join(working,'照片',filename),bytes,{mode:0o600});rows.push({...person,photos:[{filename,sha256:image.sha256}]});
 }
 const manifest=path.join(working,'.build-manifest.json');await fs.writeFile(manifest,JSON.stringify({rows,exportedAt:new Date().toISOString()}),{mode:0o600});
 await execute(process.env.PHOTO_EXPORT_PYTHON||'/usr/bin/python3',[path.resolve(__dirname,'../scripts/build-photo-export.py'),'--manifest',manifest,'--template',path.resolve(__dirname,'../assets/student-photo-template-v2.xlsx'),'--folder',working],{timeout:45000,maxBuffer:100000});
 await fs.unlink(manifest);await unchanged(a,p);if(await paused(a,id,p)){await fs.rm(working,{recursive:true,force:true});return}
 const report=JSON.parse(await fs.readFile(path.join(working,'校验清单.json'),'utf8'));await fs.rename(working,target);p.saved=report.exportedStudents;p.missing=report.missingStudents;p.outputRevision=p.revision;p.message=p.missing?'部分照片未取得，名册只包含已有照片学生；可继续重试缺失照片':'已按新版八列模板导出到服务器';await update(a,id,p.missing?'partial':'completed',p,true);
}
async function run(a,id){let p;try{
 const job=await internal(a,id);if(job.status!=='pending')return;p=job.payload;await unchanged(a,p);p.saved=await cached(a,p);p.missing=p.rows.length-p.saved;
 if(p.missing){
  const state=await photos.state(a.openid);let photoJob=state.job;
  if(!photoJob||!['pending','running','pause_requested'].includes(photoJob.status)){
   const connection=await access.status(a.openid);if(!connection.connected){p.message='部分照片尚未保存，请连接教务后继续，任务和名单已保留';await update(a,id,'awaiting_auth',p,true);return}
   if(connection.busy){p.message='教务正在处理其他任务，请稍后继续导出';await update(a,id,'paused',p,true);return}
   photoJob=await photos.start(a.openid,photoJob&&['paused','partial','failed'].includes(photoJob.status)?{resumeId:photoJob.id}:{skipExisting:true});p.ownsPhotoJob=true;
  }else p.ownsPhotoJob=false;
  p.photoJobId=photoJob.id;await update(a,id,'downloading',p);
  const deadline=Date.now()+300000;while(true){if(await paused(a,id,p))return;photoJob=await photos.jobView(a,p.photoJobId);p.saved=await cached(a,p);p.missing=p.rows.length-p.saved;
   if(!['pending','running','pause_requested'].includes(photoJob.status))break;
   await update(a,id,'downloading',p);if(Date.now()>deadline){p.message='照片仍在保存，进度已保留；稍后可继续生成导出';await update(a,id,'paused',p,true);return}await new Promise(r=>setTimeout(r,1500));
  }
  if(photoJob.status==='paused'&&p.missing){p.message=photoJob.payload.message||'照片保存已暂停，可稍后继续';await update(a,id,photoJob.payload.errorCode==='ACADEMIC_AUTH_REQUIRED'?'awaiting_auth':'paused',p,true);return}
 }
 if(await paused(a,id,p))return;await update(a,id,'writing',p);await build(a,id,p);
 }catch(e){if(!p){await pool.query("UPDATE academic_photo_exports SET status='failed',active_key=NULL WHERE id=? AND openid=? AND account_key=?",[id,...args(a)]).catch(()=>{});return}p.message=e instanceof AppError?e.message:'导出中断，已保存的照片保留，可继续重试';await update(a,id,e.code==='ACADEMIC_AUTH_REQUIRED'?'awaiting_auth':'failed',p,true).catch(()=>{})}}
function launch(a,id){if(busy.has(id)){void busy.get(id).then(()=>launch(a,id));return}const work=run(a,id).finally(()=>busy.delete(id));busy.set(id,work)}
async function start(openid,body={}){
 const a=await grades.actor(openid),id=body.resumeId||randomUUID();let p;
 if(body.resumeId){const old=await internal(a,id);if(!['awaiting_auth','paused','partial','failed'].includes(old.status))throw new AppError(409,'PHOTO_EXPORT_BUSY','该任务仍在运行或已完成');p=old.payload;await unchanged(a,p);p.revision++;p.message=''}
 else {if(!d.memberSet(await d.managedRoster(a)))throw new AppError(400,'MANAGED_REQUIRED','请先在名单与连接中匹配学工所带学生，导出只针对所带学生');const rows=makeRows(await currentStudents(openid));if(!rows.length)throw new AppError(400,'MANAGED_REQUIRED','请先匹配所带学生名单');p={rows,total:rows.length,saved:0,missing:rows.length,revision:1,ruleVersion:'student-template-v2-8-columns'}}
 try{if(body.resumeId){const [changed]=await pool.query("UPDATE academic_photo_exports SET status='pending',active_key=?,payload=? WHERE id=? AND openid=? AND account_key=? AND active_key IS NULL AND status IN ('awaiting_auth','paused','partial','failed')",[digest(args(a)),JSON.stringify(p),id,...args(a)]);if(!changed.affectedRows)throw new AppError(409,'PHOTO_EXPORT_BUSY','任务进度已变化，请刷新')}
 else await pool.query("INSERT INTO academic_photo_exports(id,openid,account_key,active_key,status,payload) VALUES (?,?,?,?,'pending',?)",[id,...args(a),digest(args(a)),JSON.stringify(p)]);
 }catch(e){if(e.code==='ER_DUP_ENTRY')throw new AppError(409,'PHOTO_EXPORT_BUSY','已有照片导出任务，请查看当前进度');throw e}
 launch(a,id);return publicView(a,await internal(a,id));
}
async function state(openid){const a=await grades.actor(openid),[jobs]=await pool.query('SELECT * FROM academic_photo_exports WHERE openid=? AND account_key=? ORDER BY created_at DESC LIMIT 5',args(a));return {ruleVersion:'student-template-v2-8-columns',headers:['姓名','学号','班级','年级','学校','专业','班号','照片文件名'],jobs:jobs.map(j=>publicView(a,{...j,payload:parse(j.payload)})),connection:await access.status(openid)}}
async function pause(openid,id){const a=await grades.actor(openid);await internal(a,id);await pool.query("UPDATE academic_photo_exports SET status='pause_requested' WHERE id=? AND openid=? AND account_key=? AND status IN ('pending','downloading','writing')",[id,...args(a)]);return publicView(a,await internal(a,id))}
async function download(openid,id){const a=await grades.actor(openid),job=await internal(a,id);if(!['completed','partial'].includes(job.status)||!job.payload.outputRevision)throw new AppError(409,'PHOTO_EXPORT_NOT_READY','导出文件尚未生成');await unchanged(a,job.payload);const file=path.join(location(a,id,job.payload.outputRevision),'照片与名册.zip');await fs.access(file);return {file,filename:'所带学生照片与名册_'+job.payload.saved+'人.zip'}}
async function recover(){await pool.query("UPDATE academic_photo_exports SET status='paused',active_key=NULL,payload=JSON_SET(payload,'$.message','服务已更新，进度保留；点击继续导出') WHERE active_key IS NOT NULL")}
module.exports={start,state,pause,download,recover,busy,makeRows,location,internal};
