const pool=require('../config/database'),{AppError}=require('../utils/errors'),{randomUUID}=require('crypto'),{analyze}=require('./gradeAnalysis');
const parse=x=>typeof x==='string'?JSON.parse(x):x,owner=a=>[a.openid,a.accountKey];
const samePair=(r,a,b)=>(r.from_code===a&&r.to_code===b)||(r.from_code===b&&r.to_code===a);
async function list(a,key,db=pool){const [rows]=await db.query('SELECT id,cohort_key,student_id,from_code,to_code,outcome,reason,archive_fingerprint,active,created_at,revoked_at FROM academic_reviews WHERE openid=? AND account_key=? AND cohort_key=? ORDER BY created_at DESC,id DESC',[...owner(a),key]);return rows}
async function change(openid,body){
 const grades=require('./academicGrades'),a=await grades.actor(openid);await grades.scopeFor(a,body.cohortKey);
 if(typeof body.studentId!=='string'||!body.studentId||body.studentId==='*'||body.studentId.length>64)throw new AppError(400,'INVALID_ACADEMIC_REVIEW','请选择当前学生');
 const db=await pool.getConnection();let savedId;
 try{await db.beginTransaction();
  const [profiles]=await db.query('SELECT payload FROM academic_profiles WHERE openid=? AND account_key=? FOR UPDATE',owner(a));
  if(!profiles[0]||!parse(profiles[0].payload).some(s=>s.key===body.cohortKey))throw new AppError(409,'ACADEMIC_PROFILE_CHANGED','管理范围已变化，请刷新');
  const existing=await list(a,body.cohortKey,db),own=existing.filter(r=>r.student_id===body.studentId);
  if(body.action==='revoke'){
   const row=own.find(r=>r.id===body.id&&r.active);if(!row)throw new AppError(404,'ACADEMIC_REVIEW_NOT_FOUND','核对记录不存在或已撤销');
   await db.query('UPDATE academic_reviews SET active=0,revoked_at=UTC_TIMESTAMP() WHERE id=? AND openid=? AND account_key=?',[row.id,...owner(a)]);savedId=row.id;
  }else{
   if(body.action!=='create'||!['reject','defer','issue','unpassed'].includes(body.outcome)||typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>500||typeof body.fromCode!=='string'||!body.fromCode||body.fromCode.length>80||typeof body.fingerprint!=='string')throw new AppError(400,'INVALID_ACADEMIC_REVIEW','请选择核对结果并填写依据或说明');
   if(body.outcome!=='reject'&&body.toCode)throw new AppError(400,'INVALID_ACADEMIC_REVIEW','该结果无需指定另一门课程');
   const [archives]=await db.query('SELECT payload FROM academic_archives WHERE openid=? AND account_key=? AND cohort_key=? AND student_id=?',[...owner(a),body.cohortKey,body.studentId]);
   const archive=archives[0]?parse(archives[0].payload):null;
   if(!archive)throw new AppError(400,'ACADEMIC_ARCHIVE_REQUIRED','请先同步该生原始成绩');
   const [links]=await db.query('SELECT * FROM academic_links WHERE openid=? AND account_key=? AND cohort_key=?',[...owner(a),body.cohortKey]);
   const course=analyze(archive.courses,links,body.studentId,archive.sourceComplete).courses.find(c=>c.codes.includes(body.fromCode));
   if(!course)throw new AppError(400,'INVALID_ACADEMIC_REVIEW','原课程不在该生已同步成绩中');
   if(body.outcome==='unpassed'&&course.state==='passed')throw new AppError(409,'ACADEMIC_ALREADY_PASSED','当前已有明确通过成绩，请刷新核对');
   if(course.reviewFingerprint!==body.fingerprint)throw new AppError(409,'ACADEMIC_REVIEW_CHANGED','课程成绩已更新，请刷新后重新核对');
   const to=body.outcome==='reject'?body.toCode:'';
   if(body.outcome==='reject'&&(typeof to!=='string'||!to||to.length>80||to===body.fromCode||!archive.courses.some(r=>r.code===to)))throw new AppError(400,'INVALID_ACADEMIC_REVIEW','请选择另一门已同步课程');
   if(body.outcome==='reject'&&course.codes.includes(to))throw new AppError(409,'ACADEMIC_REVIEW_CONFLICT','两门课已有有效关联，请先撤销关联再记录排除');
   const prior=own.filter(r=>r.active&&(body.outcome==='reject'?r.outcome==='reject'&&samePair(r,body.fromCode,to):r.outcome!=='reject'&&course.codes.includes(r.from_code)));
   const identical=prior.find(r=>r.outcome===body.outcome&&r.reason===body.reason.trim()&&r.archive_fingerprint===body.fingerprint);
   if(identical)savedId=identical.id;
   else{
    for(const row of prior)await db.query('UPDATE academic_reviews SET active=0,revoked_at=UTC_TIMESTAMP() WHERE id=? AND openid=? AND account_key=?',[row.id,...owner(a)]);
    savedId=randomUUID();await db.query('INSERT INTO academic_reviews(id,openid,account_key,cohort_key,student_id,from_code,to_code,outcome,reason,archive_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)',[savedId,...owner(a),body.cohortKey,body.studentId,body.fromCode,to,body.outcome,body.reason.trim(),body.fingerprint]);
   }
  }
  await db.commit();
 }catch(e){await db.rollback();throw e}finally{db.release()}
 return {id:savedId,reviews:(await list(a,body.cohortKey)).filter(r=>r.student_id===body.studentId)};
}
module.exports={list,change,samePair};
