const pool=require('../config/database'),dashboard=require('./academicDashboard'),grades=require('./academicGrades'),{analyze,validScore,noMakeup}=require('./gradeAnalysis');
const parse=v=>typeof v==='string'?JSON.parse(v):v;
function groupCourses(students,archives,links,term,asOf=term){
 const groups=new Map();let issues=0,excludedAbsences=0;
 for(const student of students){const archive=archives.get(student.cohortKey+':'+student.studentId);if(!archive)continue;
  const records=archive.courses.filter(r=>dashboard.termOrder(r.semester)<=dashboard.termOrder(asOf));
  const analysis=analyze(records,links.filter(l=>l.cohort_key===student.cohortKey),student.studentId,archive.sourceComplete);
  const failed=new Map();
  for(const r of records.filter(r=>r.semester===term)){
   if(noMakeup(r)){excludedAbsences++;continue}
   if(/缺考|缓考|作弊/.test(r.score+' '+r.remark)){issues++;continue}
   if(validScore(r).state!=='fail')continue;
   const prior=failed.get(r.code);if(!prior||r.sourceIndex>prior.sourceIndex)failed.set(r.code,r);
  }
  for(const [code,r] of failed){
   const course=analysis.courses.find(c=>c.codes.includes(code));if(course?.makeupEligible===false){if(!records.some(x=>x.semester===term&&x.code===code&&noMakeup(x)))excludedAbsences++;continue;}const state=course?.state==='passed'?'passed':course?.state==='unresolved'?'unresolved':'pending';
   const latestPass=course?.attempts.filter(x=>validScore(x).state==='pass').sort((a,b)=>dashboard.termOrder(b.semester)-dashboard.termOrder(a.semester)||b.sourceIndex-a.sourceIndex)[0];
   if(!groups.has(code))groups.set(code,{code,name:r.name,students:[]});
   groups.get(code).students.push({studentId:student.studentId,name:student.name,className:student.className,cohortKey:student.cohortKey,score:r.score,credits:r.credits,state,latestPass:latestPass?{semester:latestPass.semester,score:latestPass.score,attempt:latestPass.attempt}:null,checkedAt:archive.checkedAt});
  }
 }
 const rank={unresolved:0,pending:1,passed:2};const courses=[...groups.values()].map(c=>({...c,originalFailed:c.students.length,unresolved:c.students.filter(x=>x.state==='unresolved').length,pending:c.students.filter(x=>x.state==='pending').length,passed:c.students.filter(x=>x.state==='passed').length,students:c.students.sort((a,b)=>rank[a.state]-rank[b.state]||a.studentId.localeCompare(b.studentId))})).sort((a,b)=>(b.unresolved+b.pending)-(a.unresolved+a.pending)||a.code.localeCompare(b.code));
 return {courses,issues,excludedAbsences};
}
async function patrol(openid,query={}){
 const a=await grades.actor(openid),first=await dashboard.dashboard(openid,{term:query.term,cohortKey:query.cohortKey,limit:100}),students=[...first.students];
 while(students.length<first.total){const page=await dashboard.dashboard(openid,{term:first.term,cohortKey:query.cohortKey,offset:students.length,limit:100});if(!page.students.length)break;students.push(...page.students)}
 const [rows]=await pool.query('SELECT cohort_key,student_id,payload FROM academic_archives WHERE openid=? AND account_key=?',[a.openid,a.accountKey]);const [links]=await pool.query('SELECT * FROM academic_links WHERE openid=? AND account_key=? AND active=1',[a.openid,a.accountKey]);
 const archives=new Map(rows.map(r=>[r.cohort_key+':'+r.student_id,parse(r.payload)])),result=groupCourses(students,archives,links,first.term,first.defaultTerm||first.term);
 const needsOnly=query.includePassed!=='true',courses=result.courses.map(c=>({...c,students:needsOnly?c.students.filter(s=>s.state!=='passed'):c.students})).filter(c=>c.students.length);
 const people=new Set(courses.flatMap(c=>c.students.map(s=>s.studentId)));
 return {term:first.term,asOf:first.defaultTerm||first.term,terms:first.terms,profile:first.profile,coverage:first.coverage,courses,courseCount:courses.length,studentCount:people.size,studentCourseCount:courses.reduce((n,c)=>n+c.students.length,0),issues:result.issues,excludedAbsences:result.excludedAbsences,includePassed:!needsOnly,note:'旷考无补考机会，已从补考核对中排除。按原考试学期汇总所带学生的明确不及格记录，状态结合截至当前学期的补考、重修结果；待核对不等于已取得补考资格，考试时间地点以学校安排为准'};
}
async function exportPatrol(openid,query){const data=await patrol(openid,query),quote=v=>'"'+(/^[\s]*[=+@\-\t\r\n]/.test(String(v??''))?"'":'')+String(v??'').replace(/"/g,'""')+'"';const rows=[['原考试学期',data.term],['历史同步覆盖',data.coverage.synced+'/'+data.coverage.total],['说明',data.note],['课程代码','课程名称','姓名','学号','班级','原始成绩','当前核对状态','最新通过学期','最新通过成绩']];for(const c of data.courses)for(const s of c.students)rows.push([c.code,c.name,s.name,s.studentId,s.className,s.score,({passed:'已有明确通过记录',unresolved:'仍未通过，补考资格待核对',pending:'课程关系或成绩待核实'})[s.state],s.latestPass?.semester,s.latestPass?.score]);return {filename:'补考巡考核对名单_'+data.term+'.csv',content:'\uFEFF'+rows.map(r=>r.map(quote).join(',')).join('\r\n')}}
module.exports={patrol,groupCourses,exportPatrol};
