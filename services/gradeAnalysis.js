const crypto = require("crypto");
const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();
const digest = v => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
function cohortKey(scope) { return digest([scope.year, scope.facultyCode, scope.majorCode]); }
function validScore(record) {
  const value = clean(record.score), remark = clean(record.remark);
  if (/撤销|作废|取消|缓考|待定|未发布|未录入|免修/.test(value+" "+remark)) return {state:"unknown",value};
  if (/^[+-]?\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    return n >= 0 && n <= 100 ? {state:n >= 60 ? "pass":"fail",value,numeric:n,rule:"百分制60分"} : {state:"unknown",value};
  }
  if (/^(优|优秀|良|良好|中|中等|及格|合格|通过)$/.test(value)) return {state:"pass",value,rule:"明确通过等级"};
  if (/^(不及格|不合格|未通过)$/.test(value)) return {state:"fail",value,rule:"明确未通过等级"};
  return {state:"unknown",value};
}
function normalizeRecord(record, index=0) {
  const fields=["semester","faculty","code","name","nature","category","credits","exam","weighted","attempt","score","remark","rank"];
  const out=Object.fromEntries(fields.map(k=>[k,clean(record[k])]));
  if (!out.code || !out.name || !out.semester) throw Error("成绩必需字段缺失");
  out.sourceIndex=Number(record.sourceIndex)||index+1;
  out.id=digest([out.semester,out.code,out.attempt,out.score,out.remark,out.sourceIndex]);
  return out;
}
const isRetake = r => /补考|重修/.test(r.attempt);
const isInvalid = r => /撤销|作废|取消/.test(r.score+" "+r.remark);
function analyze(records, links=[], studentId, complete=false) {
  const relevant=links.filter(l=>l.active!==0 && l.active!==false && (l.student_id==="*" || l.student_id===studentId || l.studentId===studentId));
  const parent=new Map();
  const find=c=>{if(!parent.has(c))parent.set(c,c); let n=c;const seen=new Set();while(parent.get(n)!==n&&!seen.has(n)){seen.add(n);n=parent.get(n)}return n};
  for(const r of records)find(r.code);
  for(const l of relevant) {
    const a=l.from_code||l.fromCode,b=l.to_code||l.toCode;
    if(parent.has(a)&&parent.has(b))parent.set(find(b),find(a));
  }
  const grouped=new Map();
  for(const r of records) {const k=find(r.code);if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push(r)}
  const passedRetakes=records.filter(r=>isRetake(r)&&validScore(r).state==="pass");
  const courses=[...grouped].map(([key,attempts])=>{
    const effective=attempts.filter(r=>!isInvalid(r));
    const passed=effective.filter(r=>validScore(r).state==="pass");
    const failed=effective.filter(r=>validScore(r).state==="fail");
    const unknown=effective.filter(r=>validScore(r).state==="unknown");
    const names=[...new Set(attempts.map(r=>r.name))],codes=[...new Set(attempts.map(r=>r.code))];
    // Candidates are hints only. Never use text similarity to erase a failed requirement.
    const candidates = failed.length && !passed.length ? passedRetakes.filter(r=>
      !codes.includes(r.code) && failed.some(f=>
        (clean(f.name).replace(/[（(].*?[）)]/g,"")===clean(r.name).replace(/[（(].*?[）)]/g,"")) ||
        (Number(f.credits)>0 && Number(f.credits)===Number(r.credits) && f.nature===r.nature)
      )).map(r=>({code:r.code,name:r.name,semester:r.semester,score:r.score})) : [];
    let state=passed.length?"passed":failed.length?"unresolved":"unknown";
    if (state==="unresolved" && (candidates.length || unknown.length)) state="pending";
    const recovery=passed.some(r=>/重修/.test(r.attempt))?"retake":passed.some(r=>/补考/.test(r.attempt))?"makeup":codes.length>1 && passed.length?"linked":null;
    return {key,names,codes,state,recovery,everFailed:failed.length>0,failedAttempts:failed.length,attempts,candidates,
      evidence:relevant.filter(l=>codes.includes(l.from_code||l.fromCode)&&codes.includes(l.to_code||l.toCode)).map(l=>({id:l.id,reason:l.reason,source:"teacher",createdAt:l.created_at}))};
  });
  return {
    courses,
    historicalFailedAttempts:records.filter(r=>!isInvalid(r)&&validScore(r).state==="fail").length,
    historicalFailedCourses:courses.filter(c=>c.everFailed).length,
    observedUnresolvedCount:courses.filter(c=>c.state==="unresolved").length,
    pendingCount:courses.filter(c=>c.state==="pending" || c.state==="unknown").length,
    recoveredCount:courses.filter(c=>c.everFailed&&c.state==="passed").length,
    coverage:complete?"教务当前可返回的全部记录":"历史数据覆盖不完整",
    formalDecision:false,
  };
}
function validateLinks(links, proposed) {
  if(proposed.fromCode===proposed.toCode)throw Error("请选择两门不同代码的课程");
  const relevant=links.filter(l=>l.active && (l.student_id==="*"||proposed.studentId==="*"||l.student_id===proposed.studentId));
  for(const l of relevant)if(l.from_code===proposed.fromCode || l.to_code===proposed.toCode || l.to_code===proposed.fromCode || l.from_code===proposed.toCode)
    throw Error("课程已有对应关系，请先撤销原关系；复杂替代关系需另行核实");
}
module.exports={clean,digest,cohortKey,validScore,normalizeRecord,analyze,validateLinks};
