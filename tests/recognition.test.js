const {test}=require('node:test'),assert=require('node:assert/strict'),{createRecognition}=require('../services/recognition');
const clone=x=>structuredClone(x);
class MemoryStore {
 constructor(){this.settings=new Map();this.g=new Map();this.jobs=new Map();}
 async setting(a){if(!this.settings.has(a.subject))this.settings.set(a.subject,{revision:1,enabled:false,last_check:0});return clone(this.settings.get(a.subject));}
 async consents(s){return clone(this.g.get(s)||[]);}
 async grant(a,items){const rows=this.g.get(a.subject)||[];for(const x of items){let row=rows.find(r=>r.student_id===x.studentId);if(!row){row={student_id:x.studentId};rows.push(row)}Object.assign(row,{active:x.active,reference:x.reference})}this.g.set(a.subject,rows);this.settings.get(a.subject).revision++;for(const j of this.jobs.values())if(j.subject===a.subject&&['pending','running'].includes(j.status))j.status='cancelled';}
 async configure(a,v){this.settings.get(a.subject).enabled=v;}
 async latest(s){return [...this.jobs.values()].filter(j=>j.subject===s).at(-1)||null;}
 async job(a,id){const j=this.jobs.get(id);if(!j||j.subject!==a.subject)throw Object.assign(Error('not found'),{status:404});return clone(j);}
 async start(a,id,p){const current=[...this.jobs.values()].find(j=>j.subject===a.subject&&['pending','running'].includes(j.status));if(current)return clone(current);const s=this.settings.get(a.subject);s.revision++;s.last_check=Date.now();const j={id,subject:a.subject,openid:a.openid,revision:s.revision,status:'pending',payload:clone(p)};this.jobs.set(id,j);return clone(j);}
 async claim(owner){const j=[...this.jobs.values()].find(j=>j.status==='pending');if(!j)return null;j.status='running';j.lease_owner=owner;return clone(j);}
 async save(j,p,status='running'){const current=this.jobs.get(j.id);if(current.status==='cancelled')throw Error('cancelled');if(current.status==='pause_requested'&&status==='running')status='paused';current.payload=clone(p);current.status=status;return status;}
 async pause(a,id){const j=await this.job(a,id);this.jobs.get(id).status=j.status==='pending'?'paused':'pause_requested';return this.job(a,id);}
 async resume(a,id){await this.job(a,id);this.jobs.get(id).status='pending';return this.job(a,id);}
}
async function setup(){
 const store=new MemoryStore(),rows=[{studentId:'0012345678',name:'甲',className:'班级',cohortKey:'class-a'},{studentId:'0012345679',name:'乙'}],calls=[],members=new Map();let failId,photoHook;
 const bridge={configured:()=>true,exchange:async()=>({libraryId:'source'}),api:async(s,path)=>path==='/search-scope'?{peopleCount:members.size}:{status:'candidate',matches:[...members.values()].map(m=>({...m,status:'active',libraryId:'source',score:99}))},signed:async(s,path,b)=>{calls.push({s,path,b});if(path==='members'){if(b.studentId===failId)throw Object.assign(Error('quality failed'),{status:422,code:'PHOTO_QUALITY'});const old=members.get(b.studentId);members.set(b.studentId,{id:b.studentId,employeeNo:b.studentId,name:b.values.name});return {id:b.studentId,status:'active',unchanged:!!old}}return {cleanupPending:0};}};
 const service=createRecognition({store,bridge,actor:async id=>({openid:id,subject:id==='a'?'a'.repeat(64):'b'.repeat(64)}),roster:async()=>rows,refreshRoster:async()=>{},photo:async(a,id)=>{await photoHook?.(id);return {bytes:Buffer.from(id),hash:id}},delay:async()=>{}});
 await service.state('a');return {store,service,rows,calls,members,setFail:id=>failId=id,setHook:fn=>photoHook=fn};
}
async function drain(s){for(let i=0;i<100;i++){await s.tick();await new Promise(r=>setImmediate(r));} }
test('no implicit consent; per-student grants, persistent row retry and identity isolation',async()=>{
 const x=await setup();await assert.rejects(x.service.start('a'),e=>e.code==='CONSENT_REQUIRED');assert.equal(x.calls.length,0);
 await assert.rejects(x.service.grants('a',{items:[{studentId:x.rows[0].studentId,active:true,reference:'consent'}]}),e=>e.code==='CONSENT_REQUIRED');
 await x.service.grants('a',{confirmIndividualConsent:true,items:x.rows.map(r=>({studentId:r.studentId,active:true,reference:'explicit-consent-'+r.studentId}))});await drain(x.service);
 x.setFail(x.rows[1].studentId);const j=await x.service.start('a',{enabled:true});await drain(x.service);let result=await x.service.job('a',j.id);assert.equal(result.status,'partial');assert.equal(result.success,1);assert.equal(result.failures.length,1);
 await assert.rejects(x.service.job('b',j.id),e=>e.status===404);
 x.setFail(undefined);await x.service.resume('a',j.id);await drain(x.service);result=await x.service.job('a',j.id);assert.equal(result.status,'completed');assert.equal(result.success,2);
 assert.equal(x.calls.filter(c=>c.path==='members'&&c.b.studentId===x.rows[0].studentId).length,1,'resume skips committed success');
 const before=x.store.jobs.size;await x.service.check('a');assert.equal(x.store.jobs.size,before,'login check is throttled');
});
test('revocation during school fetch prevents sending the face and filters stale upstream candidates',async()=>{
 const x=await setup(),id=x.rows[0].studentId;await x.service.grants('a',{confirmIndividualConsent:true,items:[{studentId:id,reference:'individual-consent',active:true}]});await drain(x.service);
 x.setHook(async()=>{await x.store.grant({subject:'a'.repeat(64)},[{studentId:id,reference:'withdrawn',active:false}]);});
 await x.service.start('a');await drain(x.service);assert.equal(x.calls.filter(c=>c.path==='members').length,0);
 x.members.set(id,{id,employeeNo:id,name:'old candidate'});const r=await x.service.search('a',Buffer.from('synthetic').toString('base64'));assert.deepEqual(r.matches,[]);assert.equal(r.status,'none');assert.equal(r.scopeChanged,true);
});
test('worker pauses at a safe boundary and can be resumed after the UI is gone',async()=>{
 const x=await setup(),id=x.rows[0].studentId;await x.service.grants('a',{confirmIndividualConsent:true,items:[{studentId:id,reference:'individual-consent',active:true}]});await drain(x.service);
 let jobId;x.setHook(async()=>{await x.service.pause('a',jobId)});
 // Hold worker claim while start returns its persisted identifier.
 const claim=x.store.claim.bind(x.store);let hold=true;x.store.claim=async owner=>hold?null:claim(owner);
 const j=await x.service.start('a');jobId=j.id;hold=false;await drain(x.service);assert.equal((await x.service.job('a',j.id)).status,'paused');assert.equal(x.calls.filter(c=>c.path==='members').length,0);
 x.setHook(undefined);await x.service.resume('a',j.id);await drain(x.service);assert.equal((await x.service.job('a',j.id)).status,'completed');
});
test('roster changes cancel an in-flight source version and queue scope reconciliation',async()=>{
 const x=await setup(),id=x.rows[0].studentId;await x.service.grants('a',{confirmIndividualConsent:true,items:[{studentId:id,reference:'individual-consent',active:true}]});await drain(x.service);
 x.setHook(async()=>{x.rows.splice(0,x.rows.length);await x.service.reconcile('a')});
 const job=await x.service.start('a');await drain(x.service);assert.equal((await x.service.job('a',job.id)).status,'cancelled');assert.equal(x.calls.filter(c=>c.path==='members').length,0);assert.deepEqual(x.calls.filter(c=>c.path==='scope').at(-1).b.studentIds,[]);
});
