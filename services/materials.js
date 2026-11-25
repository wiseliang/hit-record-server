const { getImportScopes,getStudyAttributes } = require('./materialMemoryScope');
const { recordsForBank } = require('./materialStudyBank');
const { suggestMatches } = require('./materialMatches');
const pool=require('../config/database'),grades=require('./academicGrades'),d=require('./academicDashboard'),{AppError}=require('../utils/errors'),{encrypt,decrypt}=require('../utils/crypto'),{randomUUID,createHash}=require('crypto'),fs=require('fs/promises'),path=require('path'),{execFile}=require('child_process'),{promisify}=require('util'),{createMemoryBridge}=require('./memoryBridge');
const execute=promisify(execFile),bridge=createMemoryBridge(),parse=x=>typeof x==='string'?JSON.parse(x):x,args=a=>[a.openid,a.accountKey],hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const FIELDS={political:'政治面貌',committee:'班委情况',focus:'十类重点关注群体',reason:'关注原因',situation:'学情',other:'其他情况'},busy=new Map();let working=false;
const root=()=>path.resolve(process.env.MATERIALS_ROOT||path.join(__dirname,'../.data/materials'));
async function actor(openid){return grades.actor(openid)}
async function project(a,id,db=pool,lock=false){const [rows]=await db.query('SELECT * FROM material_projects WHERE id=? AND openid=? AND account_key=?'+(lock?' FOR UPDATE':''),[id,...args(a)]);if(!rows[0])throw new AppError(404,'MATERIAL_PROJECT_NOT_FOUND','辨识项目不存在或无权访问');return {...rows[0],sensitive:rows[0].include_personal}}
async function roster(a){const saved=await d.managedRoster(a),ids=d.memberSet(saved);if(!ids)throw new AppError(400,'MANAGED_REQUIRED','请先在学业管理中匹配本人所带名单');const p=await grades.profile(a),[rows]=await pool.query('SELECT cohort_key,payload FROM academic_rosters WHERE openid=? AND account_key=?',args(a)),out=new Map();for(const r of rows){if(!p.scopes.some(s=>s.key===r.cohort_key))continue;for(const person of parse(r.payload))if(ids.has(person.studentId))out.set(person.studentId,{studentId:person.studentId,name:person.name,className:person.className||'未填写班级',cohortKey:r.cohort_key})}return [...out.values()]}
async function state(openid){
 const a=await actor(openid),[projects]=await pool.query('SELECT id,title,counselor,revision,include_personal,updated_at FROM material_projects WHERE openid=? AND account_key=? ORDER BY updated_at DESC',args(a));
 const [imports]=await pool.query("SELECT id,project_id,payload_encrypted FROM material_jobs WHERE openid=? AND account_key=? AND kind='import' AND status='imported' ORDER BY updated_at DESC,id DESC LIMIT 200",args(a));
 const banks=new Map();
 for(const job of imports){
  if(banks.has(job.project_id))continue;
  const payload=parse(decrypt(job.payload_encrypted));
  if(payload.studyBank)banks.set(job.project_id,{id:job.id,filename:payload.filename});
 }
 return {projects:projects.map(p=>({...p,sensitive:p.include_personal,latestBank:banks.get(p.id)})),fields:FIELDS,memoryConfigured:bridge.configured(),accountKey:a.accountKey};
}
async function create(openid,body){
 const a=await actor(openid),studyOnly=body.studyOnly===true;
 if(typeof body.title!=='string'||!body.title.trim()||body.title.length>100||(!studyOnly&&(typeof body.counselor!=='string'||!body.counselor.trim()||body.counselor.length>80)))throw new AppError(400,'INVALID_MATERIAL_PROJECT','请填写项目名称与辅导员姓名');
 if(body.studentIds!==undefined&&(!Array.isArray(body.studentIds)||body.studentIds.length>10000||body.studentIds.some(x=>typeof x!=='string')))throw new AppError(400,'INVALID_MATERIAL_SCOPE','请选择有效学生列表');
 const people=studyOnly?[]:await roster(a);
 if(!studyOnly&&!people.length)throw new AppError(400,'MANAGED_REQUIRED','没有可用的所带学生名单');
 const chosen=body.studentIds?new Set(body.studentIds):new Set(people.map(p=>p.studentId));
 if(!studyOnly&&(!chosen.size||[...chosen].some(id=>!people.some(p=>p.studentId===id))))throw new AppError(400,'INVALID_MATERIAL_SCOPE','只能选择本人所带学生');
 const id=randomUUID(),db=await pool.getConnection();
 try{
  await db.beginTransaction();
  await db.query('INSERT INTO material_projects(id,openid,account_key,title,counselor) VALUES(?,?,?,?,?)',[id,...args(a),body.title.trim(),studyOnly?'':body.counselor.trim()]);
  for(const person of people.filter(p=>chosen.has(p.studentId)))await db.query('INSERT INTO material_students(project_id,student_id,profile_encrypted) VALUES(?,?,?)',[id,person.studentId,encrypt(JSON.stringify({...person,fields:{}}))]);
  await db.commit();
 }catch(e){await db.rollback();throw e}finally{db.release()}
 return detail(openid,id);
}
async function rows(a,id,db=pool,withPhotos=true,selectedId=null){
 const photoColumn=withPhotos===false?'photo_encrypted IS NOT NULL AS photo_encrypted':'photo_encrypted';
 const [students]=await db.query('SELECT student_id,revision,profile_encrypted,'+photoColumn+' FROM material_students WHERE project_id=?'+(selectedId?' AND student_id=?':'')+' ORDER BY student_id',selectedId?[id,selectedId]:[id]);
 if(!students.length)return [];
 const allowed=new Map((await roster(a)).map(person=>[person.studentId,person]));
 const [photos]=await db.query('SELECT student_id,mime,sha256'+(withPhotos===true?',encrypted_photo':'')+' FROM academic_student_photos WHERE openid=? AND account_key=?'+(selectedId?' AND student_id=?':''),selectedId?[...args(a),selectedId]:args(a));
 const byId=new Map(photos.map(photo=>[photo.student_id,photo]));
 return students.filter(student=>allowed.has(student.student_id)).map(student=>{
  let photo=null;
  if(student.photo_encrypted){
   photo=withPhotos===false?{present:true}:parse(decrypt(student.photo_encrypted));
  } else if(byId.has(student.student_id)){
   const saved=byId.get(student.student_id);
   photo={mime:saved.mime,sha256:saved.sha256};
   if(withPhotos===true)photo.base64=decrypt(saved.encrypted_photo);
  }
  return {...parse(decrypt(student.profile_encrypted)),...allowed.get(student.student_id),revision:Number(student.revision),photo};
 });
}
async function detail(openid,id){const a=await actor(openid),p=await project(a,id),all=await rows(a,id,pool,false);const [jobs]=await pool.query('SELECT id,project_id,kind,status,payload_encrypted,updated_at FROM material_jobs WHERE openid=? AND account_key=? AND project_id=? ORDER BY updated_at DESC,created_at DESC,id DESC LIMIT 20',[...args(a),id]);return {...p,jobs:jobs.map(j=>publicJob({...j,payload:parse(decrypt(j.payload_encrypted))})),openid:undefined,account_key:undefined,accountKey:a.accountKey,fields:FIELDS,students:all.map(({photo,...s})=>({...s,photoAvailable:!!photo})),classes:[...new Set(all.map(s=>s.className))].sort(),memoryConfigured:bridge.configured()}}
async function photo(openid,id,studentId){const a=await actor(openid);await project(a,id);const p=(await rows(a,id,pool,true,studentId)).find(s=>s.studentId===studentId);if(!p)throw new AppError(404,'MATERIAL_STUDENT_NOT_FOUND','该学生不在当前可用范围');return p.photo?{available:true,imageData:'data:'+p.photo.mime+';base64,'+p.photo.base64}:{available:false}}
async function save(openid,id,studentId,body){const a=await actor(openid);if(!Number.isSafeInteger(body.revision)||!body.fields||typeof body.fields!=='object'||Array.isArray(body.fields)||body.confirmed!==true)throw new AppError(400,'MATERIAL_CONFIRM_REQUIRED','请核实填写资料并确认保存');if(!(await roster(a)).some(p=>p.studentId===studentId))throw new AppError(404,'MATERIAL_STUDENT_NOT_FOUND','该学生不在本人所带范围');const db=await pool.getConnection();try{await db.beginTransaction();await project(a,id,db,true);const [all]=await db.query('SELECT * FROM material_students WHERE project_id=? AND student_id=?',[id,studentId]);const s=all[0];if(!s)throw new AppError(404,'MATERIAL_STUDENT_NOT_FOUND','该学生不在项目中');if(Number(s.revision)!==body.revision)throw new AppError(409,'MATERIAL_CHANGED','资料已被另一设备修改，请刷新');const profile=parse(decrypt(s.profile_encrypted));for(const [k,v] of Object.entries(body.fields)){if(!FIELDS[k]||typeof v!=='string'||v.length>1000)throw new AppError(400,'INVALID_MATERIAL_FIELD','字段或内容长度无效');profile.fields[k]={value:v.trim(),confirmed:!!v.trim(),source:'teacher',confirmedAt:new Date().toISOString()}}await db.query('UPDATE material_students SET profile_encrypted=?,revision=revision+1 WHERE project_id=? AND student_id=?',[encrypt(JSON.stringify(profile)),id,studentId]);await db.query('UPDATE material_projects SET revision=revision+1 WHERE id=?',[id]);await db.commit()}catch(e){await db.rollback();throw e}finally{db.release()}return detail(openid,id)}
async function settings(openid,id,body){const a=await actor(openid);if(typeof body.sensitive!=='boolean')throw new AppError(400,'INVALID_MATERIAL_SETTINGS','请选择背诵字段范围');await project(a,id);await pool.query('UPDATE material_projects SET include_personal=?,revision=revision+1 WHERE id=? AND openid=? AND account_key=?',[body.sensitive?1:0,id,...args(a)]);return detail(openid,id)}
function makeCards(people,sensitive,bank=false){
 const cards=[],images={};
 for(const person of people){
  const add=(kind,question,answer,photo)=>{
   const card={sourceId:person.studentId+':'+kind,kind,className:person.className,question,answer,imageId:photo?.sha256||null};
   card.revision=hash(card);cards.push(card);
   if(photo)images[photo.sha256]={mime:photo.mime,base64:photo.base64};
  };
  const fields=Object.entries(FIELDS).filter(([key])=>(key==='committee'||sensitive)&&person.fields?.[key]?.confirmed&&person.fields[key].value);
  if(person.photo){
   if(person.name)add('name','请根据照片回忆这名学生的姓名。',[person.name],person.photo);
   if(person.className)add('class','请根据照片回忆这名学生的班级。',[person.className],person.photo);
  }
  for(const [key,label] of fields){
   add(key,bank&&person.photo?'请根据照片回忆这名学生的'+label+'。':'请回忆'+(person.name||'这名学生')+'的'+label+'。',[person.fields[key].value],bank?person.photo:null);
  }
  const answers=[
   ...(person.name?['姓名：'+person.name]:[]),
   ...(person.className?['班级：'+person.className]:[]),
   ...fields.map(([key,label])=>label+'：'+person.fields[key].value),
  ];
  if(answers.length)add('profile',person.photo?'看照片，回忆这名学生的全部资料。':'这条记录没有照片，请回忆这名学生的资料。',answers,person.photo);
 }
 return {cards,images};
}
async function getStudyBank(a,projectId,bankId){
 await project(a,projectId);
 const job=await internalJob(a,bankId);
 if(job.project_id!==projectId||job.kind!=='import'||job.status!=='imported'||!job.payload.studyBank){
  throw new AppError(404,'MATERIAL_BANK_NOT_FOUND','PPT 题库不存在或无权访问');
 }
 return job;
}
async function bankMemory(owner,id,bankId){
 const job=await getStudyBank(owner,id,bankId);
 const [stored]=await pool.query('SELECT row_encrypted FROM material_import_rows WHERE job_id=? ORDER BY row_index',[bankId]);
 const people=recordsForBank(stored,value=>parse(decrypt(value)));
 const pack=makeCards(people,true,true);
 if(!pack.cards.length)throw new AppError(400,'MATERIAL_MEMORY_EMPTY','这个 PPT 题库没有可用题卡');
 return syncPack(owner,bankId,(job.payload.filename||'导入的 PPT').slice(0,100),1,pack,{
  bankId,studentCount:people.length,importScopes:[],studentAttributes:getStudyAttributes(people,true),includePersonal:true,
 });
}
async function memory(openid,id,body={}){
 const owner = await actor(openid);
 if(body.bankId)return bankMemory(owner,id,body.bankId);
 const db = await pool.getConnection();
 let pack,current,importScopes,studentAttributes;
 try {
  await db.beginTransaction();
  current = await project(owner,id,db,true);
  const people=await rows(owner,id,db);
  pack=makeCards(people,!!current.sensitive);
  const [imports]=await db.query(
   "SELECT id,payload_encrypted,updated_at FROM material_jobs WHERE openid=? AND account_key=? AND project_id=? AND kind='import' AND status='imported' ORDER BY updated_at DESC,created_at DESC,id DESC LIMIT 20",
   [...args(owner),id]
  );
  importScopes=getImportScopes(imports,people).filter(scope=>!scope.studyBank);
  studentAttributes=getStudyAttributes(people,!!current.sensitive);
  if(!pack.cards.length) throw new AppError(400,'MATERIAL_MEMORY_EMPTY','当前没有已确认资料或照片，请先保存照片、补齐资料');
  const content = hash(pack.cards);
  if(current.sync_hash !== content){
   current.sync_counter = Number(current.sync_counter)+1;
   await db.query('UPDATE material_projects SET sync_counter=?,sync_hash=? WHERE id=?',[current.sync_counter,content,id]);
  }
  await db.commit();
 } catch(error) {
  await db.rollback();
  throw error;
 } finally {
  db.release();
 }
 return syncPack(owner,id,current.title,Number(current.sync_counter),pack,
  {importScopes,studentAttributes,includePersonal:!!current.sensitive},body.profileCards===true);
}
async function syncPack(owner,id,title,revision,pack,metadata,profileCards=true){
 const images=await require('./memoryThumbnails').makeMemoryThumbnails(hash(args(owner)),pack.images);
 const remote=await bridge.call(owner,'sync',{projectId:id,title,revision,cards:pack.cards});
 const downloadedAt=Date.now();
 return {...remote,title,accountKey:owner.accountKey,images,...metadata,
  cards:profileCards?remote.cards:remote.cards.filter(card=>card.kind!=='profile'),
  unavailablePhotoCount:Object.keys(pack.images).length-Object.keys(images).length,
  downloadedAt,expiresAt:downloadedAt+30*86400000};
}
async function events(openid,id,body){
 const a=await actor(openid);
 if(body.bankId)await getStudyBank(a,id,body.bankId);else await project(a,id);
 return bridge.call(a,'events',{projectId:body.bankId||id,events:body.events});
}
async function progress(openid,id,body){
 const a=await actor(openid);
 if(body.bankId)await getStudyBank(a,id,body.bankId);else await project(a,id);
 return bridge.call(a,'progress',{projectId:body.bankId||id,progress:body.progress,expectedRevision:body.expectedRevision});
}
const sourceHash=people=>hash(people.map(s=>[s.studentId,s.name,s.className,s.photo?.sha256||null]).sort((a,b)=>a[0].localeCompare(b[0])));
const jobFile=(a,id)=>path.join(root(),hash(args(a)).slice(0,24),id);
async function internalJob(a,id){const [jobs]=await pool.query('SELECT * FROM material_jobs WHERE id=? AND openid=? AND account_key=?',[id,...args(a)]);if(!jobs[0])throw new AppError(404,'MATERIAL_JOB_NOT_FOUND','材料任务不存在');return {...jobs[0],payload:parse(decrypt(jobs[0].payload_encrypted))}}
function publicJob(j){
 const report=j.payload.report;
 const summary=report?.issues?{...report,issues:report.issues.slice(0,12),issueCount:report.issues.length}:report;
 return {id:j.id,projectId:j.project_id,kind:j.kind,status:j.status,message:j.payload.message||'',studyBank:!!j.payload.studyBank,filename:j.payload.filename,report:summary||null,ready:j.status==='completed'};
}
async function job(openid,id){const a=await actor(openid),j=await internalJob(a,id);await project(a,j.project_id);return publicJob(j)}
async function updateJob(a,id,status,payload){await pool.query('UPDATE material_jobs SET status=?,payload_encrypted=? WHERE id=? AND openid=? AND account_key=?',[status,encrypt(JSON.stringify(payload)),id,...args(a)])}
async function enqueue(a,projectId,kind,payload){const id=randomUUID(),db=await pool.getConnection();try{await db.beginTransaction();await project(a,projectId,db,true);const [count]=await db.query("SELECT COUNT(*) AS n FROM material_jobs WHERE project_id=? AND status IN ('pending','running')",[projectId]);if(Number(count[0].n)>=2)throw new AppError(429,'MATERIAL_BUSY','该项目还有处理中的材料，请完成后再试');if(kind==='import'){if(Buffer.byteLength(payload.file,'base64')>25*1024*1024)throw new AppError(400,'INVALID_MATERIAL_FILE','请选择不超过25MiB的PPTX材料');await fs.mkdir(jobFile(a,id),{recursive:true,mode:0o700});await fs.writeFile(path.join(jobFile(a,id),'upload.pptx'),Buffer.from(payload.file,'base64'),{mode:0o600});delete payload.file}await db.query('INSERT INTO material_jobs(id,openid,account_key,project_id,kind,status,payload_encrypted) VALUES(?,?,?,?,?,?,?)',[id,...args(a),projectId,kind,'pending',encrypt(JSON.stringify(payload))]);await db.commit()}catch(e){await db.rollback();if(kind==='import')await fs.rm(jobFile(a,id),{recursive:true,force:true}).catch(()=>{});throw e}finally{db.release()}void drain().catch(()=>{});return publicJob(await internalJob(a,id))}
async function drain(){if(working)return;working=true;try{while(true){const [list]=await pool.query("SELECT * FROM material_jobs WHERE status='pending' ORDER BY created_at LIMIT 1");if(!list.length)break;const j=list[0],a={openid:j.openid,accountKey:j.account_key},p=parse(decrypt(j.payload_encrypted)),dir=jobFile(a,j.id);try{if((await actor(a.openid)).accountKey!==a.accountKey)throw new AppError(409,'SCHOOL_ACCOUNT_CHANGED','学校账号已切换，请重新创建材料任务');const current=await project(a,j.project_id);await updateJob(a,j.id,'running',p);await fs.mkdir(dir,{recursive:true,mode:0o700});let report;
 if(j.kind==='export'){if(Number(current.revision)!==p.revision)throw new AppError(409,'MATERIAL_CHANGED','项目资料已变化，请重新生成');const all=await rows(a,j.project_id),selected=all.filter(x=>!p.className||x.className===p.className);if(!selected.length)throw new AppError(400,'MATERIAL_EMPTY','所选班级没有可用学生');p.sourceHash=sourceHash(selected);const issues=[];for(const s of selected){if(!s.photo)issues.push({studentId:s.studentId,field:'photo',name:s.name,message:'照片缺失'});if(p.mode!=='assessment')for(const k of Object.keys(FIELDS)){if(k==='reason'&&s.fields?.focus?.value==='无')continue;const f=s.fields?.[k];if(!f?.confirmed||!f.value)issues.push({studentId:s.studentId,field:k,name:s.name,message:'资料待补齐'});if(f?.value?.length>({political:12,committee:18,focus:45,reason:60,situation:16,other:25}[k]))issues.push({studentId:s.studentId,field:k,name:s.name,message:'内容过长，请精简后生成提交版'})}}p.report={issues};if(issues.length&&!p.draft)throw new AppError(400,'MATERIAL_INCOMPLETE','提交版仍有'+issues.length+'项待处理，请补齐、精简或改为草稿');const manifest=path.join(dir,'manifest.json');await fs.writeFile(manifest,JSON.stringify({rows:selected,counselor:current.counselor,draft:p.draft,mode:p.mode,issues}),{mode:0o600});try{const r=await execute(process.env.MATERIALS_PYTHON||'/usr/bin/python3',[path.resolve(__dirname,'../scripts/recognition-ppt.py'),'export',manifest,path.resolve(__dirname,'../assets/recognition'),dir],{timeout:60000,maxBuffer:2000000});report=JSON.parse(r.stdout);p.report=report;if(report.layoutBlocked)throw new AppError(400,'MATERIAL_LAYOUT_OVERFLOW','部分内容超出模板栏位，请精简后重新生成提交版');await fs.writeFile(path.join(dir,'校验清单_资料状态.json'),JSON.stringify(report.issues),{mode:0o600})}finally{await fs.unlink(manifest).catch(()=>{})}if((await project(a,j.project_id)).revision!=p.revision||sourceHash((await rows(a,j.project_id,pool,'fingerprint')).filter(x=>!p.className||x.className===p.className))!==p.sourceHash)throw new AppError(409,'MATERIAL_CHANGED','生成期间项目已更新，请重新生成');p.report=report}
 else if(j.kind==='import'){
  const input=path.join(dir,'upload.pptx');
  try{
   const result=await execute(process.env.MATERIALS_PYTHON||'/usr/bin/python3',[path.resolve(__dirname,'../scripts/recognition-ppt.py'),'import',input],{timeout:45000,maxBuffer:40*1024*1024});
   const parsed=JSON.parse(result.stdout);
   if(!parsed.rows.length)throw new AppError(400,'MATERIAL_IMPORT_EMPTY','没有可恢复的已填写学生记录；考核版空栏不能还原答案');
   if(p.studyBank&&parsed.rows.length>1000)throw new AppError(400,'MATERIAL_BANK_TOO_LARGE','每份 PPT 题库最多支持 1000 条记录，请拆分文件');
   p.report={rows:parsed.rows.length,warnings:parsed.warnings};
   if(p.studyBank)p.report.bankRows=parsed.rows.length;
   else{
    p.suggestedMapping=suggestMatches(parsed.rows,await rows(a,j.project_id,pool,false));
    p.report.matched=p.suggestedMapping.length;
   }
   for(const row of parsed.rows)await pool.query('INSERT INTO material_import_rows(job_id,row_index,row_encrypted) VALUES(?,?,?)',[j.id,row.index,encrypt(JSON.stringify(row))]);
  }finally{await fs.unlink(input).catch(()=>{})}
 }
 if(j.kind==='import'&&p.studyBank)await updateJob(a,j.id,'imported',p);
 else if(j.kind==='import'&&p.autoApply&&p.suggestedMapping.length)await applyImport(a,{...j,payload:p},p.suggestedMapping,'running');
 else await updateJob(a,j.id,'completed',p);
 }catch(e){await pool.query('DELETE FROM material_import_rows WHERE job_id=?',[j.id]);delete p.file;p.message=e instanceof AppError?e.message:'材料处理失败，原资料保留，请核对文件与模板';await updateJob(a,j.id,'failed',p);await fs.rm(dir,{recursive:true,force:true}).catch(()=>{})}}}finally{working=false}}
async function startExport(openid,id,body){const a=await actor(openid),p=await project(a,id);if(!['full','assessment','both'].includes(body.mode)||typeof body.draft!=='boolean'||typeof (body.className||'')!=='string')throw new AppError(400,'INVALID_MATERIAL_EXPORT','请选择导出版本和班级');return enqueue(a,id,'export',{revision:Number(p.revision),mode:body.mode,draft:body.draft,className:body.className||''})}
async function startImport(openid,id,body){const a=await actor(openid),p=await project(a,id);if(typeof body.file!=='string'||body.file.length>36*1024*1024||!body.file.startsWith('UEs')||typeof body.filename!=='string'||!body.filename.toLowerCase().endsWith('.pptx'))throw new AppError(400,'INVALID_MATERIAL_FILE','请选择不超过25MiB的PPTX材料');return enqueue(a,id,'import',{revision:Number(p.revision),file:body.file,filename:body.filename.slice(-255),autoApply:body.autoApply===true,studyBank:body.studyBank===true})}
async function createBankFromImport(openid,id){
 const a=await actor(openid),j=await internalJob(a,id);
 await project(a,j.project_id);
 if(j.kind!=='import'||!['completed','imported'].includes(j.status))throw new AppError(409,'MATERIAL_IMPORT_NOT_READY','请等待 PPT 解析完成');
 if(j.payload.studyBank)return detail(openid,j.project_id);
 const [[{n}]]=await pool.query('SELECT COUNT(*) AS n FROM material_import_rows WHERE job_id=?',[id]);
 const count=Number(n);
 if(!count||count>1000)throw new AppError(400,'MATERIAL_BANK_SIZE','这次导入没有可用记录或超过 1000 条，请重新选择 PPT');
 const payload={...j.payload,studyBank:true,report:{...j.payload.report,bankRows:count}};
 const [result]=await pool.query("UPDATE material_jobs SET status='imported',payload_encrypted=? WHERE id=? AND status=? AND payload_encrypted=?",
  [encrypt(JSON.stringify(payload)),id,j.status,j.payload_encrypted]);
 if(!result.affectedRows){
  const current=await internalJob(a,id);
  if(!current.payload.studyBank)throw new AppError(409,'MATERIAL_CHANGED','导入任务已有更新，请刷新项目');
 }
 return detail(openid,j.project_id);
}
async function importProposals(a,j){
 if(j.payload.suggestedMapping)return j.payload.suggestedMapping;
 const [stored]=await pool.query('SELECT row_encrypted FROM material_import_rows WHERE job_id=? ORDER BY row_index',[j.id]);
 const identities=stored.map(r=>{const {index,name,className}=parse(decrypt(r.row_encrypted));return {index,name,className}});
 return suggestMatches(identities,await rows(a,j.project_id,pool,false));
}
async function importPreview(openid,id,{offset=0}={}){
 const a=await actor(openid),j=await internalJob(a,id),current=await project(a,j.project_id);
 if(j.kind!=='import'||j.status!=='completed')throw new AppError(409,'MATERIAL_IMPORT_NOT_READY','导入预览尚未完成');
 if(Number(current.revision)!==j.payload.revision)throw new AppError(409,'MATERIAL_CHANGED','项目资料已变化，请重新导入后核对');
 const total=j.payload.report.rows,start=Math.max(0,Math.min(total,Math.floor(Number(offset)||0)));
 const suggestedMapping=await importProposals(a,j);
 const [stored]=await pool.query('SELECT row_encrypted FROM material_import_rows WHERE job_id=? ORDER BY row_index LIMIT 12 OFFSET ?',[id,start]);
 const byIndex=new Map(suggestedMapping.map(m=>[m.index,m.studentId]));
 j.payload.report.matched=suggestedMapping.length;
 return {job:publicJob(j),total,suggestedMapping,rows:stored.map(record=>{
  const r=parse(decrypt(record.row_encrypted));
  return {...r,matchedStudentId:byIndex.get(r.index)||null,photo:r.photo?{imageData:'data:'+r.photo.mime+';base64,'+r.photo.base64}:null};
 })};
}
async function applyImport(a,j,mapping,expectedStatus){
 if(!Array.isArray(mapping)||!mapping.length||mapping.length>1000)throw new AppError(400,'INVALID_MATERIAL_MAPPING','没有可写入的记录，请检查学生姓名和班级');
 const allowed=new Set((await roster(a)).map(p=>p.studentId)),seen=new Set(),indices=new Set();
 for(const m of mapping){
  if(!m||typeof m.studentId!=='string'||!Number.isInteger(m.index)||m.index<0||m.index>=j.payload.report.rows||seen.has(m.studentId)||indices.has(m.index)||!allowed.has(m.studentId))throw new AppError(400,'INVALID_MATERIAL_MAPPING','身份存在重复、未匹配或已退出管理范围');
  seen.add(m.studentId);indices.add(m.index);
 }
 const db=await pool.getConnection();
 try{
  await db.beginTransaction();
  const p=await project(a,j.project_id,db,true);
  const [jobs]=await db.query('SELECT status FROM material_jobs WHERE id=? FOR UPDATE',[j.id]);
  if(jobs[0]?.status!==expectedStatus)throw new AppError(409,'MATERIAL_IMPORT_NOT_READY','这份导入已处理，请刷新项目');
  if(Number(p.revision)!==j.payload.revision)throw new AppError(409,'MATERIAL_CHANGED','项目资料已变化，请重新导入以免覆盖新资料');
  for(const m of mapping){
   const [records]=await db.query('SELECT profile_encrypted FROM material_students WHERE project_id=? AND student_id=?',[j.project_id,m.studentId]);
   if(!records[0])throw new AppError(400,'INVALID_MATERIAL_MAPPING','所选学生不在项目中');
   const [imports]=await db.query('SELECT row_encrypted FROM material_import_rows WHERE job_id=? AND row_index=?',[j.id,m.index]);
   if(!imports[0])throw new AppError(400,'INVALID_MATERIAL_MAPPING','导入原始记录不可用，请重新上传');
   const raw=parse(decrypt(imports[0].row_encrypted)),profile=parse(decrypt(records[0].profile_encrypted));
   for(const [k,v] of Object.entries(raw.fields)){
    if(FIELDS[k]&&v)profile.fields[k]={value:v,confirmed:true,source:'pptx',sourcePage:raw.sourcePage,sourcePosition:raw.sourcePosition,confirmedAt:new Date().toISOString()};
   }
   await db.query('UPDATE material_students SET profile_encrypted=?,photo_encrypted=COALESCE(?,photo_encrypted),revision=revision+1 WHERE project_id=? AND student_id=?',[encrypt(JSON.stringify(profile)),raw.photo?encrypt(JSON.stringify(raw.photo)):null,j.project_id,m.studentId]);
  }
  const payload={...j.payload,importedStudentIds:[...seen],report:{...j.payload.report,imported:mapping.length,skipped:j.payload.report.rows-mapping.length}};
  await db.query('UPDATE material_projects SET revision=revision+1 WHERE id=?',[j.project_id]);
  await db.query("UPDATE material_jobs SET status='imported',payload_encrypted=? WHERE id=?",[encrypt(JSON.stringify(payload)),j.id]);
  await db.commit();
 }catch(e){await db.rollback();throw e}finally{db.release()}
}
async function commitImport(openid,id,body){
 const a=await actor(openid),j=await internalJob(a,id);
 if(j.kind!=='import'||j.status!=='completed'||(body.autoApply!==true&&body.confirmed!==true)){
  throw new AppError(400,'MATERIAL_IMPORT_CONFIRM_REQUIRED','请打开尚未写入的导入任务');
 }
 if(body.autoApply===true){
  const mapping=await importProposals(a,j);
  j.payload.report.matched=mapping.length;
  await applyImport(a,j,mapping,'completed');
 }else await applyImport(a,j,body.mapping,'completed');
 return detail(openid,j.project_id);
}
async function download(openid,id){const a=await actor(openid),j=await internalJob(a,id),p=await project(a,j.project_id);if(j.kind!=='export'||j.status!=='completed')throw new AppError(409,'MATERIAL_NOT_READY','材料尚未生成');if(Number(p.revision)!==j.payload.revision||sourceHash((await rows(a,j.project_id,pool,'fingerprint')).filter(x=>!j.payload.className||x.className===j.payload.className))!==j.payload.sourceHash)throw new AppError(409,'MATERIAL_CHANGED','名单、照片或资料已更新，请重新生成后下载');return {file:path.join(jobFile(a,id),'辨识材料.zip'),filename:'辨识材料_'+(j.payload.draft?'草稿':'提交版')+'.zip'}}
async function recover(){const [jobs]=await pool.query("SELECT * FROM material_jobs WHERE status IN ('running','pending')");for(const j of jobs){const a={openid:j.openid,accountKey:j.account_key};await pool.query('DELETE FROM material_import_rows WHERE job_id=?',[j.id]);await updateJob(a,j.id,'failed',{message:'服务重启中断处理，原资料保留，请重新生成或选择文件'});await fs.rm(jobFile(a,j.id),{recursive:true,force:true})}}
module.exports={state,create,detail,photo,save,settings,memory,events,progress,startExport,startImport,job,importPreview,commitImport,createBankFromImport,download,recover,makeCards,roster,busy,drain};
