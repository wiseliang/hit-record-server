const pool=require("../config/database"),access=require("./academicAccess"),reader=require("./academicSchoolReader"),{AppError}=require("../utils/errors"),{randomUUID}=require("crypto"),{cohortKey,digest,analyze,validScore,validateLinks}=require("./gradeAnalysis");
const parse=v=>typeof v==="string"?JSON.parse(v):v;
const busy=new Map();
async function actor(openid){return {openid,accountKey:(await access.identity(openid)).accountKey}}
const args=a=>[a.openid,a.accountKey];
async function profile(a){
 const [rows]=await pool.query("SELECT revision,payload FROM academic_profiles WHERE openid=? AND account_key=?",args(a));
 return rows[0]?{revision:rows[0].revision,scopes:parse(rows[0].payload)}:{revision:0,scopes:[]};
}
async function saveProfile(openid,body){
 if(!Array.isArray(body.scopes)||!body.scopes.length||body.scopes.length>20||!Number.isInteger(body.revision))throw new AppError(400,"INVALID_ACADEMIC_SCOPE","请选择1至20组专业班级范围");
 const a=await actor(openid),existing=await profile(a);
 if(existing.revision!==body.revision)throw new AppError(409,"ACADEMIC_PROFILE_CHANGED","管理范围已变化，请刷新");
 const [running]=await pool.query("SELECT id FROM academic_jobs WHERE active_key=?",[digest(args(a))]);
 if(running.length)throw new AppError(409,"ACADEMIC_BUSY","请暂停同步任务后再调整范围");
 const scopes=await access.withSession(openid,async s=>{
  const out=[];
  for(const input of body.scopes){
   if(typeof input.year!=="string"||typeof input.facultyCode!=="string"||typeof input.majorCode!=="string"||!Array.isArray(input.classes)||input.classes.length>100)throw new AppError(400,"INVALID_ACADEMIC_SCOPE","管理范围格式不正确");
   const o=await reader.options(s,input),year=o.years.find(x=>x.value===input.year),faculty=o.faculties.find(x=>x.value===input.facultyCode),major=o.majors.find(x=>x.value===input.majorCode);
   if(!year||!faculty||!major)throw new AppError(400,"INVALID_ACADEMIC_SCOPE","专业或年级不在学校当前选项内，请重新选择");
   const classes=[...new Set(input.classes)];
   if(classes.some(x=>typeof x!=="string"||!o.classes.some(v=>v.value===x)))throw new AppError(400,"INVALID_ACADEMIC_SCOPE","班级不属于所选专业年级，请重新选择");
   const scope={year:year.value,facultyCode:faculty.value,facultyName:faculty.label,majorCode:major.value,majorName:major.label,classes,classLabels:classes.map(v=>o.classes.find(x=>x.value===v).label)};
   scope.key=cohortKey(scope);
   if(out.some(x=>x.key===scope.key))throw new AppError(400,"DUPLICATE_ACADEMIC_SCOPE","同一专业年级请在一组内选择多个班级");
   out.push(scope);
  }return out;
 });
 const db=await pool.getConnection();
 try{await db.beginTransaction();
  await db.query("INSERT IGNORE INTO academic_profiles(openid,account_key,revision,payload) VALUES (?,?,0,'[]')",args(a));
  const [row]=await db.query("SELECT revision FROM academic_profiles WHERE openid=? AND account_key=? FOR UPDATE",args(a));
  if(row[0].revision!==body.revision)throw new AppError(409,"ACADEMIC_PROFILE_CHANGED","管理范围已变化，请刷新");
  await db.query("UPDATE academic_profiles SET revision=revision+1,payload=? WHERE openid=? AND account_key=?",[JSON.stringify(scopes),...args(a)]);await db.commit();
 }catch(e){await db.rollback();throw e}finally{db.release()}
 return profile(a);
}
async function scopeFor(a,key){const p=await profile(a),s=p.scopes.find(x=>x.key===key);if(!s)throw new AppError(404,"ACADEMIC_SCOPE_NOT_FOUND","请先设置该专业的管理范围");return {profile:p,scope:s}}
async function links(a,key){
 const [rows]=await pool.query("SELECT id,cohort_key,student_id,from_code,to_code,reason,active,created_at,revoked_at FROM academic_links WHERE openid=? AND account_key=? AND cohort_key=? ORDER BY created_at DESC",[...args(a),key]);
 return rows;
}
async function rosterCached(a,key){const [rows]=await pool.query("SELECT payload,checked_at FROM academic_rosters WHERE openid=? AND account_key=? AND cohort_key=?",[...args(a),key]);return rows[0]?{students:parse(rows[0].payload),checkedAt:rows[0].checked_at}:null}
function managed(scope,row){return !scope.classes.length||(scope.classes.includes(row.className)||(scope.classLabels||[]).includes(row.className))}
async function refreshRoster(a,scope,s){
 const rows=await reader.roster(s,scope);
 if(!rows.length)throw new AppError(422,"ACADEMIC_ROSTER_EMPTY",`${scope.year}级${scope.majorName||"所选专业"}的教务名单为空；请按该年级实际大类或试验班重新设置专业范围，不能按0人视为同步完成`);
 if(rows.some(x=>x.year!==scope.year))throw new AppError(502,"ACADEMIC_ROSTER_MISMATCH","教务返回年级与查询条件不一致，请核实后重试");
 await pool.query("INSERT INTO academic_rosters(openid,account_key,cohort_key,payload,checked_at) VALUES (?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE payload=VALUES(payload),checked_at=VALUES(checked_at)",[...args(a),scope.key,JSON.stringify(rows)]);
 return rows;
}
async function ensureRoster(a,scope,s){const cached=await rosterCached(a,scope.key);return cached?.students.length?cached.students:refreshRoster(a,scope,s)}
async function saveArchive(a,key,student,courses){
 const payload={student,courses,sourceComplete:true,source:"/xfj/queryXscjByxh",checkedAt:new Date().toISOString()};
 await pool.query("INSERT INTO academic_archives(openid,account_key,cohort_key,student_id,payload,checked_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE payload=VALUES(payload),checked_at=VALUES(checked_at)",[...args(a),key,student.studentId,JSON.stringify(payload)]);
 return payload;
}
async function archiveRows(a,key){
 const [rows]=await pool.query("SELECT student_id,payload FROM academic_archives WHERE openid=? AND account_key=? AND cohort_key=?",[...args(a),key]);return new Map(rows.map(r=>[r.student_id,parse(r.payload)]));
}
async function student(openid,key,id,refresh=false){
 const a=await actor(openid),{scope}=await scopeFor(a,key);let roster=(await rosterCached(a,key))?.students;
 if(refresh||!roster){
  await access.withSession(openid,async s=>{roster=await ensureRoster(a,scope,s);const row=roster.find(r=>r.studentId===id);if(!row)throw new AppError(404,"ACADEMIC_STUDENT_NOT_FOUND","该生不在所选专业名单中");
   await saveArchive(a,key,row,await reader.grades(s,scope,id));
  });
 }
 const row=roster.find(r=>r.studentId===id);if(!row)throw new AppError(404,"ACADEMIC_STUDENT_NOT_FOUND","该生不在所选专业名单中");
 const [saved]=await pool.query("SELECT payload FROM academic_archives WHERE openid=? AND account_key=? AND cohort_key=? AND student_id=?",[...args(a),key,id]);
 const data=saved[0]?parse(saved[0].payload):null,relationships=await links(a,key);
 return {student:row,archive:data,analysis:data?analyze(data.courses,relationships,id,data.sourceComplete):null,links:relationships.filter(l=>l.student_id==="*"||l.student_id===id)};
}
async function students(openid,key,query={}){
 const a=await actor(openid),{scope}=await scopeFor(a,key);
 if(query.refresh===true)await access.withSession(openid,s=>refreshRoster(a,scope,s));
 const roster=await rosterCached(a,key),archives=await archiveRows(a,key),relationships=await links(a,key);
 let rows=(roster?.students||[]).filter(r=>query.all===true||managed(scope,r)).map(r=>{
  const data=archives.get(r.studentId),v=data?analyze(data.courses,relationships,r.studentId,data.sourceComplete):null;
  return {...r,checkedAt:data?.checkedAt||null,recordCount:data?.courses.length??null,observedUnresolvedCount:v?.observedUnresolvedCount??null,pendingCount:v?.pendingCount??null,historicalFailedAttempts:v?.historicalFailedAttempts??null};
 });
 if(query.q)rows=rows.filter(r=>(r.name+" "+r.studentId).includes(String(query.q).slice(0,80)));
 if(query.failed==="true")rows=rows.filter(r=>r.observedUnresolvedCount>0);
 const total=rows.length,offset=Math.max(0,Math.min(Number(query.offset)||0,100000)),limit=Math.min(100,Math.max(1,Number(query.limit)||50));
 return {scope,rosterCheckedAt:roster?.checkedAt||null,professionalCount:roster?.students.length??null,managedCount:roster?.students.filter(r=>managed(scope,r)).length??null,total,students:rows.slice(offset,offset+limit)};
}
async function catalog(openid,key){
 const a=await actor(openid);await scopeFor(a,key);const data=await archiveRows(a,key),map=new Map();
 for(const row of data.values())for(const r of row.courses){const id=digest([r.semester,r.code]);if(!map.has(id))map.set(id,{code:r.code,name:r.name,semester:r.semester})}
 return {courses:[...map.values()].sort((a,b)=>b.semester.localeCompare(a.semester)||a.code.localeCompare(b.code))};
}
async function courseQuery(openid,body){
 const a=await actor(openid),{scope}=await scopeFor(a,body.cohortKey);
 if(typeof body.term!=="string"||!body.term||typeof body.courseCode!=="string"||!/^[A-Za-z0-9_.-]{1,80}$/.test(body.courseCode))throw new AppError(400,"INVALID_COURSE_QUERY","请选择学期和课程代码");
 const relationships=await links(a,scope.key),archives=await archiveRows(a,scope.key);
 let roster,records;
 await access.withSession(openid,async s=>{
  const options=await reader.options(s);
  if(!options.terms.some(x=>x.value===body.term))throw new AppError(400,"INVALID_COURSE_QUERY","学期选项已变化，请重新选择");
  roster=await ensureRoster(a,scope,s);
  records=await reader.course(s,scope,body.term,body.courseCode);
 });
 const allowed=new Map(roster.map(r=>[r.studentId,r]));
 const managedIds=require("./academicDashboard").memberSet(await require("./academicDashboard").managedRoster(a));
 const inManaged=row=>managedIds?managedIds.has(row.studentId):managed(scope,row);
 if(records.some(r=>!allowed.has(r.studentId)))throw new AppError(502,"ACADEMIC_COURSE_RANGE_MISMATCH","课程结果与专业名单不一致，请刷新名单后重试");
 let rows=records.filter(r=>body.managedOnly!==true||inManaged(allowed.get(r.studentId))).map(r=>{
  const data=archives.get(r.studentId),v=data?analyze(data.courses,relationships,r.studentId,data.sourceComplete):null,c=v?.courses.find(c=>c.codes.includes(r.code));
  return {...r,originalState:validScore({score:r.score,remark:""}).state,courseState:c?.state||"not_synced",recovery:c?.recovery||null,archiveCheckedAt:data?.checkedAt||null};
 });
 // School rows may include repeated examinations. Count people separately from attempts.
 const relevant=roster.filter(r=>body.managedOnly!==true||inManaged(r)),byStudent=new Map();
 for(const r of rows){if(!byStudent.has(r.studentId))byStudent.set(r.studentId,[]);byStudent.get(r.studentId).push(r)}
 const published=[...byStudent.values()].filter(rs=>rs.some(r=>r.originalState!=="unknown"));
 const summary={scopeLabel:body.managedOnly===true?"所带班级":"整个专业",rosterCount:relevant.length,returnedStudents:byStudent.size,recordCount:rows.length,publishedStudents:published.length,failedScoreStudents:[...byStudent.values()].filter(rs=>rs.some(r=>r.originalState==="fail")).length,observedUnresolvedStudents:[...byStudent.values()].filter(rs=>rs.some(r=>r.courseState==="unresolved")).length,unknownHistoryStudents:[...byStudent.values()].filter(rs=>rs.some(r=>["not_synced","pending","unknown"].includes(r.courseState))).length,missingStudents:relevant.filter(r=>!byStudent.has(r.studentId)).length};
 const filters={failed:r=>r.originalState==="fail",unresolved:r=>r.courseState==="unresolved",recovered:r=>r.courseState==="passed"&&!!r.recovery,pending:r=>["not_synced","pending","unknown"].includes(r.courseState)};
 if(body.filter==="missing")rows=relevant.filter(r=>!byStudent.has(r.studentId)).map(r=>({...r,courseState:"no_published_record",originalState:"unknown",score:"",code:body.courseCode}));
 else if(body.filter&&filters[body.filter])rows=rows.filter(filters[body.filter]);
 return {scope,summary,records:rows,checkedAt:new Date().toISOString(),note:"缺少记录不代表挂科；当前未通过判定依据最近一次已同步历史，时间可能不同于本次单科查询"};
}
async function changeLink(openid,body){
 const a=await actor(openid);await scopeFor(a,body.cohortKey);
 const db=await pool.getConnection();try{
 await db.beginTransaction();
 await db.query("SELECT revision FROM academic_profiles WHERE openid=? AND account_key=? FOR UPDATE",args(a));
 const [all]=await db.query("SELECT * FROM academic_links WHERE openid=? AND account_key=? AND cohort_key=?",[...args(a),body.cohortKey]);
 if(body.action==="revoke"){
  const row=all.find(l=>l.id===body.id&&l.active);if(!row)throw new AppError(404,"ACADEMIC_LINK_NOT_FOUND","关联不存在或已撤销");
  await db.query("UPDATE academic_links SET active=0,revoked_at=UTC_TIMESTAMP() WHERE id=? AND openid=? AND account_key=?",[body.id,...args(a)]);
 }else{
  if(body.action!=="create"||typeof body.reason!=="string"||!body.reason.trim()||body.reason.length>500||!["student","cohort"].includes(body.scope)||typeof body.studentId!=="string"||!body.studentId||typeof body.fromCode!=="string"||typeof body.toCode!=="string")throw new AppError(400,"INVALID_ACADEMIC_LINK","请选择关联课程、适用范围并填写依据");
  const [saved]=await db.query("SELECT payload FROM academic_archives WHERE openid=? AND account_key=? AND cohort_key=? AND student_id=?",[...args(a),body.cohortKey,body.studentId]);
  const data=saved[0]?parse(saved[0].payload):null;
  if(!data||![body.fromCode,body.toCode].every(code=>data.courses.some(c=>c.code===code)))throw new AppError(400,"INVALID_ACADEMIC_LINK","两门课程必须来自该生已同步的原始成绩");
  const proposal={...body,studentId:body.scope==="cohort"?"*":body.studentId};
  try{validateLinks(all,proposal)}catch(e){throw new AppError(409,"ACADEMIC_LINK_CONFLICT",e.message)}
  await db.query("INSERT INTO academic_links(id,openid,account_key,cohort_key,student_id,from_code,to_code,reason) VALUES (?,?,?,?,?,?,?,?)",[randomUUID(),...args(a),body.cohortKey,proposal.studentId,body.fromCode,body.toCode,body.reason.trim()]);
 }await db.commit();
 }catch(e){await db.rollback();throw e}finally{db.release()}
 return {links:await links(a,body.cohortKey)};
}
async function jobView(a,id){const [rows]=await pool.query("SELECT id,status,payload,updated_at FROM academic_jobs WHERE id=? AND openid=? AND account_key=?",[id,...args(a)]);if(!rows[0])throw new AppError(404,"ACADEMIC_JOB_NOT_FOUND","同步任务不存在");return {...rows[0],payload:parse(rows[0].payload)}}
async function updateJob(a,id,status,data,finish=false){await pool.query("UPDATE academic_jobs SET status=IF(status='pause_requested' AND ?=0,status,?),payload=?,active_key=IF(?,NULL,active_key) WHERE id=? AND openid=? AND account_key=?",[finish?1:0,status,JSON.stringify(data),finish?1:0,id,...args(a)])}
function launch(a,id){if(busy.has(id))return;const promise=runJob(a,id).finally(()=>busy.delete(id));busy.set(id,promise)}
async function runJob(a,id){
 let data;
 try{
  const job=await jobView(a,id);data=job.payload;
  const current=await profile(a);if(data.revision!==current.revision)throw new AppError(409,"ACADEMIC_PROFILE_CHANGED","管理范围已变化，请创建新任务");
  await updateJob(a,id,"running",data);
  await access.withSession(a.openid,async s=>{
   if(s.accountKey!==a.accountKey)throw new AppError(409,"SCHOOL_ACCOUNT_CHANGED","学校账号已变化");
   const work=[];
   const managedIds=data.range!=="professional"?require("./academicDashboard").memberSet(await require("./academicDashboard").managedRoster(a)):null;
   for(const scope of current.scopes){const roster=await refreshRoster(a,scope,s);for(const student of roster.filter(row=>data.range==="professional"||(managedIds?managedIds.has(row.studentId):managed(scope,row))))work.push({scope,student,key:scope.key+":"+student.studentId})}
   if(!work.length)throw new AppError(422,"ACADEMIC_ROSTER_EMPTY","未取得任何学生名单，请重新选择教务实际专业范围");
   data.total=work.length;data.doneKeys=(data.doneKeys||[]).filter(k=>work.some(x=>x.key===k));data.failures=[];data.success=data.doneKeys.length;
   for(const entry of work){
    const latest=await jobView(a,id);
    if(latest.status==="pause_requested"){await updateJob(a,id,"paused",data,true);return}
    if((await profile(a)).revision!==data.revision || (await actor(a.openid)).accountKey!==a.accountKey)throw new AppError(409,"ACADEMIC_PROFILE_CHANGED","账号或管理范围变化，任务已停止");
    if(data.doneKeys.includes(entry.key))continue;
    data.current=entry.student.studentId;await updateJob(a,id,"running",data);
    try{
     const courses=await reader.grades(s,entry.scope,entry.student.studentId);
     await saveArchive(a,entry.scope.key,entry.student,courses);data.doneKeys.push(entry.key);data.success++;
    }catch(e){
     if(e.code==="ACADEMIC_AUTH_REQUIRED")throw e;
     data.failures.push({studentId:entry.student.studentId,cohortKey:entry.scope.key,message:e instanceof AppError?e.message:"读取失败，可恢复后重试"});
    }
    await updateJob(a,id,"running",data);
    await new Promise(r=>setTimeout(r,300));
   }
   data.current=null;await updateJob(a,id,data.failures.length?"partial":"completed",data,true);
  });
 }catch(e){
  data??={};data.message=e instanceof AppError?e.message:"同步中断，已保存进度，可恢复重试";data.current=null;
  await updateJob(a,id,e.code==="ACADEMIC_AUTH_REQUIRED"?"paused":"failed",data,true).catch(()=>{});
 }
}
async function startJob(openid,body={}){
 const a=await actor(openid),p=await profile(a);if(!p.scopes.length)throw new AppError(400,"ACADEMIC_SCOPE_REQUIRED","请先设置专业和班级");
 const status=await access.status(openid);if(!status.connected)throw new AppError(409,"ACADEMIC_AUTH_REQUIRED","请先连接教务");
 const id=body.resumeId||randomUUID();let data={revision:p.revision,total:0,success:0,doneKeys:[],failures:[],range:body.range==="professional"?"professional":"managed"};
 if(body.resumeId){const old=await jobView(a,id);if(!["paused","partial","failed"].includes(old.status))throw new AppError(409,"ACADEMIC_BUSY","任务仍在运行或已经完成");if(old.payload.revision!==p.revision)throw new AppError(409,"ACADEMIC_PROFILE_CHANGED","范围已变化，请创建新任务");data=old.payload;if(!["managed","professional"].includes(data.range))throw new AppError(409,"ACADEMIC_SYNC_SCOPE_REQUIRED","旧任务使用全专业范围，请新建仅所带学生任务")}
 try{
  if(body.resumeId){const [changed]=await pool.query("UPDATE academic_jobs SET status='pending',active_key=?,payload=? WHERE id=? AND openid=? AND account_key=? AND status IN ('paused','partial','failed')",[digest(args(a)),JSON.stringify(data),id,...args(a)]);if(!changed.affectedRows)throw new AppError(409,"ACADEMIC_BUSY","任务已恢复，请查看进度");}
  else await pool.query("INSERT INTO academic_jobs(id,openid,account_key,active_key,status,payload) VALUES (?,?,?,?,'pending',?)",[id,...args(a),digest(args(a)),JSON.stringify(data)]);
 }catch(e){if(e.code==="ER_DUP_ENTRY")throw new AppError(409,"ACADEMIC_BUSY","已有成绩同步任务，请查看当前进度");throw e}
 launch(a,id);return jobView(a,id);
}
async function pauseJob(openid,id){const a=await actor(openid);const job=await jobView(a,id);if(["pending","running"].includes(job.status))await pool.query("UPDATE academic_jobs SET status='pause_requested' WHERE id=? AND openid=? AND account_key=? AND status IN ('pending','running')",[id,...args(a)]);return jobView(a,id)}
async function state(openid){const a=await actor(openid),p=await profile(a);const [jobs]=await pool.query("SELECT id FROM academic_jobs WHERE openid=? AND account_key=? ORDER BY created_at DESC LIMIT 1",args(a));return {profile:p,job:jobs[0]?await jobView(a,jobs[0].id):null,connection:await access.status(openid)}}
async function recover(){
 await pool.query("UPDATE academic_jobs SET status='paused',active_key=NULL WHERE active_key IS NOT NULL");
 // Repair old zero-student successes without touching saved student archives.
 await pool.query("UPDATE academic_jobs SET status='failed',active_key=NULL,payload=JSON_SET(payload,'$.message',?) WHERE status='completed' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.total'))='0'",["上次未取得学生名单，不能按0人视为同步完成；请按该年级实际大类或试验班重新设置专业范围"]);
 await pool.query("DELETE FROM academic_rosters WHERE JSON_TYPE(payload)='ARRAY' AND JSON_LENGTH(payload)=0");
}
module.exports={actor,profile,saveProfile,students,student,catalog,courseQuery,changeLink,startJob,pauseJob,state,jobView,recover,busy,managed};
