const {test,before,after}=require("node:test"),assert=require("node:assert/strict"),{randomUUID}=require("crypto");
if(!/_(test|stage)$/.test(process.env.DB_NAME||""))throw Error("Isolated database required");
const pool=require("../config/database"),identity=require("../services/identity"),bindings=require("../services/schoolAccountBindings"),access=require("../services/academicAccess"),flow=require("../services/schoolIdentity"),browser=require("../services/browser"),login=require("../services/login"),school=require("../services/schoolSession"),calendar=require("../services/academicCalendar"),token=require("../utils/session");
const prefix="school_test_"+randomUUID(),owner=prefix+"_owner",forged=prefix+"_other",teacher="T"+randomUUID().replaceAll("-","").slice(0,18);
const originals={acquire:browser.acquireContext,release:browser.releaseContext,navigate:login.navigateToWorkLog,valid:school.validSchoolSession,calendar:calendar.syncSchoolCalendar};
const owners=new Set([owner,forged]);let server,base,originalSession,lastPage;
function fakePage(){
 const p={phase:"login",values:{},request:{},url:()=>p.phase==="authenticated"?"https://xuegong.hitwh.edu.cn/zhxy-xgzs":"https://ids.hit.edu.cn/authserver/login",goto:async()=>{},waitForTimeout:async()=>{},waitForFunction:async()=>{},context:()=>({storageState:async()=>({cookies:[],origins:[]})})};
 p.evaluate=async fn=>String(fn).includes("reAuthParams")?"13":undefined;
 p.getByRole=()=>({first:()=>({isVisible:async()=>false})});
 p.locator=selector=>{
  const o={first:()=>o,locator:()=>o,screenshot:async()=>Buffer.from("fixture"),evaluate:async()=>{},fill:async v=>{p.values[selector]=v},isEnabled:async()=>true,
   count:async()=>{
    if(selector==="#username:visible")return p.phase==="login"?1:0;
    if(selector==="#dynamicCode:visible")return p.phase==="mfa"?1:0;
    return 0;
   },
   click:async()=>{
    if(selector==="#login_submit")p.phase=p.values["#password"]==="valid"?"mfa":"login";
    if(selector==="#reAuthSubmitBtn:visible"&&p.values["#dynamicCode:visible"]==="123456")p.phase="authenticated";
   }};
  return o;
 };
 return p;
}
async function http(path,body){const r=await fetch(base+"/api/auth"+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}}
async function settled(id){const s=flow.sessions.get(id);await s.job;return (await http("/school-signin/status",{flowId:id})).body}
async function signin(studentId,extra={}){
 const start=await http("/school-signin/start",{studentId,password:"valid",...extra});
 assert.equal(start.status,202);return settled(start.body.flowId);
}
before(async()=>{
 await require("../scripts/migrate-v12").migrate();
 originalSession=await identity.openSession(owner);await identity.openSession(forged);
 await require("../services/contentTemplates").get(owner);
 await school.persist(owner,{step:"ready",studentId:teacher,page:fakePage()});
 await require("../scripts/migrate-v19").migrate();
 browser.acquireContext=async options=>{assert.equal(options?.storageState,undefined);lastPage=fakePage();return {slot:{inUse:true},page:lastPage}};
 browser.releaseContext=async slot=>{if(slot)slot.inUse=false};
 login.navigateToWorkLog=async p=>p;
 school.validSchoolSession=async p=>p.phase==="authenticated";
 calendar.syncSchoolCalendar=async()=>({verified:true,week:11,startDate:"2026-08-31",checkedAt:new Date().toISOString()});
 server=require("../app").listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));base="http://127.0.0.1:"+server.address().port;
});
after(async()=>{
 for(const [id,s] of flow.sessions){await s.job;await flow.sessions.dispose(id)}
 for(const who of owners)await login.pendingLogins.dispose(who);
 Object.assign(browser,{acquireContext:originals.acquire,releaseContext:originals.release});
 login.navigateToWorkLog=originals.navigate;school.validSchoolSession=originals.valid;calendar.syncSchoolCalendar=originals.calendar;
 if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}
 for(const table of ["school_account_bindings","content_template_libraries","school_login_sessions","credentials","app_sessions","app_accounts"])for(const who of owners)await pool.query("DELETE FROM "+table+" WHERE openid=?",[who]);
 await pool.end();
});
test("学校校验前不发账号；正确验证码找回原账号，忽略伪造openid",async()=>{
 const pending=await signin(teacher,{openid:forged});
 assert.equal(pending.step,"mfa");assert.equal(pending.identity,undefined);
 assert.equal((await http("/school-signin/create",{flowId:pending.flowId})).status,409);
 let r=await http("/school-signin/code",{flowId:pending.flowId,code:"000000"});
 assert.equal(r.status,202);let done=await settled(pending.flowId);assert.equal(done.step,"mfa");assert.equal(done.identity,undefined);
 r=await http("/school-signin/code",{flowId:pending.flowId,code:"123456"});done=await settled(pending.flowId);
 assert.equal(done.connected,true);assert.equal(done.identity.openid,owner);
 assert.equal(token.verifyToken(done.identity.token),owner);
 assert.equal(await identity.validSession(token.tokenClaims(originalSession.token).sid,owner),true);
 const [records]=await pool.query("SELECT COUNT(*) AS n FROM content_template_libraries WHERE openid=?",[owner]);assert.equal(records[0].n,1);
});
test("错误学校密码无法凭保存过的账号或伪造身份取回记录",async()=>{
 const r=await http("/school-signin/start",{studentId:teacher,password:"wrong",openid:owner});
 const done=await settled(r.body.flowId);assert.equal(done.step,"failed");assert.equal(done.identity,undefined);
 assert.equal((await http("/school-signin/status",{flowId:"guessed-flow"})).status,409);
});
test("首次通过学校验证创建唯一账号，下次验证返回同一账号",async()=>{
 const student="N"+randomUUID().replaceAll("-","").slice(0,18);
 const pending=await signin(student);
 await http("/school-signin/code",{flowId:pending.flowId,code:"123456"});
 let done=await settled(pending.flowId);assert.equal(done.step,"confirm_new");assert.equal(done.identity,undefined);
 await http("/school-signin/create",{flowId:pending.flowId});done=await settled(pending.flowId);assert.equal(done.connected,true);owners.add(done.identity.openid);
 assert.equal(await bindings.existing(access.accountKey(student)),done.identity.openid);
 const restored=await bindings.resolveVerified(access.accountKey(student));assert.equal(restored.openid,done.identity.openid);
});
test("不将未验证的保存密码当作历史账号归属证据",async()=>{
 const student="U"+randomUUID().replaceAll("-","").slice(0,18);
 await require("../models/credential").saveCredential(forged,student,"unverified-password");
 const pending=await signin(student);
 await http("/school-signin/code",{flowId:pending.flowId,code:"123456"});
 const done=await settled(pending.flowId);
 assert.equal(done.step,"failed");assert.equal(done.identity,undefined);assert.match(done.message,/历史账号/);
 assert.equal(await bindings.existing(access.accountKey(student)),null);
});
test("续期响应丢失后原请求可重取相同结果；不同请求号、撤销设备不得绕过",async()=>{
 const session=await identity.openSession(owner),op="request-"+randomUUID();
 const first=await identity.refresh(session.refreshToken,op);
 const sid=token.tokenClaims(first.token).sid;
 await pool.query("UPDATE app_sessions SET previous_valid_until=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY) WHERE id=?",[sid]);
 const retry=await identity.refresh(session.refreshToken,op);assert.equal(retry.refreshToken,first.refreshToken);
 await assert.rejects(identity.refresh(session.refreshToken,"another-"+randomUUID()),e=>e.code==="SESSION_RECOVERY_REQUIRED");
 const next=await identity.refresh(first.refreshToken,"next-"+randomUUID());assert.notEqual(next.refreshToken,first.refreshToken);
 await assert.rejects(identity.refresh(session.refreshToken,op),e=>e.code==="SESSION_RECOVERY_REQUIRED");
 await pool.query("UPDATE app_sessions SET revoked=1 WHERE id=?",[sid]);
 await assert.rejects(identity.refresh(next.refreshToken,"revoked-"+randomUUID()),e=>e.code==="SESSION_RECOVERY_REQUIRED");
});
