const {test,before,after}=require("node:test"),assert=require("node:assert/strict"),{randomUUID}=require("crypto");
if(!/_(test|stage)$/.test(process.env.DB_NAME||""))throw Error("Isolated test database required");
const pool=require("../config/database"),access=require("../services/academicAccess"),service=require("../services/academicGrades"),reader=require("../services/academicSchoolReader"),credential=require("../models/credential"),{issueToken}=require("../utils/session"),{normalizeRecord,digest}=require("../services/gradeAnalysis");
const owner="academic_test_"+randomUUID(),other=owner+"_other",scope={year:"2025",facultyCode:"F",majorCode:"M",classes:["classA"]};
let server,base,key,linkId,firstJob,gate,unblock,calls=0;
const records=[{studentId:"20250001",name:"测试甲",className:"classA",year:"2025",faculty:"院系",major:"专业",weightedScore:"80",schoolFailedCount:"1",classRank:"1"},{studentId:"20250002",name:"测试乙",className:"classB",year:"2025",faculty:"院系",major:"专业",weightedScore:"85",schoolFailedCount:"0",classRank:"2"},{studentId:"20250003",name:"测试丙",className:"classA",year:"2025",faculty:"院系",major:"专业",weightedScore:"70",schoolFailedCount:"1",classRank:"3"}];
const courses=[normalizeRecord({semester:"2025秋季",code:"A",name:"原数学",score:"45",credits:"3",nature:"必修"}),normalizeRecord({semester:"2026春季",code:"B",name:"改名数学",score:"75",attempt:"重修",credits:"3",nature:"必修"},1)];
const original={...reader};
async function session(who,account){await credential.saveCredential(who,account,"fixture-password");access.sessions.set(who,{openid:who,accountKey:access.accountKey(account),step:"ready",page:{context:()=>({storageState:async()=>({cookies:[],origins:[]})}),request:{get:async()=>({status:()=>200,text:async()=>'<select name="pageZydm"></select>不及格门数'})}}})}
async function http(path,{who=owner,body,method}={}){const r=await fetch(base+"/api/academic-grades"+path,{method:method||(body?"POST":"GET"),headers:{authorization:"Bearer "+issueToken(who),"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()}}
async function waitJob(id,states){for(let i=0;i<150;i++){const job=(await http("/sync/"+id)).body;if(states.includes(job.status))return job;await new Promise(r=>setTimeout(r,250))}throw Error("Job wait exceeded")}
before(async()=>{
 await require("../scripts/migrate-v12").migrate();await session(owner,"teacher-A");await session(other,"teacher-B");
 reader.options=async()=>({years:[{value:"2025",label:"2025"}],faculties:[{value:"F",label:"院系"}],majors:[{value:"M",label:"专业"}],classes:[{value:"classA",label:"classA"},{value:"classB",label:"classB"}],terms:[{value:"T",label:"2025秋季"}]});
 reader.roster=async()=>records;
 reader.grades=async()=>{calls++;if(gate)await gate;return courses};
 reader.course=async()=>records.map(r=>({...r,code:"A",courseName:"原数学",score:"45",majorRank:"1"}));
 server=require("../app").listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));base="http://127.0.0.1:"+server.address().port;
});
after(async()=>{
 unblock?.();await Promise.allSettled([...service.busy.values(),...require("../services/academicPhotos").busy.values(),...require("../services/academicPhotoExports").busy.values()]);Object.assign(reader,original);
 for(const who of [owner,other])await access.sessions.dispose(who);
 if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}
 for(const table of ["academic_photo_exports","academic_photo_jobs","academic_student_photos","academic_managed_rosters","school_account_bindings","academic_jobs","academic_links","academic_archives","academic_rosters","academic_profiles","academic_sessions","school_login_sessions","credentials"])await pool.query("DELETE FROM "+table+" WHERE openid IN (?,?)",[owner,other]);
 await pool.end();
});
test("教务账号标识与现有学工连接持久化标识兼容",async()=>{
 const session={step:"ready",studentId:"teacher-A",page:{context:()=>({storageState:async()=>({cookies:[],origins:[]})})}};
 await require("../services/schoolSession").persist(owner,session);
 const [rows]=await pool.query("SELECT account_key FROM school_login_sessions WHERE openid=?",[owner]);
 assert.equal(rows[0].account_key,(await access.identity(owner)).accountKey);
});
test("首次范围校验、多老师隔离、版本冲突及班级名单",async()=>{
 let r=await http("/profile",{body:{revision:0,scopes:[scope]}});assert.equal(r.status,200);key=r.body.scopes[0].key;
 assert.equal((await http("/state",{who:other})).body.profile.scopes.length,0);
 assert.equal((await http("/profile",{body:{revision:0,scopes:[scope]}})).status,409);
 assert.equal((await http("/profile",{body:{revision:1,scopes:[{...scope,classes:["unknown"]}]}})).status,400);
 assert.equal((await http("/roster/refresh",{body:{cohortKey:key}})).body.managedCount,2);
 assert.equal((await http("/students?cohortKey="+key)).body.total,2);
 assert.equal((await http("/students?cohortKey="+key+"&all=true")).body.total,3);
 assert.equal((await http("/students?cohortKey="+key,{who:other})).status,404);
});
test("单科默认全专业，明确筛班级；无历史不伪装补考已通过",async()=>{
 const body={cohortKey:key,term:"T",courseCode:"A"};
 let r=await http("/course",{body});assert.equal(r.status,200);assert.equal(r.body.records.length,3);assert.equal(r.body.summary.scopeLabel,"整个专业");assert.equal(r.body.records[0].courseState,"not_synced");
 r=await http("/course",{body:{...body,managedOnly:true}});assert.equal(r.body.records.length,2);
});
test("完整成绩落库再读，跨名称关联可确认、隔离、撤销",async()=>{
 let r=await http("/student/refresh",{body:{cohortKey:key,studentId:"20250001"}});assert.equal(r.status,200);assert.equal(r.body.archive.courses.length,2);assert.equal(r.body.analysis.pendingCount,1);
 const body={action:"create",cohortKey:key,studentId:"20250001",fromCode:"A",toCode:"B",reason:"核对培养方案后的教师确认",scope:"student"};
 r=await http("/links",{body});assert.equal(r.status,200);linkId=r.body.links[0].id;
 const got=(await http("/student?cohortKey="+key+"&studentId=20250001")).body;assert.equal(got.analysis.recoveredCount,1);assert.equal(got.analysis.courses.length,1);assert.equal(got.archive.courses.length,2);
 assert.equal((await http("/links",{body:{...body,action:"revoke",id:linkId},who:other})).status,404);
 assert.equal((await http("/links",{body:{...body,action:"revoke",id:linkId}})).status,200);
 assert.equal((await http("/student?cohortKey="+key+"&studentId=20250001")).body.analysis.courses.length,2);
});
test("不允许伪造课程代码关联；学校账号更换不读取旧账号缓存",async()=>{
 const r=await http("/links",{body:{action:"create",cohortKey:key,studentId:"20250001",fromCode:"A",toCode:"FAKE",reason:"无证据",scope:"student"}});assert.equal(r.status,400);
 await credential.saveCredential(owner,"different-account","fixture-password");
 assert.equal((await http("/state")).body.profile.scopes.length,0);
 assert.equal((await http("/student?cohortKey="+key+"&studentId=20250001")).status,404);
 await session(owner,"teacher-A");
});
test("同步可暂停，成功数据保存且恢复时跳过已完成学生，任务归属受保护",async()=>{
 gate=new Promise(r=>{unblock=r});
 const r=await http("/sync",{body:{}});assert.equal(r.status,202);firstJob=r.body.id;
 for(let i=0;i<100;i++){const j=(await http("/sync/"+firstJob)).body;if(j.payload.current)break;await new Promise(r=>setTimeout(r,250))}
 assert.equal((await http("/sync",{body:{}})).status,409);
 assert.equal((await http("/profile",{body:{revision:1,scopes:[scope]}})).status,409);
 assert.equal((await http("/sync/"+firstJob,{who:other})).status,404);
 await http("/sync/"+firstJob+"/pause",{body:{}});gate=null;unblock();
 const paused=await waitJob(firstJob,["paused"]);assert.equal(paused.payload.success,1);
 const count=calls;
 await http("/sync",{body:{resumeId:firstJob}});
 const done=await waitJob(firstJob,["completed"]);assert.equal(done.payload.success,2);assert.equal(calls-count,1);
 const students=(await http("/students?cohortKey="+key)).body;assert.equal(students.total,2);assert.ok(students.students.every(r=>r.recordCount===2));
});
test("查询失败保留最近成功成绩，未识别学期拒绝查询",async()=>{
 const old=reader.grades;reader.grades=async()=>{throw Error("fixture read failed")};
 assert.equal((await http("/student/refresh",{body:{cohortKey:key,studentId:"20250001"}})).status,500);reader.grades=old;
 assert.equal((await http("/student?cohortKey="+key+"&studentId=20250001")).body.archive.courses.length,2);
 assert.equal((await http("/course",{body:{cohortKey:key,term:"UNKNOWN",courseCode:"A"}})).status,400);
});
test('空名单不能显示同步完成或覆盖成功名单，历史空缓存不能让查询直接返回零人',async()=>{
 const previous=reader.roster;reader.roster=async()=>[];
 try{
  const r=await http('/roster/refresh',{body:{cohortKey:key}});assert.equal(r.status,422);assert.equal(r.body.code,'ACADEMIC_ROSTER_EMPTY');
  assert.equal((await http('/students?cohortKey='+key+'&all=true')).body.professionalCount,3);
  const job=await http('/sync',{body:{}});assert.equal(job.status,202);
  const failed=await waitJob(job.body.id,['failed']);assert.match(failed.payload.message,/名单为空/);assert.equal(failed.payload.success,0);
  assert.equal((await http('/student?cohortKey='+key+'&studentId=20250001')).body.archive.courses.length,2);
  await pool.query("UPDATE academic_rosters SET payload='[]' WHERE openid=?",[owner]);
  const course=await http('/course',{body:{cohortKey:key,term:'T',courseCode:'A'}});assert.equal(course.status,422);assert.equal(course.body.code,'ACADEMIC_ROSTER_EMPTY');
 }finally{reader.roster=previous;await pool.query('UPDATE academic_rosters SET payload=? WHERE openid=?',[JSON.stringify(records),owner])}
});
test('启动时纠正历史零人成功记录并清除空缓存，保留已有学生成绩',async()=>{
 const a=await service.actor(owner),id=randomUUID();
 await pool.query("INSERT INTO academic_jobs(id,openid,account_key,active_key,status,payload) VALUES (?,?,?,NULL,'completed',?)",[id,owner,a.accountKey,JSON.stringify({revision:1,total:0,success:0,doneKeys:[],failures:[]})]);
 await pool.query("UPDATE academic_rosters SET payload='[]' WHERE openid=?",[owner]);
 await service.recover();
 const fixed=await service.jobView(a,id);assert.equal(fixed.status,'failed');assert.match(fixed.payload.message,/未取得学生名单/);
 const [rosters]=await pool.query('SELECT payload FROM academic_rosters WHERE openid=?',[owner]);assert.equal(rosters.length,0);
 const [archives]=await pool.query('SELECT payload FROM academic_archives WHERE openid=?',[owner]);assert.ok(archives.length>0);
});
test('学业看板默认精确所带名单，专业查询独立，手动调整和导出可核对',async()=>{
 const school=require('../services/schoolSession'),originalSession=school.getSession;
 school.getSession=async()=>({accountKey:access.accountKey('teacher-A'),page:{request:{post:async()=>({ok:()=>true,json:async()=>({isSuccess:true,module:[{xh:'20250001',xm:'测试甲',zymc:'专业'},{xh:'20250003',xm:'测试丙',zymc:'专业'}]})})}}});
 try{
  const imported=await http('/managed/refresh',{body:{}});assert.equal(imported.status,200);assert.equal(imported.body.matched,2);
  let d=(await http('/dashboard?term=2025秋季')).body;assert.equal(d.coverage.total,2);assert.equal(d.scopeSource,'school');assert.equal(d.coverage.synced,2);assert.equal(d.counts.currentStudents,2);assert.equal(d.courses[0].failedStudents,2);assert.equal(d.courses[0].publishedStudents,2);
  assert.equal((await http('/dashboard?range=professional&term=2025秋季')).body.coverage.total,3);
  assert.equal((await http('/dashboard?term=2025秋季',{who:other})).body.coverage.total,0);
  assert.equal((await http('/managed/change',{body:{studentId:'20250003',action:'exclude'}})).status,200);
  d=(await http('/dashboard?term=2025秋季')).body;assert.equal(d.coverage.total,1);
  assert.equal((await http('/course',{body:{cohortKey:key,term:'T',courseCode:'A',managedOnly:true}})).body.records.length,1);
  assert.equal((await http('/managed/change',{body:{studentId:'FAKE0000',action:'include'}})).status,404);
  const exp=await http('/export?view=current&term=2025秋季');assert.equal(exp.status,200);assert.match(exp.body.content,/测试甲/);assert.doesNotMatch(exp.body.content,/测试丙/);
  await http('/managed/change',{body:{studentId:'20250003',action:'reset'}});
  const job=await http('/sync',{body:{}});const done=await waitJob(job.body.id,['completed']);assert.equal(done.payload.range,'managed');assert.equal(done.payload.total,2);
  const full=await http('/sync',{body:{range:'professional'}});const all=await waitJob(full.body.id,['completed']);assert.equal(all.payload.total,3);
 }finally{school.getSession=originalSession}
});
test('巡考始终只列所带学生，跨教师隔离且可导出课程与学生对应表',async()=>{
 const r=await http('/patrol?term=2025秋季&range=professional&includePassed=true');assert.equal(r.status,200);assert.equal(r.body.coverage.total,2);assert.equal(r.body.courseCount,1);assert.equal(r.body.courses[0].students.length,2);assert.equal(r.body.studentCount,2);
 assert.equal((await http('/patrol?term=2025秋季',{who:other})).body.courseCount,0);
 const exp=await http('/patrol/export?term=2025秋季&includePassed=true');assert.equal(exp.status,200);assert.match(exp.body.content,/原数学/);assert.match(exp.body.content,/测试甲/);assert.doesNotMatch(exp.body.content,/测试乙/);
});
test('照片按学号保存且加密隔离；读取失败不覆盖旧照片，批量暂停恢复不重传成功行',async()=>{
 const p=access.sessions.get(owner).page,originalRequest=p.request;let broken=false,photoCalls=0,photoGate=null,releasePhoto;
 const jpeg=Buffer.alloc(512,42);jpeg.set([255,216,255,224]);jpeg.set([255,217],510);
 p.request={get:async url=>{
  if(url.includes('/pub/queryXsxxView')){const id=new URL(url).searchParams.get('xh');return {status:()=>200,ok:()=>true,text:async()=>'<img id="zhaopian"><script>var xh = new String('+id+');var url="/xswhxx/showPhoto1?xh="+ps;</script>'}}
  if(url.includes('/xswhxx/showPhoto1'))return {status:()=>200,ok:()=>true,body:async()=>{photoCalls++;if(photoGate)await photoGate;return broken?Buffer.from('<html>not-photo</html>'):jpeg}};
  return {status:()=>200,text:async()=>'<select name="pageZydm"></select>不及格门数'};
 }};
 try{
  let r=await http('/photos/student',{body:{studentId:'20250001'}});assert.equal(r.status,200);assert.ok(r.body.imageData.startsWith('data:image/jpeg;base64,'));
  const [stored]=await pool.query('SELECT encrypted_photo FROM academic_student_photos WHERE openid=?',[owner]);assert.ok(!stored[0].encrypted_photo.includes(jpeg.toString('base64')));
  assert.equal((await http('/photos/student?studentId=20250001',{who:other})).status,404);
  await http('/managed/change',{body:{studentId:'20250001',action:'exclude'}});assert.equal((await http('/photos/student?studentId=20250001')).status,404);await http('/managed/change',{body:{studentId:'20250001',action:'reset'}});
  broken=true;assert.equal((await http('/photos/student',{body:{studentId:'20250001'}})).status,502);assert.equal((await http('/photos/student?studentId=20250001')).body.imageData,'data:image/jpeg;base64,'+jpeg.toString('base64'));broken=false;
  photoGate=new Promise(resolve=>{releasePhoto=resolve});const job=(await http('/photos/start',{body:{}})).body;
  for(let i=0;i<100;i++){const j=(await http('/photos/state')).body.job;if(j?.payload.current)break;await new Promise(r=>setTimeout(r,250))}
  assert.equal((await http('/photos/start',{body:{}})).status,409);await http('/photos/'+job.id+'/pause',{body:{}});photoGate=null;releasePhoto();
  let state;for(let i=0;i<100;i++){state=(await http('/photos/state')).body;if(state.job.status==='paused')break;await new Promise(r=>setTimeout(r,250))}assert.equal(state.job.status,'paused');assert.equal(state.job.payload.success,1);
  const callsBefore=photoCalls;await http('/photos/start',{body:{resumeId:job.id}});for(let i=0;i<100;i++){state=(await http('/photos/state')).body;if(state.job.status==='completed')break;await new Promise(r=>setTimeout(r,250))}assert.equal(state.saved,2);assert.equal(state.job.payload.success,2);assert.equal(photoCalls-callsBefore,1);
 }finally{releasePhoto?.();p.request=originalRequest}
});
test('恢复有效教务连接直接核验成绩，不重复打开认证页',async()=>{
 await Promise.allSettled([...require('../services/academicPhotos').busy.values()]);
 const browser=require('../services/browser'),acquire=browser.acquireContext,release=browser.releaseContext;
 const a=await service.actor(owner),storage=require('../utils/crypto').encrypt(JSON.stringify({cookies:[],origins:[]}));
 await pool.query('INSERT INTO academic_sessions(openid,account_key,state_encrypted,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR)) ON DUPLICATE KEY UPDATE state_encrypted=VALUES(state_encrypted),expires_at=VALUES(expires_at)',[owner,a.accountKey,storage]);
 browser.acquireContext=async()=>({slot:{},page:{goto:async()=>{throw Error('Must not re-enter CAS for valid protected session')},request:{get:async()=>({status:()=>200,text:async()=>'<select name="pageZydm"></select>不及格门数'})},context:()=>({storageState:async()=>({cookies:[],origins:[]})})}});browser.releaseContext=async()=>{};
 try{await access.start(owner,{requestVerification:false,force:true});await access.sessions.get(owner).job;assert.equal((await access.status(owner)).connected,true)}finally{browser.acquireContext=acquire;browser.releaseContext=release;await session(owner,'teacher-A')}
});
test('照片服务连续失败自动暂停，避免逐人长时间超时',async()=>{
 const p=access.sessions.get(owner).page,old=p.request;let requests=0;
 await http('/managed/change',{body:{studentId:'20250002',action:'include'}});
 p.request={get:async url=>{if(url.includes('/pub/queryXsxxView')){requests++;throw Error('fixture network unavailable')}return {status:()=>200,text:async()=>'<select name="pageZydm"></select>不及格门数'}}};
 try{const started=await http('/photos/start',{body:{}});assert.equal(started.status,202,JSON.stringify(started.body));let result;for(let i=0;i<150;i++){result=(await http('/photos/state')).body;if(result.job.status==='paused')break;await new Promise(r=>setTimeout(r,250))}assert.equal(result.job.status,'paused');assert.match(result.job.payload.message,/连续未响应/);assert.equal(requests,3);assert.equal(result.saved,2)}finally{p.request=old;await http('/managed/change',{body:{studentId:'20250002',action:'reset'}})}
});
test('新版服务器导出使用八列文本模板，仅所带学生，断开教务仍可导出已有照片',async()=>{
 const fs=require('fs/promises'),path=require('path'),os=require('os'),exportsService=require('../services/academicPhotoExports'),photos=require('../services/academicPhotos');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'academic-export-')),prior=process.env.PHOTO_EXPORT_ROOT;process.env.PHOTO_EXPORT_ROOT=root;
 const s=access.sessions.get(owner),step=s.step,oldStart=photos.start;s.step='expired';photos.start=async()=>{throw Error('Existing cached photos must not be downloaded again')};
 const wait=async id=>{for(let i=0;i<100;i++){const d=(await http('/photo-exports')).body.jobs.find(x=>x.id===id);if(['completed','partial','failed','awaiting_auth'].includes(d?.status))return d;await new Promise(r=>setTimeout(r,250))}throw Error('Export wait exceeded')};
 try{
  const created=await http('/photo-exports/start',{body:{}});assert.equal(created.status,202);const done=await wait(created.body.id);assert.equal(done.status,'completed');assert.equal(done.saved,2);assert.equal(done.missing,0);
  const folder=done.folder;assert.ok(folder.startsWith(root));assert.equal((await fs.stat(folder)).mode&0o777,0o700);
  const report=JSON.parse(await fs.readFile(path.join(folder,'校验清单.json')));assert.deepEqual(report.headers,['姓名','学号','班级','年级','学校','专业','班号','照片文件名']);assert.equal(report.photoCount,2);assert.equal(report.orphanPhotos,0);
  const binary=await fetch(base+done.downloadPath,{headers:{authorization:'Bearer '+issueToken(owner)}});assert.equal(binary.status,200);assert.equal(Buffer.from(await binary.arrayBuffer()).subarray(0,2).toString(),'PK');
  assert.equal((await http('/photo-exports/'+done.id+'/download',{who:other})).status,404);
  await http('/managed/change',{body:{studentId:'20250003',action:'exclude'}});assert.equal((await http('/photo-exports/'+done.id+'/download')).status,409);await http('/managed/change',{body:{studentId:'20250003',action:'reset'}});
  const [cached]=await pool.query('SELECT * FROM academic_student_photos WHERE openid=?',[owner]);await pool.query('DELETE FROM academic_student_photos WHERE openid=?',[owner]);
  const pending=await http('/photo-exports/start',{body:{}}),auth=await wait(pending.body.id);assert.equal(auth.status,'awaiting_auth');assert.equal(auth.total,2);assert.equal(auth.ready,false);
  for(const r of cached)await pool.query('INSERT INTO academic_student_photos(openid,account_key,student_id,mime,bytes,sha256,encrypted_photo,checked_at) VALUES (?,?,?,?,?,?,?,?)',[r.openid,r.account_key,r.student_id,r.mime,r.bytes,r.sha256,r.encrypted_photo,r.checked_at]);
  await http('/photo-exports/start',{body:{resumeId:auth.id}});const resumed=await wait(auth.id);assert.equal(resumed.status,'completed');assert.equal(resumed.revision,2);
 }finally{photos.start=oldStart;s.step=step;await Promise.allSettled([...exportsService.busy.values()]);await fs.rm(root,{recursive:true,force:true});if(prior===undefined)delete process.env.PHOTO_EXPORT_ROOT;else process.env.PHOTO_EXPORT_ROOT=prior}
});
test('部分照片导出不伪装完成，补齐后保留旧版本并生成新版本',async()=>{
 const fs=require('fs/promises'),path=require('path'),os=require('os'),exp=require('../services/academicPhotoExports'),photos=require('../services/academicPhotos');const root=await fs.mkdtemp(path.join(os.tmpdir(),'partial-export-')),prior=process.env.PHOTO_EXPORT_ROOT;process.env.PHOTO_EXPORT_ROOT=root;
 const original={start:photos.start,jobView:photos.jobView,state:photos.state},[cached]=await pool.query('SELECT * FROM academic_student_photos WHERE openid=? AND student_id=?',[owner,'20250003']);await pool.query('DELETE FROM academic_student_photos WHERE openid=? AND student_id=?',[owner,'20250003']);
 photos.state=async()=>({job:null});photos.start=async()=>({id:'fixture-photo-job'});photos.jobView=async()=>({status:'partial',payload:{failures:[{studentId:'20250003'}]}});
 const wait=async id=>{for(let i=0;i<100;i++){const j=(await http('/photo-exports')).body.jobs.find(x=>x.id===id);if(['partial','completed','failed'].includes(j?.status))return j;await new Promise(r=>setTimeout(r,250))}throw Error('Partial export wait exceeded')};
 try{const task=(await http('/photo-exports/start',{body:{}})).body,j=await wait(task.id);assert.equal(j.status,'partial');assert.equal(j.saved,1);assert.equal(j.missing,1);const first=j.folder;
  for(const r of cached)await pool.query('INSERT INTO academic_student_photos(openid,account_key,student_id,mime,bytes,sha256,encrypted_photo,checked_at) VALUES (?,?,?,?,?,?,?,?)',[r.openid,r.account_key,r.student_id,r.mime,r.bytes,r.sha256,r.encrypted_photo,r.checked_at]);
  await http('/photo-exports/start',{body:{resumeId:j.id}});const done=await wait(j.id);assert.equal(done.status,'completed');assert.equal(done.saved,2);assert.notEqual(done.folder,first);await fs.access(path.join(first,'学生人员名册.xlsx'));await fs.access(path.join(done.folder,'学生人员名册.xlsx'));
 }finally{Object.assign(photos,original);await Promise.allSettled([...exp.busy.values()]);await fs.rm(root,{recursive:true,force:true});if(prior===undefined)delete process.env.PHOTO_EXPORT_ROOT;else process.env.PHOTO_EXPORT_ROOT=prior}
});
test('失效的学工Cookie不带入新教务认证，改用新上下文进入VPN',async()=>{
 const browser=require('../services/browser'),oldAcquire=browser.acquireContext,oldRelease=browser.releaseContext;
 await pool.query('UPDATE academic_sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE openid=?',[owner]);
 let acquired=0,released=0,target;
 browser.acquireContext=async options=>{acquired++;if(acquired===1){assert.ok(options.storageState);return {slot:{},page:{request:{get:async()=>({status:()=>302})}}}}
 assert.equal(options.storageState,undefined);return {slot:{},page:{goto:async url=>{target=url},url:()=> 'https://ids.hit.edu.cn/authserver/reAuthCheck/reAuthLoginView.do',on:()=>{},locator:()=>({count:async()=>1}),evaluate:async()=> '13'}}};browser.releaseContext=async()=>{released++};
 try{await access.start(owner,{requestVerification:false,force:true});await access.sessions.get(owner).job;assert.equal(acquired,2);assert.equal(released,1);assert.equal((await access.status(owner)).step,'code');assert.match(new URL(target).searchParams.get('service'),/ivpn\.hitwh\.edu\.cn/)}finally{browser.acquireContext=oldAcquire;browser.releaseContext=oldRelease;await session(owner,'teacher-A')}
});

test('再次连接复用有效活动页面，加密快照更新为24小时保留而非固定1小时',async()=>{
 const browser=require('../services/browser'),old=browser.acquireContext;let acquired=0;
 browser.acquireContext=async()=>{acquired++;throw Error('must reuse the live session')};
 try{await session(owner,'teacher-A');const prior=access.sessions.peek(owner);await access.start(owner);await prior.job;assert.equal(acquired,0);assert.equal(access.sessions.peek(owner),prior);assert.equal(prior.step,'ready');assert.equal(prior.restoredFrom,'live');
 const [r]=await pool.query('SELECT state_encrypted,TIMESTAMPDIFF(MINUTE,UTC_TIMESTAMP(),expires_at) AS minutes FROM academic_sessions WHERE openid=?',[owner]);assert.ok(Number(r[0].minutes)>=1439);assert.ok(!r[0].state_encrypted.includes('cookies'));
 }finally{browser.acquireContext=old;await session(owner,'teacher-A')}
});
test('成功使用后刷新Cookie快照，短暂网络或503不标成登录过期也不发验证码',async()=>{
 await session(owner,'teacher-A');const s=access.sessions.peek(owner);let version=1;
 s.page.context=()=>({storageState:async()=>({cookies:[],origins:[{origin:'https://example.invalid',localStorage:[{name:'synthetic',value:String(version)}]}]})});
 const result=await access.withSession(owner,async()=>{version=2;return 'success'});assert.equal(result,'success');
 const [r]=await pool.query('SELECT state_encrypted FROM academic_sessions WHERE openid=?',[owner]);assert.equal(JSON.parse(require('../utils/crypto').decrypt(r[0].state_encrypted)).origins[0].localStorage[0].value,'2');
 s.page.request.get=async()=>({status:()=>503});await assert.rejects(access.withSession(owner,async()=>{throw Error('must not run')}),e=>e.code==='ACADEMIC_UNAVAILABLE');assert.equal(s.step,'ready');assert.equal(s.codeRequested,undefined);
 s.page.request.get=async()=>{throw Error('synthetic timeout')};await assert.rejects(access.withSession(owner,async()=>{}),e=>e.code==='ACADEMIC_UNAVAILABLE');assert.equal(s.step,'ready');await session(owner,'teacher-A');
});
test('教务子会话过期但学校SSO有效时，单次官方票据经VPN恢复且不填写验证码',async()=>{
 const browser=require('../services/browser'),oldAcquire=browser.acquireContext,oldRelease=browser.releaseContext;let acquired=0,authenticated=false,navigations=[];
 browser.acquireContext=async options=>{acquired++;assert.ok(options.storageState);return {slot:{},page:{context:()=>({storageState:async()=>({cookies:[],origins:[]})}),goto:async url=>{navigations.push(url);authenticated=true},request:{get:async url=>{
  if(url.includes('/xfj/queryBjxsmd'))return authenticated?{status:()=>200,text:async()=>'<select name="pageZydm"></select>不及格门数'}:{status:()=>302};
  if(url.startsWith('https://ids.hit.edu.cn/authserver/login?'))return {status:()=>302,headers:()=>({location:'http://jwts.hitwh.edu.cn/loginCAS?ticket=synthetic-one-use-ticket'})};
  throw Error('unexpected request');
 }},locator:()=>{throw Error('must not submit credentials or MFA')}}}};browser.releaseContext=async()=>{};
 try{await access.start(owner,{requestVerification:false,force:true});const s=access.sessions.peek(owner);await s.job;assert.equal(s.step,'ready');assert.equal(s.restoredFrom,'sso');assert.equal(acquired,1);assert.equal(navigations.length,1);assert.ok(navigations[0].startsWith(access.ORIGIN+'/loginCAS?ticket='));assert.equal(s.codeRequested,undefined)}finally{browser.acquireContext=oldAcquire;browser.releaseContext=oldRelease;await session(owner,'teacher-A')}
});
test('重复连接保留当前验证码挑战，不新建上下文、不重复发送验证码',async()=>{
 await session(owner,'teacher-A');const s=access.sessions.peek(owner);s.step='code';s.codeRequested=true;
 const browser=require('../services/browser'),old=browser.acquireContext;browser.acquireContext=async()=>{throw Error('must keep the pending challenge')};
 try{const r=await access.start(owner);assert.equal(r.step,'code');assert.equal(access.sessions.peek(owner),s);assert.equal(s.codeRequested,true)}finally{browser.acquireContext=old;await session(owner,'teacher-A')}
});

test('活动会话真实失效后重建连接清除旧挑战标记，不把新验证当作旧验证',async()=>{
 await session(owner,'teacher-A');const old=access.sessions.peek(owner);old.loginAttempted=true;old.codeRequested=true;old.restoredFrom='saved';old.page.request.get=async()=>({status:()=>302});
 const browser=require('../services/browser'),oldAcquire=browser.acquireContext,oldRelease=browser.releaseContext;let acquired=0;
 browser.acquireContext=async options=>{acquired++;if(options.storageState)return {slot:{},page:{request:{get:async()=>({status:()=>302})}}};return {slot:{},page:{goto:async()=>{},url:()=> 'https://ids.hit.edu.cn/authserver/reAuthCheck/reAuthLoginView.do',on:()=>{},locator:()=>({count:async()=>1}),evaluate:async()=> '13'}}};browser.releaseContext=async()=>{};
 try{await access.start(owner,{requestVerification:false});const s=access.sessions.peek(owner);await s.job;assert.equal(s.step,'code');assert.equal(s.loginAttempted,false);assert.equal(s.codeRequested,false);assert.equal(s.restoredFrom,null);assert.equal(acquired,2)}finally{browser.acquireContext=oldAcquire;browser.releaseContext=oldRelease;await session(owner,'teacher-A')}
});

test('同一秒内的新照片任务必须显示最新任务，而不是上一条已完成记录',async()=>{
 const a=await service.actor(owner),older='ffffffff-ffff-4fff-8fff-ffffffffffff',newer='00000000-0000-4000-8000-000000000001';
 const [clock]=await pool.query("SELECT DATE_FORMAT(DATE_ADD(CURRENT_TIMESTAMP(),INTERVAL 2 SECOND),'%Y-%m-%d %H:%i:%s') AS stamp");
 const [columns]=await pool.query('SHOW COLUMNS FROM academic_photo_jobs');assert.match(columns.find(c=>c.Field==='created_at').Type,/\(6\)/);
 for(const [id,fraction] of [[older,'000001'],[newer,'000002']])await pool.query("INSERT INTO academic_photo_jobs(id,openid,account_key,active_key,status,payload,created_at) VALUES (?,?,?,NULL,'completed',?,?)",[id,owner,a.accountKey,JSON.stringify({done:[],total:0,success:0}),clock[0].stamp+'.'+fraction]);
 const latest=await http('/photos/state');assert.equal(latest.status,200);assert.equal(latest.body.job.id,newer);
});
