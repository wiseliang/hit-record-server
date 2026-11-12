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
