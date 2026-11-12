const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{pathToFileURL}=require('url'),{randomUUID}=require('crypto');
if(!/_(test|stage)$/.test(process.env.DB_NAME||''))throw Error('An isolated test database is required');
if(!process.env.STAFF_FINDER_TEST_SOURCE)throw Error('Set STAFF_FINDER_TEST_SOURCE to an isolated Staff Finder checkout');
test('real MySQL and SQLite: school login identity → consent → worker → recognition → protected profile → withdrawal',async t=>{
 const pool=require('../config/database');await require('../scripts/migrate-v12').migrate();
 const source=process.env.STAFF_FINDER_TEST_SOURCE,{createApp}=await import(pathToFileURL(path.join(source,'server/app.js')).href),sharp=require(path.join(source,'node_modules/sharp'));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'school-contract-')),prefix='recog_'+randomUUID(),owners=[prefix+'_a',prefix+'_b'];let creates=0,deletionFailure=false;
 let sfDb;const provider={ready:true,group:'testing',async call(method,args){if(method==='GetGroupInfo')return {};if(method==='DetectFace')return {FaceInfos:[{}]};if(method==='CreatePerson'){creates++;return {FaceId:'f'+creates}}if(method==='DeletePerson'){if(deletionFailure)throw Object.assign(Error('offline'),{status:502});return {}}if(method==='SearchPersons')return {Results:[{Candidates:sfDb.prepare('SELECT p.id FROM people p JOIN libraries l ON p.library_id=l.id').all().filter(p=>{const g=sfDb.prepare('SELECT group_id FROM libraries WHERE id=(SELECT library_id FROM people WHERE id=?)').get(p.id).group_id;return args.GroupIds.includes(g)}).map(p=>({PersonId:p.id,Score:98}))}]};throw Error(method)}};
 const sf=createApp({dataDir:dir,env:{ADMIN_PASSWORD:'synthetic-admin-password',PHOTO_KEY:'de'.repeat(32),COOKIE_SECURE:'false',SCHOOL_BRIDGE_SECRET:process.env.SCHOOL_BRIDGE_SECRET},provider});sfDb=sf.db;
 const sfServer=sf.app.listen(0,'127.0.0.1');await new Promise(r=>sfServer.once('listening',r));process.env.STAFF_FINDER_URL='http://127.0.0.1:'+sfServer.address().port+'/';
 const d=require('../services/academicDashboard'),photos=require('../services/academicPhotos'),access=require('../services/academicAccess'),identity=require('../services/identity');
 const saved={dashboard:d.dashboard,refresh:d.refreshManaged,view:photos.view,one:photos.saveOne};
 const rows=[{studentId:'00001001',name:'合成甲',className:'001班',year:'2026',classNumber:'01',major:'合成专业',cohortKey:'cohort_a'},{studentId:'00001002',name:'合成乙',className:'002班',year:'2026'}];
 const images=await Promise.all(['#ccbb88','#446688'].map(background=>sharp({create:{width:240,height:300,channels:3,background}}).jpeg().toBuffer()));
 const tokens=[];
 for(let i=0;i<owners.length;i++){
  const openid=owners[i],teacher='synthetic_'+i+'_'+prefix,subject=access.accountKey(teacher);tokens.push((await identity.openSession(openid)).token);
  await require('../models/credential').saveCredential(openid,teacher,'synthetic-password');
  await pool.query('INSERT INTO school_account_bindings(account_key,openid,source) VALUES (?,?,?)',[subject,openid,'synthetic_test']);
  await pool.query("INSERT INTO academic_managed_rosters(openid,account_key,payload,overrides,checked_at) VALUES (?,?,?,'{}',UTC_TIMESTAMP())",[openid,subject,JSON.stringify([rows[i]])]);
 }
 d.dashboard=async(openid)=>({total:1,students:[rows[owners.indexOf(openid)]]});d.refreshManaged=async()=>({total:1,matched:1,unmatched:0});photos.view=async(openid,id)=>({available:true,imageData:'data:image/jpeg;base64,'+images[rows.findIndex(r=>r.studentId===id)].toString('base64')});photos.saveOne=photos.view;
 const service=require('../services/recognition').service();await service.migrate();
 const server=require('../app').listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/recognition';
 t.after(async()=>{await service.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await new Promise(r=>sfServer.close(r));sf.db.close();fs.rmSync(dir,{recursive:true,force:true});Object.assign(d,{dashboard:saved.dashboard,refreshManaged:saved.refresh});Object.assign(photos,{view:saved.view,saveOne:saved.one});for(const openid of owners){const [binding]=await pool.query('SELECT account_key FROM school_account_bindings WHERE openid=?',[openid]);for(const table of ['recognition_jobs','recognition_consents','recognition_settings'])if(binding[0])await pool.query('DELETE FROM '+table+' WHERE subject=?',[binding[0].account_key]);for(const table of ['academic_managed_rosters','school_account_bindings','credentials','app_sessions','app_accounts'])await pool.query('DELETE FROM '+table+' WHERE openid=?',[openid]);}await pool.end();});
 async function req(route,body,who=0){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+tokens[who],'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()}}
 async function settle(id){for(let i=0;i<100;i++){await service.tick();const r=await req('/sync-jobs/'+id);if(!['pending','running','pause_requested'].includes(r.data.status))return r.data;await new Promise(r=>setTimeout(r,80));}throw Error('worker timeout')}
 const a=await req('/state');assert.equal(a.status,200,JSON.stringify(a.data));assert.equal(a.data.scope.peopleCount,0);assert.equal(sf.db.prepare("SELECT COUNT(*) AS n FROM users WHERE password_hash='!external'").get().n,1);
 const noConsent=await req('/sync-jobs',{});assert.equal(noConsent.status,400);assert.equal(creates,0);
 const grant=await req('/consents',{confirmIndividualConsent:true,items:[{studentId:rows[0].studentId,active:true,reference:'synthetic-individual-consent-a'}]});assert.equal(grant.status,200,JSON.stringify(grant));await settle(grant.data.job.id);
 const start=await req('/sync-jobs',{enabled:true});assert.equal(start.status,202);const job=await settle(start.data.id);assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.success,1);assert.equal(creates,1);
 const repeated=await req('/sync-jobs',{});assert.equal((await settle(repeated.data.id)).status,'completed');assert.equal(creates,1,'unchanged source photo does not create a new cloud person');
 const image=images[0].toString('base64'),found=await req('/search',{image});assert.equal(found.status,200,JSON.stringify(found));assert.equal(found.data.matches.length,1);const personId=found.data.matches[0].id;
 const profile=await req('/people/'+personId);assert.equal(profile.data.details.classNo,'01');assert.equal(profile.data.academic.studentId,'00001001');assert.equal(profile.data.canWrite,false);
 assert.equal((await req('/people/'+personId,undefined,1)).status,404,'second school identity cannot access first source');
 const photo=await req('/people/'+personId+'/photo-data');assert.match(photo.data.imageData,/^data:image\/jpeg;base64,/);
 const forged=await req('/sync-jobs',{openid:owners[1]});assert.equal(forged.status,403);
 deletionFailure=true;const revoke=await req('/consents',{confirmIndividualConsent:true,items:[{studentId:rows[0].studentId,active:false,reference:'synthetic-withdrawal'}]});assert.equal(revoke.status,200);await settle(revoke.data.job.id);
 assert.equal((await req('/people/'+personId)).status,404);assert.equal(sf.db.prepare('SELECT status FROM people WHERE id=?').get(personId).status,'cleanup');
 // Verify atomic pause in the actual MySQL implementation, then resume the same persisted job after a lease expires.
 const {RecognitionStore}=require('../services/recognitionStore'),store=new RecognitionStore(pool),subject=access.accountKey('synthetic_0_'+prefix),actor={openid:owners[0],subject};
 const pending=await store.start(actor,randomUUID(),{phase:'test',done:[]});await store.pause(actor,pending.id);assert.equal((await store.job(actor,pending.id)).status,'paused');
 await store.resume(actor,pending.id);const claimed=await store.claim(randomUUID());assert.equal(claimed.id,pending.id);await store.pause(actor,pending.id);assert.equal(await store.save(claimed,{phase:'test',done:[]}),'paused');
 console.log('真实MySQL迁移、账号隔离、两后端合同、幂等同步、照片权限、撤销先退出检索、原子暂停全部通过；学校和云服务使用替身。');
});
