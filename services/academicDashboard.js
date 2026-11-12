const pool=require('../config/database'),access=require('./academicAccess'),reader=require('./academicSchoolReader'),{AppError}=require('../utils/errors'),{cohortKey,analyze,validScore}=require('./gradeAnalysis');
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const service=()=>require('./academicGrades');
async function managedRoster(a){const [rows]=await pool.query('SELECT payload,overrides,checked_at FROM academic_managed_rosters WHERE openid=? AND account_key=?',[a.openid,a.accountKey]);return rows[0]?{students:parse(rows[0].payload),overrides:parse(rows[0].overrides),checkedAt:rows[0].checked_at}:null}
function memberSet(saved){if(!saved)return null;const ids=new Set(saved.students.map(s=>s.studentId));for(const id of saved.overrides.include||[])ids.add(id);for(const id of saved.overrides.exclude||[])ids.delete(id);return ids}
async function refreshManaged(openid){
 const a=await service().actor(openid),p=await service().profile(a);
 if(!p.scopes.length)throw new AppError(400,'ACADEMIC_SCOPE_REQUIRED','请先选择年级、院系和专业范围');
 const [jobs]=await pool.query('SELECT id FROM academic_jobs WHERE active_key=?',[require('./gradeAnalysis').digest([a.openid,a.accountKey])]);if(jobs.length)throw new AppError(409,'ACADEMIC_BUSY','请先暂停成绩同步，再更新所带名单');
 const school=await require('./schoolSession').getSession(openid);
 if(school.accountKey!==a.accountKey)throw new AppError(409,'SCHOOL_ACCOUNT_CHANGED','学工和教务账号不一致，请重新连接');
 if(school.busyPlan)throw new AppError(409,'TASK_ACTIVE','学工连接正在处理任务，请稍后匹配');
 const r=await school.page.request.post('https://xuegong.hitwh.edu.cn/zhxy-xgzs/xg_fdygzrz/rzgl/getXsList',{timeout:15000});let body;try{body=await r.json()}catch{}
 if(!r.ok()||body?.isSuccess!==true||!Array.isArray(body.module))throw new AppError(502,'SCHOOL_ROSTER_INVALID','未能读取学工所带名单，保留上次名单');
 const own=body.module.map(x=>({studentId:String(x.xh||''),name:String(x.xm||''),major:String(x.zymc||'')}));
 if(own.some(x=>!/^\d{8,16}$/.test(x.studentId))||new Set(own.map(x=>x.studentId)).size!==own.length||!own.length)throw new AppError(502,'SCHOOL_ROSTER_INVALID','学工名单为空或不完整，保留上次名单');
 const ids=new Set(own.map(x=>x.studentId)),found=new Map(),extra=[],all=new Map();
 await access.withSession(openid,async s=>{
  const pairs=[...new Map(p.scopes.map(x=>[x.year+':'+x.facultyCode,x])).values()];
  for(const scope of pairs){
   const options=await reader.options(s,{year:scope.year,facultyCode:scope.facultyCode});
   const rows=await reader.roster(s,{...scope,majorCode:'-1'});
   for(const major of options.majors){const group=rows.filter(x=>x.major.trim()===major.label.trim());if(!group.some(x=>ids.has(x.studentId)))continue;
    const candidate={year:scope.year,facultyCode:scope.facultyCode,majorCode:major.value,classes:[]};candidate.key=cohortKey(candidate);all.set(candidate.key,group);
    if(!p.scopes.some(x=>x.key===candidate.key))extra.push(candidate);
    for(const x of group)if(ids.has(x.studentId))found.set(x.studentId,{cohortKey:candidate.key,className:x.className});
   }
  }
 });
 if(extra.length)await service().saveProfile(openid,{revision:p.revision,scopes:[...p.scopes,...extra]});
 for(const [key,rows] of all)await pool.query('INSERT INTO academic_rosters(openid,account_key,cohort_key,payload,checked_at) VALUES (?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE payload=VALUES(payload),checked_at=VALUES(checked_at)',[a.openid,a.accountKey,key,JSON.stringify(rows)]);
 const students=own.map(x=>({...x,...found.get(x.studentId)}));
 await pool.query("INSERT INTO academic_managed_rosters(openid,account_key,payload,overrides,checked_at) VALUES (?,?,?,'{}',UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE payload=VALUES(payload),checked_at=VALUES(checked_at)",[a.openid,a.accountKey,JSON.stringify(students)]);
 return {total:own.length,matched:found.size,unmatched:own.length-found.size};
}
async function override(openid,body){
 const a=await service().actor(openid),saved=await managedRoster(a);if(!saved)throw new AppError(400,'MANAGED_REQUIRED','请先匹配学工所带名单');
 if(!['include','exclude','reset'].includes(body.action)||typeof body.studentId!=='string')throw new AppError(400,'INVALID_MANAGED_CHANGE','请选择学生及调整方式');
 const [jobs]=await pool.query('SELECT id FROM academic_jobs WHERE active_key=?',[require('./gradeAnalysis').digest([a.openid,a.accountKey])]);if(jobs.length)throw new AppError(409,'ACADEMIC_BUSY','请先暂停同步，再调整名单');
 const p=await service().profile(a),[rows]=await pool.query('SELECT cohort_key,payload FROM academic_rosters WHERE openid=? AND account_key=?',[a.openid,a.accountKey]);
 const present=rows.some(r=>p.scopes.some(s=>s.key===r.cohort_key)&&parse(r.payload).some(x=>x.studentId===body.studentId));
 if(!present&&!saved.students.some(x=>x.studentId===body.studentId))throw new AppError(404,'ACADEMIC_STUDENT_NOT_FOUND','该生不在当前可核对名单中');
 const o=saved.overrides;for(const k of ['include','exclude'])o[k]=(o[k]||[]).filter(x=>x!==body.studentId);if(body.action!=='reset')o[body.action].push(body.studentId);
 await pool.query('UPDATE academic_managed_rosters SET overrides=? WHERE openid=? AND account_key=?',[JSON.stringify(o),a.openid,a.accountKey]);return {saved:true};
}
function termOrder(label){const m=String(label).match(/(\d{4}).*(春季|夏季|秋季)/);return m?Number(m[1])*10+({'春季':1,'夏季':2,'秋季':3}[m[2]]):null}
function currentTerm(calendar){const m=String(calendar?.academicYear||'').match(/\d{4}/);return m&&calendar?.semester?(Number(m[0])+(calendar.semester==='秋季'?0:1))+calendar.semester:null}
function summarizeStudent(row,archive,relationships,term){
 const history=archive?analyze(archive.courses,relationships,row.studentId,archive.sourceComplete):null,order=termOrder(term),risk=[],recoveries=[];
 for(const c of history?.courses||[]){
  const attempts=c.attempts.filter(x=>termOrder(x.semester)!==null&&termOrder(x.semester)<=order),passed=attempts.some(x=>validScore(x).state==='pass'),fail=attempts.filter(x=>validScore(x).state==='fail');
  if(passed&&fail.length){const latest=attempts.filter(x=>validScore(x).state==='pass').sort((a,b)=>termOrder(b.semester)-termOrder(a.semester)||b.sourceIndex-a.sourceIndex)[0];recoveries.push({name:latest.name,code:latest.code,semester:latest.semester,score:latest.score,credits:latest.credits,attempt:latest.attempt||'已通过'})}
  const unknown=attempts.filter(x=>validScore(x).state==='unknown');if(passed||!attempts.length||(!fail.length&&!unknown.length))continue;
  const last=[...(fail.length?fail:unknown)].sort((a,b)=>termOrder(b.semester)-termOrder(a.semester)||b.sourceIndex-a.sourceIndex)[0];
  const ambiguous=!fail.length||c.candidates.some(x=>termOrder(x.semester)!==null&&termOrder(x.semester)<=order)||unknown.length>0||attempts.some(x=>/缺考|缓考|作弊/.test(x.score+' '+x.remark));
  risk.push({code:last.code,name:last.name,semester:last.semester,score:last.score,credits:last.credits,state:ambiguous?'pending':'unresolved',bucket:termOrder(last.semester)===order?'current':'historical'});
 }
 const visible=(archive?.courses||[]).filter(x=>termOrder(x.semester)!==null&&termOrder(x.semester)<=order);
 return {...row,checkedAt:archive?.checkedAt||null,recordCount:archive?.courses.length??null,publishedCourses:[...new Map(visible.filter(x=>x.semester===term&&validScore(x).state!=='unknown'&&!/缺考|缓考|作弊/.test(x.score+' '+x.remark)).map(x=>[x.code,{code:x.code,name:x.name}])).values()],currentPublished:visible.filter(x=>x.semester===term&&validScore(x).state!=='unknown'&&!/缺考|缓考|作弊/.test(x.score+' '+x.remark)).length,currentFailures:risk.filter(x=>x.bucket==='current'&&x.state==='unresolved').length,historicalFailures:risk.filter(x=>x.bucket==='historical'&&x.state==='unresolved').length,pending:risk.filter(x=>x.state==='pending').length,recoveredCount:recoveries.length,recoveries,risk,unresolvedCount:history?.observedUnresolvedCount??null};
}
async function dashboard(openid,query={}){
 const a=await service().actor(openid),p=await service().profile(a),saved=await managedRoster(a),ids=memberSet(saved);
 const [cache]=await pool.query('SELECT cohort_key,payload FROM academic_rosters WHERE openid=? AND account_key=?',[a.openid,a.accountKey]);
 const [archives]=await pool.query('SELECT cohort_key,student_id,payload FROM academic_archives WHERE openid=? AND account_key=?',[a.openid,a.accountKey]);
 const [links]=await pool.query('SELECT * FROM academic_links WHERE openid=? AND account_key=? AND active=1',[a.openid,a.accountKey]);
 const school=await require('./schoolSession').status(openid),calendar=school.calendar||{},defaultTerm=currentTerm(calendar);
 const terms=new Set(defaultTerm?[defaultTerm]:[]);for(const r of archives)for(const c of parse(r.payload).courses)terms.add(c.semester);
 const sorted=[...terms].filter(x=>termOrder(x)!==null).sort((a,b)=>termOrder(b)-termOrder(a));
 const term=query.term||defaultTerm||sorted[0]||null;if(term&&termOrder(term)===null)throw new AppError(400,'INVALID_TERM','请选择有效学期');
 const index=new Map(archives.map(r=>[r.cohort_key+':'+r.student_id,parse(r.payload)])),people=new Map();
 for(const r of cache){const scope=p.scopes.find(x=>x.key===r.cohort_key);if(!scope)continue;for(const row of parse(r.payload)){
  if(query.range!=='professional'&&!(ids?ids.has(row.studentId):service().managed(scope,row)))continue;
  if(query.cohortKey&&query.cohortKey!==r.cohort_key)continue;
  people.set(row.studentId,summarizeStudent({...row,cohortKey:r.cohort_key},index.get(r.cohort_key+':'+row.studentId),links.filter(x=>x.cohort_key===r.cohort_key),term));
 }}
 if(query.range!=='professional'&&saved)for(const row of saved.students)if(ids.has(row.studentId)&&!people.has(row.studentId)&&!query.cohortKey)people.set(row.studentId,{...row,cohortKey:null,risk:[],recordCount:null,checkedAt:null,currentFailures:0,historicalFailures:0,pending:0,currentPublished:0});
 const students=[...people.values()],synced=students.filter(x=>x.checkedAt),coverage={total:students.length,synced:synced.length,missing:students.length-synced.length,currentNoGrades:students.filter(x=>!x.currentPublished).length,complete:students.length>0&&synced.length===students.length};
 const counts={currentStudents:students.filter(x=>x.currentFailures>0).length,currentCourses:students.reduce((n,x)=>n+x.currentFailures,0),historicalStudents:students.filter(x=>x.historicalFailures>0).length,historicalCourses:students.reduce((n,x)=>n+x.historicalFailures,0),pendingStudents:students.filter(x=>x.pending>0).length,recoveredStudents:students.filter(x=>x.recoveredCount>0).length};
 const byCourse=new Map();for(const student of students){for(const r of student.publishedCourses||[]){if(!byCourse.has(r.code))byCourse.set(r.code,{code:r.code,name:r.name,publishedStudents:0,failedStudents:0});byCourse.get(r.code).publishedStudents++}for(const r of student.risk.filter(x=>x.bucket==='current'&&x.state==='unresolved')){if(!byCourse.has(r.code))byCourse.set(r.code,{code:r.code,name:r.name,publishedStudents:0,failedStudents:0});byCourse.get(r.code).failedStudents++}}
 const courses=[...byCourse.values()].filter(x=>x.failedStudents>0).map(x=>({...x,failedRate:x.publishedStudents?Math.round(x.failedStudents/x.publishedStudents*1000)/10:null})).sort((a,b)=>b.failedStudents-a.failedStudents);
 let shown=students;
 if(query.view==='current')shown=shown.filter(x=>x.currentFailures>0);if(['historical','makeup'].includes(query.view))shown=shown.filter(x=>x.historicalFailures>0);if(query.view==='missing')shown=shown.filter(x=>!x.checkedAt);if(query.view==='pending')shown=shown.filter(x=>x.pending>0);if(query.view==='recovered')shown=shown.filter(x=>x.recoveredCount>0);
 if(query.q)shown=shown.filter(x=>(x.name+' '+x.studentId+' '+(x.className||'')).includes(String(query.q).slice(0,80)));
 shown.sort((a,b)=>b.currentFailures-a.currentFailures||b.historicalFailures-a.historicalFailures||String(a.studentId).localeCompare(String(b.studentId)));
 const total=shown.length,offset=Math.max(0,Number(query.offset)||0),limit=Math.min(100,Math.max(1,Number(query.limit)||50));
 return {term,defaultTerm,calendarVerified:calendar.source==='school_week_api',terms:sorted,profile:p,scopeSource:saved?'school':'classes',managedCheckedAt:saved?.checkedAt||null,overrides:saved?.overrides||{},range:query.range==='professional'?'professional':'managed',coverage,counts,courses,total,students:shown.slice(offset,offset+limit),makeupNote:'依据所选学期之前尚未通过课程生成，含往期欠课；是待补考核对名单，不代表学校正式补考资格',connection:await access.status(openid)};
}
function csv(data){const safe=v=>{let s=String(v??'');if(/^[\s]*[=+@\-\t\r\n]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'};const rows=[['统计学期',data.term],['统计范围',data.range==='professional'?'全专业':'我的学生'],['历史同步覆盖',data.coverage?data.coverage.synced+'/'+data.coverage.total:'未知'],['说明','仅为待核对名单，不代表学校正式补考资格；缺少成绩不代表没有挂科。'],['姓名','学号','班级','查询学期','课程','课程代码','原考试学期','成绩','学分','待核对状态']];for(const s of data.students){const risk=data.exportView==='recovered'?(s.recoveries||[]):s.risk.filter(r=>data.exportView==='current'?r.bucket==='current'&&r.state==='unresolved':['historical','makeup'].includes(data.exportView)?r.bucket==='historical'&&r.state==='unresolved':true);for(const r of risk)rows.push([s.name,s.studentId,s.className,data.term,r.name,r.code,r.semester,r.score,r.credits,data.exportView==='recovered'?'已有明确通过记录':r.state==='pending'?'关系或成绩待核实':'仍未通过（补考资格待核对）'])}return '\uFEFF'+rows.map(r=>r.map(safe).join(',')).join('\r\n')}
async function exportList(openid,query){let data=await dashboard(openid,{...query,offset:0,limit:100});const students=[...data.students];while(students.length<data.total){const page=await dashboard(openid,{...query,offset:students.length,limit:100});students.push(...page.students);if(!page.students.length)break}return {filename:'学业风险核对名单_'+data.term+'.csv',content:csv({...data,students,exportView:query.view}),coverage:data.coverage}}
module.exports={managedRoster,memberSet,refreshManaged,override,dashboard,termOrder,currentTerm,summarizeStudent,exportList,csv};
