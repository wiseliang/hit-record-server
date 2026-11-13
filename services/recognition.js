const {randomUUID}=require('crypto');
const {AppError}=require('../utils/errors');
const {createBridge}=require('./recognitionBridge');
const {RecognitionStore}=require('./recognitionStore');
const ACTIVE=new Set(['pending','running','pause_requested']);
function createRecognition({store,bridge,actor,roster,refreshRoster,photo,connection,profile,delay=ms=>new Promise(r=>setTimeout(r,ms))}){
 let working=null,stopping=false,timer;
 async function context(openid){const a=await actor(openid);await store.setting(a);return a;}
 async function authorized(a){const rows=await roster(a),grants=await store.consents(a.subject),byId=new Map(grants.filter(g=>g.active).map(g=>[g.student_id,g.reference]));return {rows,grants,authorized:rows.filter(r=>byId.has(r.studentId)).map(r=>({...r,consentRef:byId.get(r.studentId)}))};}
 const publicJob=j=>j?{id:j.id,status:j.status,revision:Number(j.revision),...j.payload}:null;
 async function state(openid){
  const a=await context(openid),setting=await store.setting(a);let data={rows:[],grants:[],authorized:[]},setupError;
  try{data=await authorized(a);}catch(e){setupError=e.message;}
  let scope=null,bridgeError;if(bridge.configured()){try{await bridge.exchange(a.subject);scope=await bridge.api(a.subject,'/search-scope');}catch(e){bridgeError=e.message;}}
  const grants=new Map(data.grants.map(g=>[g.student_id,g]));
  return {configured:bridge.configured(),enabled:!!setting.enabled,scope,setupError,bridgeError,authorizedCount:data.authorized.length,lastCheck:Number(setting.last_check),students:[...data.rows,...data.grants.filter(g=>!data.rows.some(r=>r.studentId===g.student_id)).map(g=>({studentId:g.student_id,name:'原管理范围人员',outOfScope:true}))].map(r=>({studentId:r.studentId,name:r.name,className:r.className||'',outOfScope:!!r.outOfScope,authorized:!!grants.get(r.studentId)?.active,reference:grants.get(r.studentId)?.reference||''})),job:publicJob(await store.latest(a.subject))};
 }
 async function syncScope(a,revision){const data=await authorized(a);await bridge.exchange(a.subject);const result=await bridge.signed(a.subject,'scope',{revision:Number(revision),studentIds:data.authorized.map(r=>r.studentId)});return {...data,...result};}
 async function grants(openid,body){
  const a=await context(openid),items=body.items;
  const existing=await store.consents(a.subject);let rows=[];try{rows=await roster(a);}catch(e){if(items?.some(x=>x?.active))throw e;}
  const allowed=new Set(rows.map(x=>x.studentId)),known=new Set(existing.map(x=>x.student_id));
  if(body.confirmIndividualConsent!==true||!Array.isArray(items)||!items.length||items.length>1000||new Set(items.map(x=>x?.studentId)).size!==items.length)throw new AppError(400,'CONSENT_REQUIRED','请逐人核对人脸识别用途授权并填写记录引用');
  if(items.some(x=>!(x.active?allowed.has(x.studentId):known.has(x.studentId))||typeof x.active!=='boolean'||typeof x.reference!=='string'||(x.active&&x.reference.trim().length<3)||x.reference.length>160))throw new AppError(400,'INVALID_CONSENT','授权人员不在当前所带范围或记录引用无效');
  await store.grant(a,items.map(x=>({...x,reference:x.reference.trim()})));
  const s=await store.setting(a);let pending=false;
  try{const revoked=items.filter(x=>!x.active).map(x=>x.studentId);if(revoked.length)await bridge.signed(a.subject,'revoke',{revision:Number(s.revision),studentIds:revoked});else await syncScope(a,s.revision);}catch{pending=true;}
  // A persisted job also retries scope revocation after a transient connection error.
  const j=await store.start(a,randomUUID(),{phase:'scope',scopeOnly:true,done:[],failures:[],total:0,success:0,skipped:0});void tick().catch(()=>{});
  return {ok:true,reconciliationPending:pending,job:publicJob(j)};
 }
 async function start(openid,body={}){
  const a=await context(openid);if(!bridge.configured())throw new AppError(503,'RECOGNITION_UNCONFIGURED','识人服务尚未连接');
  const old=await store.latest(a.subject);if(old&&ACTIVE.has(old.status))return publicJob(old);
  const data=await authorized(a);if(!data.authorized.length)throw new AppError(400,'CONSENT_REQUIRED','当前没有已获人脸识别用途授权的学生，请先维护授权记录');
  if(body.enabled!==undefined){if(typeof body.enabled!=='boolean')throw new AppError(400,'INVALID_SETTING','同步设置无效');await store.configure(a,body.enabled);}
  const j=await store.start(a,randomUUID(),{phase:'preparing',done:[],failures:[],total:data.authorized.length,success:0,skipped:0,refreshPhotos:body.refreshPhotos===true});void tick().catch(()=>{});return publicJob(j);
 }
 async function reconcile(openid){if(!bridge.configured())return null;const a=await context(openid);await store.grant(a,[]);const s=await store.setting(a);await syncScope(a,s.revision).catch(()=>{});const j=await store.start(a,randomUUID(),{phase:'scope',scopeOnly:true,done:[],failures:[],total:0,success:0,skipped:0});void tick().catch(()=>{});return publicJob(j);}
 async function check(openid){const a=await context(openid),s=await store.setting(a),j=await store.latest(a.subject);if(s.enabled&&Date.now()-Number(s.last_check)>6*3600000&&(!j||!ACTIVE.has(j.status)))return start(openid);return publicJob(j);}
 async function run(j){
  const p=j.payload;
  try{
   const a=await context(j.openid);
   if(a.subject!==j.subject)throw new AppError(409,'IDENTITY_CHANGED','学校身份已变化');
   if(!p.scopeOnly&&!p.prepared){p.phase='preparing';if(await store.save(j,p)!=='running')return;await refreshRoster(a);p.prepared=true;}
   const scoped=await syncScope(a,j.revision);p.cleanupPending=scoped.cleanupPending;
   if(p.cleanupPending){p.phase='cleaning';if(await store.save(j,p)!=='running')return;const cleaned=await bridge.signed(a.subject,'cleanup',{revision:Number(j.revision)});p.cleanupPending=cleaned.cleanupPending;}
   if(p.scopeOnly){p.phase='scope';p.message=p.cleanupPending?'授权范围已更新，云端清理待重试':'授权范围已更新';await store.save(j,p,p.cleanupPending?'partial':'completed');return;}
   const rows=scoped.authorized;p.total=rows.length;p.done=(p.done||[]).filter(id=>rows.some(r=>r.studentId===id));p.success=p.done.length;p.failures=[];p.message='';
   let networkErrors=0;const usedHashes=new Map();
   for(const row of rows){
    p.current=row.studentId;if(await store.save(j,p)!=='running')return;
    const current=await context(j.openid),s=await store.setting(current);
    if(current.subject!==j.subject||Number(s.revision)!==Number(j.revision))throw new AppError(409,'SCOPE_CHANGED','同步范围已变化');
    const live=await authorized(a),grant=live.authorized.find(r=>r.studentId===row.studentId);if(!grant)throw new AppError(409,'SCOPE_CHANGED','人员范围或用途授权已变化');
    if(p.done.includes(row.studentId))continue;
    try{
     p.phase='fetching_photos';if(await store.save(j,p)!=='running')return;
     const saved=await photo(a,row.studentId,p.refreshPhotos);if(!saved)throw new AppError(422,'MISSING_PHOTO','照片尚未取得');
     if(usedHashes.has(saved.hash)&&usedHashes.get(saved.hash)!==row.studentId)throw new AppError(422,'DUPLICATE_PHOTO','与本次其他学生照片完全相同，请核对学校默认图');usedHashes.set(saved.hash,row.studentId);
     // Recheck grant after school network I/O, before passing an image to the recognition service.
     if(!(await authorized(a)).authorized.some(r=>r.studentId===row.studentId)||(Number((await store.setting(a)).revision)!==Number(j.revision)))throw new AppError(409,'SCOPE_CHANGED','用途授权已变化');
     p.phase='indexing';if(await store.save(j,p)!=='running')return;
     await bridge.signed(a.subject,'reauthorize',{revision:Number(j.revision),studentId:row.studentId});
     const values={name:row.name,department:row.className||'',grade:String(row.year||''),major:row.major||'',classNo:String(row.classNumber||''),school:'哈尔滨工业大学（威海）'};
     const result=await bridge.signed(a.subject,'members',{revision:Number(j.revision),studentId:row.studentId,values,photo:saved.bytes.toString('base64'),consentRef:grant.consentRef});
     if(result.status!=='active')throw new AppError(502,'INDEX_UNCONFIRMED','人脸库尚未确认同步完成');
     p.done.push(row.studentId);p.success=p.done.length;if(result.unchanged)p.skipped++;networkErrors=0;
    }catch(e){
     if(['SCOPE_CHANGED','SYNC_CANCELLED','IDENTITY_CHANGED'].includes(e.code))throw e;
     if(/AUTH_REQUIRED|CREDENTIAL_REQUIRED|SCHOOL_ACCOUNT|SIGNIN/.test(e.code||''))throw e;
     p.failures.push({studentId:row.studentId,code:e.code||'PHOTO_OR_SERVICE_FAILED',message:e instanceof AppError?e.message:'照片或识人服务暂不可用，可继续重试'});
     if(!e.status||e.status>=500){if(++networkErrors>=3)throw new AppError(503,'RETRY_LATER','服务连续未响应，已暂停并保留进度');}else networkErrors=0;
    }
    if(await store.save(j,p)!=='running')return;await delay(250);
   }
   p.current=null;p.phase='finished';await store.save(j,p,p.failures.length||p.cleanupPending?'partial':'completed');
  }catch(e){p.current=null;p.message=e instanceof AppError?e.message:'同步中断，可核对后继续';p.errorCode=e.code||'SYNC_FAILED';const status=/AUTH_REQUIRED|CREDENTIAL_REQUIRED|SIGNIN/.test(e.code||'')?'awaiting_auth':/SCOPE_REQUIRED|MANAGED_REQUIRED|ROSTER_INCOMPLETE/.test(e.code||'')?'awaiting_setup':e.code==='RETRY_LATER'?'paused':'failed';await store.save(j,p,status).catch(()=>{});}
 }
 async function tick(){if(stopping||working)return;working=(async()=>{const j=await store.claim(randomUUID());if(j)await run(j);})();try{await working;}finally{working=null;}}
 async function queryContext(openid){const a=await context(openid);if(!bridge.configured())throw new AppError(503,'RECOGNITION_UNCONFIGURED','识人服务尚未连接');return a;}
 // Source results are always checked against current roster and individual consent, even while reconciliation is queued.
 async function permit(a,p){const session=await bridge.exchange(a.subject);if(p.libraryId!==session.libraryId)return p;const data=await authorized(a),row=data.authorized.find(r=>r.studentId===p.employeeNo);if(!row||p.status!=='active')throw new AppError(404,'PERSON_NOT_AVAILABLE','人员当前不可查询');return {...p,academic:row.cohortKey?{studentId:row.studentId,cohortKey:row.cohortKey}:null};}
 async function search(openid,image){
  const a=await queryContext(openid);if(typeof image!=='string'||image.length>3*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(image))throw new AppError(400,'INVALID_IMAGE','请提供压缩后的单人照片');
  const fd=new FormData();fd.append('photo',new Blob([Buffer.from(image,'base64')],{type:'image/jpeg'}),'query.jpg');const result=await bridge.api(a.subject,'/search',{method:'POST',body:fd});
  const matches=[];for(const p of result.matches||[]){try{matches.push(await permit(a,p));}catch(e){if(e.status!==404)throw e;}}
  return {...result,matches,status:matches.length?result.status:'none',scopeChanged:result.scopeChanged||matches.length!==(result.matches||[]).length};
 }
 async function person(openid,id){const a=await queryContext(openid),p=await bridge.api(a.subject,'/people/'+id);return permit(a,p);}
 async function image(openid,id,photoId){const a=await queryContext(openid);await permit(a,await bridge.api(a.subject,'/people/'+id));const result=await bridge.api(a.subject,'/people/'+id+(photoId?'/photos/'+photoId+'/image':'/photo'),{binary:true});await permit(a,await bridge.api(a.subject,'/people/'+id));return result;}
 return {state,start,check,reconcile,grants,search,person,image,bind:async(openid,b)=>bridge.exchange((await context(openid)).subject,b),job:async(openid,id)=>publicJob(await store.job(await context(openid),id)),pause:async(openid,id)=>publicJob(await store.pause(await context(openid),id)),resume:async(openid,id)=>{const j=await store.resume(await context(openid),id);void tick().catch(()=>{});return publicJob(j)},tick,workerStatus:()=>({activeWorkers:working?1:0,stopping}),startWorker(){stopping=false;timer=setInterval(()=>void tick().catch(()=>{}),1000);timer.unref();},async stop(){stopping=true;clearInterval(timer);await working;}};
}
let instance;
function service(){if(instance)return instance;
 const pool=require('../config/database'),d=require('./academicDashboard'),photos=require('./academicPhotos'),grades=require('./academicGrades'),access=require('./academicAccess');
 const store=new RecognitionStore(pool),bridge=createBridge();
 instance=createRecognition({store,bridge,
  async actor(openid){const [r]=await pool.query('SELECT account_key FROM school_account_bindings WHERE openid=?',[openid]);if(!r[0])throw new AppError(409,'SCHOOL_SIGNIN_REQUIRED','请先通过学校账号验证身份');return {openid,subject:r[0].account_key,accountKey:r[0].account_key};},
  async roster(a){const saved=await d.managedRoster(a),ids=d.memberSet(saved);if(!ids)throw new AppError(409,'MANAGED_REQUIRED','请先在名单与连接中匹配所带学生');
   if((await grades.actor(a.openid)).accountKey!==a.subject)throw new AppError(409,'IDENTITY_CHANGED','学校与教务账号不一致');
   const first=await d.dashboard(a.openid,{limit:100}),rows=[...first.students];while(rows.length<first.total){const next=await d.dashboard(a.openid,{limit:100,offset:rows.length});if(!next.students.length)throw new AppError(502,'ROSTER_INCOMPLETE','名单分页不完整，保留原同步范围');rows.push(...next.students);}
   if(new Set(rows.map(r=>r.studentId)).size!==rows.length||rows.length!==ids.size||rows.some(r=>!ids.has(r.studentId)))throw new AppError(502,'ROSTER_INCOMPLETE','所带名单不完整，请先核对范围');return rows;},
  async refreshRoster(a){await d.refreshManaged(a.openid);},
  async photo(a,id,refresh){let data=await photos.view(a.openid,id);if(refresh||!data.available)data=await photos.saveOne(a.openid,id);if(!data.available)return null;const bytes=Buffer.from(data.imageData.split(',')[1],'base64');return {bytes,hash:require('./recognitionBridge').hash(bytes)};}
 });instance.migrate=()=>store.migrate();return instance;
}
module.exports={createRecognition,service,ACTIVE};
