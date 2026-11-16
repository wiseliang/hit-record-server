const {test}=require("node:test"),assert=require("node:assert/strict");
const {analyze,normalizeRecord,validScore,validateLinks,cohortKey}=require("../services/gradeAnalysis"),{parseTable}=require("../services/academicParser");
const row=(code,score,attempt="",name=code,index=1)=>normalizeRecord({semester:"2025秋季",code,name,score,attempt,credits:"3",nature:"必修",sourceIndex:index});
test("补考通过消除当前欠账但保留历史考试和失败次数",()=>{
 const records=[row("A","45"),row("A","65","补考","A",2)];
 const a=analyze(records,[],"student",true);
 assert.equal(a.historicalFailedAttempts,1);assert.equal(a.observedUnresolvedCount,0);assert.equal(a.recoveredCount,1);assert.equal(a.courses[0].recovery,"makeup");assert.equal(a.courses[0].attempts.length,2);
});
test("补考未通过只计同一课程一门，不能用失败记录条数充当门数",()=>{
 const a=analyze([row("A","45"),row("A","50","补考","A",2)],[],"s",true);
 assert.equal(a.historicalFailedAttempts,2);assert.equal(a.observedUnresolvedCount,1);
});
test("改名重修只提出候选，教师确认后通过，撤销后恢复",()=>{
 const records=[row("A","40","","高等数学"),row("B","70","重修","工程数学",2)];
 let a=analyze(records,[],"s",true);assert.equal(a.courses.length,2);assert.equal(a.courses.find(c=>c.codes.includes("A")).state,"pending");
 const link={id:"l",student_id:"s",from_code:"A",to_code:"B",active:1,reason:"已核对适用培养方案"};
 a=analyze(records,[link],"s",true);assert.equal(a.courses.length,1);assert.equal(a.observedUnresolvedCount,0);assert.equal(a.recoveredCount,1);assert.equal(a.courses[0].evidence.length,1);
 assert.equal(analyze(records,[{...link,active:0}],"s",true).courses.length,2);
 assert.equal(analyze(records,[link],"other",true).courses.length,2);
});
test("同名不同代码不自动合并；专业关联适用同一调用范围内学生",()=>{
 const records=[row("A","35","","数学"),row("B","80","重修","数学",2)];
 assert.equal(analyze(records,[],"s").courses.length,2);
 assert.equal(analyze(records,[{student_id:"*",from_code:"A",to_code:"B",active:1}],"s").courses.length,1);
});
test("空白缓考异常分数未知，等级按明确含义判断",()=>{
 for(const score of ["","缓考","未发布","缺考","101","-1","免修"])assert.equal(validScore({score}).state,"unknown");
 assert.equal(validScore({score:"45",remark:"成绩已撤销"}).state,"unknown");
 assert.equal(validScore({score:"合格"}).state,"pass");
 assert.equal(validScore({score:"不及格"}).state,"fail");
 assert.equal(analyze([row("A","45"),{...row("A","80","补考","A",2),remark:"撤销"}]).observedUnresolvedCount,1);
});
test("复杂课程替代和循环不允许静默扩展",()=>{
 assert.throws(()=>validateLinks([],{fromCode:"A",toCode:"A",studentId:"s"}));
 assert.throws(()=>validateLinks([{active:1,student_id:"*",from_code:"A",to_code:"B"}],{fromCode:"B",toCode:"C",studentId:"s"}));
 assert.doesNotThrow(()=>validateLinks([{active:1,student_id:"s1",from_code:"A",to_code:"B"}],{fromCode:"A",toCode:"C",studentId:"s2"}));
});
test("管理范围年级院系专业共同定位，不同组合不冲突",()=>{
 assert.notEqual(cohortKey({year:"2025",facultyCode:"02",majorCode:"A"}),cohortKey({year:"2024",facultyCode:"02",majorCode:"A"}));
});
test("成绩表按表头映射，列变化失败，不把空分数变成0",()=>{
 const headers=["总成绩","学年学期","开课院系","课程代码","课程名称","课程性质","课程类别","学分","是否考试课","参与学分绩","补考重修标记","序号","成绩备注","教学班排名"];
 const input={headers,rows:[["","2025秋季","学院","A","数学","必修","基础","3","是","是","","1","",""]]};
 assert.equal(parseTable(input,"detail")[0].score,"");
 assert.throws(()=>parseTable({...input,headers:headers.filter(x=>x!=="总成绩")},"detail"),/结构/);
 assert.throws(()=>parseTable({...input,pagination:true},"detail"),/分页/);
 assert.throws(()=>parseTable({...input,rows:[["","2025秋季","学院","A","数学","必修","基础","3","是","是","","2","",""]]},"detail"),/序号/);
});
test('挂科学分按首次挂科计一次，重修学分变化不覆盖；通过后归零',()=>{
 const first={...row('A','35'),semester:'2024秋季',credits:'2.5'},retry={...row('A','40','重修','A',2),semester:'2025秋季',credits:'4'};
 const a=analyze([retry,first],[],'s',true);assert.equal(a.failedCredits,2.5);assert.equal(a.courses[0].originalCourse.credits,'2.5');assert.equal(a.courses[0].originalCourse.semester,'2024秋季');
 assert.equal(analyze([retry,first,{...row('A','65','重修','A',3),semester:'2026春季',credits:'5'}],[],'s',true).failedCredits,0);
});
test('改名课程确认前保留原始挂科学分，确认通过后扣除；缺学分不冒充零',()=>{
 const records=[{...row('A','30','','原数学'),credits:'3'},{...row('B','75','重修','原数学（重修）',2),credits:'4'},{...row('C','25','','其他课',3),credits:''}];
 const a=analyze(records,[],'s',true);assert.equal(a.failedCredits,3);assert.equal(a.failedCreditUnknownCourses,1);assert.equal(a.courses.find(c=>c.codes.includes('A')).originalCourse.name,'原数学');
 const linked=analyze(records,[{student_id:'s',from_code:'A',to_code:'B',active:1}], 's',true);assert.equal(linked.failedCredits,0);assert.equal(linked.failedCreditUnknownCourses,1);
});
test('旷考计入挂科学分但不查找补考候选，仍允许重修对应核实',()=>{
 const a=analyze([row('A','旷考','','数学'),{...row('B','70','补考','数学',2),semester:'2026春季'},{...row('C','70','重修','数学',3),semester:'2026春季'}],[],'s',true);
 const original=a.courses.find(c=>c.codes.includes('A'));assert.equal(a.failedCredits,3);assert.equal(original.makeupEligible,false);assert.deepEqual(original.candidates.map(x=>x.code),['C']);assert.equal(validScore({score:'0',remark:'旷考'}).state,'fail');
});
test('排除候选只消除提示，保留挂科学分；撤销和另一学生不受影响',()=>{
 const records=[row('A','40','','原数学'),row('B','75','重修','改名数学',2)],review={id:'r',student_id:'s',from_code:'A',to_code:'B',outcome:'reject',active:1};
 const a=analyze(records,[],'s',true,[review]);assert.equal(a.courses[0].candidates.length,0);assert.equal(a.courses[0].state,'unresolved');assert.equal(a.failedCredits,3);
 assert.equal(analyze(records,[],'other',true,[review]).courses[0].candidates.length,1);assert.equal(analyze(records,[],'s',true,[{...review,active:0}]).courses[0].candidates.length,1);
 assert.equal(analyze(records,[],'s',true,[{...review,from_code:'B',to_code:'A'}]).courses[0].candidates.length,0);
});
test('暂缓和异常按成绩指纹生效，不改成绩学分，更新后保留记录并提示重核',()=>{
 const records=[row('A','40')],fingerprint=analyze(records).courses[0].reviewFingerprint;
 for(const outcome of ['defer','issue']){
  const review={id:outcome,student_id:'s',from_code:'A',outcome,active:1,archive_fingerprint:fingerprint};
  const current=analyze(records,[],'s',true,[review]);assert.equal(current.courses[0].state,'pending');assert.equal(current.failedCredits,3);assert.equal(current.courses[0].reviews[0].stale,false);
  const changed=analyze([{...records[0],credits:'4'}],[],'s',true,[review]);assert.equal(changed.courses[0].state,'unresolved');assert.equal(changed.failedCredits,4);assert.equal(changed.courses[0].reviews[0].stale,true);
  const passed=analyze([...records,row('A','70','重修','A',2)],[],'s',true,[review]);assert.equal(passed.courses[0].state,'passed');assert.equal(passed.failedCredits,0);
 }
});
test('排除一个候选不会误删其他候选，记录顺序变化不使暂缓指纹失效',()=>{
 const records=[row('A','40'),row('B','70','重修','B',2),row('C','80','重修','C',3)],base=analyze(records).courses[0];
 const reviews=[{student_id:'s',from_code:'A',to_code:'B',outcome:'reject',active:1}];const a=analyze(records,[],'s',true,reviews);assert.deepEqual(a.courses[0].candidates.map(c=>c.code),['C']);assert.equal(a.courses[0].state,'pending');
 assert.equal(analyze([records[1],records[0],records[2]]).courses.find(c=>c.codes.includes('A')).reviewFingerprint,base.reviewFingerprint);
});
test('看板与巡考使用核对结果，与学生档案同口径',()=>{
 const {summarizeStudent}=require('../services/academicDashboard'),{groupCourses}=require('../services/academicPatrol');const records=[row('A','40'),row('B','70','重修','B',2)],student={studentId:'s',cohortKey:'cohort'},archive={courses:records,sourceComplete:true,checkedAt:'2026-01-01'},reviews=[{student_id:'s',cohort_key:'cohort',from_code:'A',to_code:'B',outcome:'reject',active:1}];
 const summary=summarizeStudent(student,archive,[],'2025秋季',reviews);assert.equal(summary.pending,0);assert.equal(summary.currentFailures,1);assert.equal(summary.failedCredits,3);
 const patrol=groupCourses([student],new Map([['cohort:s',archive]]),[],'2025秋季','2025秋季',reviews);assert.equal(patrol.courses[0].students[0].state,'unresolved');
 const issue={student_id:'s',from_code:'A',outcome:'issue',active:1,archive_fingerprint:analyze(records).courses[0].reviewFingerprint};assert.equal(summarizeStudent(student,archive,[],'2025秋季',[issue]).pending,1);
});
