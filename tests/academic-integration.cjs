const {test,before,after}=require("node:test"),assert=require("node:assert/strict"),{randomUUID}=require("crypto");
if(!/_(test|stage)$/.test(process.env.DB_NAME||""))throw Error("Isolated test database required");
const pool=require("../config/database"),access=require("../services/academicAccess"),service=require("../services/academicGrades"),reader=require("../services/academicSchoolReader"),credential=require("../models/credential"),{issueToken}=require("../utils/session"),{normalizeRecord,digest}=require("../services/gradeAnalysis");
const owner="academic_test_"+randomUUID(),other=owner+"_other",scope={year:"2025",facultyCode:"F",majorCode:"M",classes:["classA"]};
let server,base,key,linkId,firstJob,gate,unblock,calls=0;
const records=[{studentId:"20250001",name:"测试甲",className:"classA",year:"2025",faculty:"院系",major:"专业",weightedScore:"80",schoolFailedCount:"1",classRank:"1"},{studentId:"20250002",name:"测试乙",className:"classB",year:"2025",faculty:"院系",major:"专业",weightedScore:"85",schoolFailedCount:"0",classRank:"2"},{studentId:"20250003",name:"测试丙",className:"classA",year:"2025",faculty:"院系",major:"专业",weightedScore:"70",schoolFailedCount:"1",classRank:"3"}];
const courses=[normalizeRecord({semester:"2025秋季",code:"A",name:"原数学",score:"45",credits:"3",nature:"必修"}),normalizeRecord({semester:"2026春季",code:"B",name:"改名数学",score:"75",attempt:"重修",credits:"3",nature:"必修"},1)];
const original={...reader};
async function session(who,account){await credential.saveCredential(who,account,"fixture-password");access.sessions.set(who,{openid:who,accountKey:access.accountKey(account),step:"ready",page:{request:{get:async()=>({status:()=>200,text:async()=>'<select name="pageZydm"></select>不及格门数'})}}})}
async function http(path,{who=owner,body,method}={}){const r=await fetch(base+"/api/academic-grades"+path,{method:method||(body?"POST":"GET"),headers:{authorization:"Bearer "+issueToken(who),"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()}}
async function waitJob(id,states){for(let i=0;i<150;i++){const job=(await http("/sync/"+id)).body;if(states.includes(job.status))return job;await new Promise(r=>setTimeout(r,25))}throw Error("Job wait exceeded")}
before(async()=>{
 await require("../scripts/migrate-v12").migrate();await session(owner,"teacher-A");await session(other,"teacher-B");
 reader.options=async()=>({years:[{value:"2025",label:"2025"}],faculties:[{value:"F",label:"院系"}],majors:[{value:"M",label:"专业"}],classes:[{value:"classA",label:"classA"},{value:"classB",label:"classB"}],terms:[{value:"T",label:"2025秋季"}]});
 reader.roster=async()=>records;
 reader.grades=async()=>{calls++;if(gate)await gate;return courses};
 reader.course=async()=>records.map(r=>({...r,code:"A",courseName:"原数学",score:"45",majorRank:"1"}));
 server=require("../app").listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));base="http://127.0.0.1:"+server.address().port;
});
after(async()=>{
 unblock?.();await Promise.allSettled([...service.busy.values()]);Object.assign(reader,original);
 for(const who of [owner,other])await access.sessions.dispose(who);
 if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}
 for(const table of ["school_account_bindings","academic_jobs","academic_links","academic_archives","academic_rosters","academic_profiles","academic_sessions","school_login_sessions","credentials"])await pool.query("DELETE FROM "+table+" WHERE openid IN (?,?)",[owner,other]);
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
 for(let i=0;i<100;i++){const j=(await http("/sync/"+firstJob)).body;if(j.payload.current)break;await new Promise(r=>setTimeout(r,20))}
 assert.equal((await http("/sync",{body:{}})).status,409);
 assert.equal((await http("/profile",{body:{revision:1,scopes:[scope]}})).status,409);
 assert.equal((await http("/sync/"+firstJob,{who:other})).status,404);
 await http("/sync/"+firstJob+"/pause",{body:{}});gate=null;unblock();
 const paused=await waitJob(firstJob,["paused"]);assert.equal(paused.payload.success,1);
 const count=calls;
 await http("/sync",{body:{resumeId:firstJob}});
 const done=await waitJob(firstJob,["completed"]);assert.equal(done.payload.success,3);assert.equal(calls-count,2);
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
