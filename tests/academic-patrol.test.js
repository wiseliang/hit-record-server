const {test}=require('node:test'),assert=require('node:assert/strict'),{groupCourses}=require('../services/academicPatrol'),{normalizeRecord}=require('../services/gradeAnalysis');
const row=(semester,score,extra={})=>normalizeRecord({semester,code:'A',name:'数学',score,...extra});
const student={studentId:'20250001',name:'测试',className:'1班',cohortKey:'K'};
test('按科目归集去重学生，已补考通过仍保留原始挂科来源',()=>{
 const records=[row('2025秋季','45'),row('2025秋季','50',{sourceIndex:2}),row('2026春季','70',{sourceIndex:3,attempt:'补考'})];
 const r=groupCourses([student],new Map([['K:'+student.studentId,{courses:records,sourceComplete:true}]]),[],'2025秋季','2026秋季');assert.equal(r.courses.length,1);assert.equal(r.courses[0].originalFailed,1);assert.equal(r.courses[0].passed,1);assert.equal(r.courses[0].students[0].score,'50');assert.equal(r.courses[0].students[0].latestPass.score,'70');
});
test('不把未来通过记录、缺考或缓考当作已通过或正式挂科',()=>{
 const records=[row('2026秋季','40'),row('2027春季','70',{attempt:'补考'}),row('2026秋季','0',{code:'B',remark:'缺考'}),row('2026秋季','',{code:'C',remark:'缓考'})];
 const r=groupCourses([student],new Map([['K:'+student.studentId,{courses:records,sourceComplete:true}]]),[],'2026秋季','2026秋季');assert.equal(r.courses.length,1);assert.equal(r.courses[0].unresolved,1);assert.equal(r.issues,2);
});
test('关系待核实单列；不同课程分别计人次，缺少档案不伪造记录',()=>{
 const records=[row('2025秋季','45'),row('2026春季','70',{code:'B',attempt:'重修'}),row('2025秋季','30',{code:'C',name:'物理'})];
 const r=groupCourses([student,{...student,studentId:'20250002'}],new Map([['K:'+student.studentId,{courses:records,sourceComplete:true}]]),[],'2025秋季','2026秋季');assert.equal(r.courses.length,2);assert.equal(r.courses.find(x=>x.code==='A').pending,1);assert.equal(r.courses.find(x=>x.code==='C').unresolved,1);
});
