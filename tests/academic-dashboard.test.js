const {test}=require('node:test'),assert=require('node:assert/strict'),d=require('../services/academicDashboard'),{normalizeRecord}=require('../services/gradeAnalysis');
const course=(semester,score,extra={})=>normalizeRecord({semester,code:'A',name:'数学',score,credits:'3',...extra});
const student={studentId:'20250001',name:'测试'};
test('所带学生使用完整学号，手动加入排除可覆盖学校名单',()=>{assert.deepEqual([...d.memberSet({students:[{studentId:'A'},{studentId:'B'}],overrides:{include:['C'],exclude:['B']}})],['A','C']);assert.equal(d.memberSet(null),null)});
test('学校学期跨学年正确，春夏秋排序明确',()=>{assert.equal(d.currentTerm({academicYear:'2025—2026',semester:'春季'}),'2026春季');assert.equal(d.currentTerm({academicYear:'2026—2027',semester:'秋季'}),'2026秋季');assert.ok(d.termOrder('2026夏季')>d.termOrder('2026春季'))});
test('未来补考通过不能抹去所选历史学期挂科，通过后从待核对名单移出',()=>{const archive={courses:[course('2025秋季','45'),course('2026春季','70',{attempt:'补考'})],checkedAt:'2026-10-01',sourceComplete:true};assert.equal(d.summarizeStudent(student,archive,[],'2025秋季').currentFailures,1);assert.equal(d.summarizeStudent(student,archive,[],'2026春季').historicalFailures,0);assert.equal(d.summarizeStudent(student,archive,[],'2026春季').recoveredCount,1)});
test('往期欠课进入新学期核对，本学期未出分和缺考均不当作正式挂科',()=>{const archive={courses:[course('2025秋季','45'),course('2026秋季','',{code:'B',name:'物理'}),course('2026秋季','0',{code:'C',name:'化学',remark:'缺考'})],sourceComplete:true};const s=d.summarizeStudent(student,archive,[],'2026秋季');assert.equal(s.historicalFailures,1);assert.equal(s.currentFailures,0);assert.equal(s.pending,2);assert.equal(s.currentPublished,0)});
test('课程改名对应需明确关系，通过后的课程不再计为欠课',()=>{const a={courses:[course('2025秋季','45'),course('2026春季','70',{code:'B',name:'高数重修',attempt:'重修'})],sourceComplete:true};const links=[{active:1,student_id:student.studentId,from_code:'A',to_code:'B'}];assert.equal(d.summarizeStudent(student,a,links,'2026秋季').historicalFailures,0)});
test('CSV保护公式并包含覆盖口径与资格说明',()=>{const text=d.csv({term:'2026秋季',range:'managed',coverage:{synced:1,total:2},students:[{name:'=1+1',studentId:'20250001',risk:[{name:'数学',score:'45',code:'A',bucket:'historical',state:'unresolved'}]}],exportView:'makeup'});assert.match(text,/历史同步覆盖/);assert.match(text,/'=1\+1/);assert.match(text,/不代表学校正式补考资格/)});
test('挂科学分截至所选学期，不受未来通过影响且取原始学分',()=>{
 const archive={courses:[course('2024秋季','30',{credits:'2.5'}),course('2025秋季','40',{credits:'4',attempt:'重修'}),course('2026春季','70',{credits:'5',attempt:'重修'})],sourceComplete:true};
 assert.equal(d.summarizeStudent(student,archive,[],'2025秋季').failedCredits,2.5);assert.equal(d.summarizeStudent(student,archive,[],'2025秋季').risk[0].credits,'2.5');assert.equal(d.summarizeStudent(student,archive,[],'2026秋季').failedCredits,0);assert.equal(d.summarizeStudent(student,null,[],'2026秋季').failedCredits,null);
});
test('旷考挂科保留在历史学分和风险中，从补考核对人数中剔除',()=>{
 const s=d.summarizeStudent(student,{courses:[course('2025秋季','旷考')],sourceComplete:true},[],'2026秋季');assert.equal(s.failedCredits,3);assert.equal(s.historicalFailures,1);assert.equal(s.makeupFailures,0);assert.equal(s.risk[0].makeupEligible,false);
});
test('学分导出保留已通过零学分学生与未同步状态，不漏掉没有风险明细的学生',()=>{
 const content=d.csv({term:'2026秋季',range:'managed',exportView:'credits',students:[{name:'已通过示例',studentId:'A',failedCredits:0,risk:[],checkedAt:'2026-01-01'},{name:'未同步示例',studentId:'B',failedCredits:null,risk:[],checkedAt:null}]});assert.match(content,/已通过示例/);assert.match(content,/未同步示例/);assert.match(content,/尚未同步/);assert.match(content,/首次挂科/);
});
