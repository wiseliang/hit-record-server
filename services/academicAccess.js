const browser=require("./browser"),pool=require("../config/database"),{SessionStore}=require("./sessionStore"),{AppError}=require("../utils/errors"),{encrypt,decrypt}=require("../utils/crypto"),{digest}=require("./gradeAnalysis");
const ORIGIN="http://jwts-hitwh-edu-cn.ivpn.hitwh.edu.cn:8118";
const ENTRY="https://ids.hit.edu.cn/authserver/login?service="+encodeURIComponent("https://ivpn.hitwh.edu.cn/auth/cas_validate?entry_id=2");
const sessions=new SessionStore({ttlMs:15*60000,maxAgeMs:2*3600000,onExpire:async s=>{s.credential=null;if(s.slot)await browser.releaseContext(s.slot)}});
function retentionHours(){const value=Number(process.env.ACADEMIC_SESSION_RETENTION_HOURS||24);return Number.isInteger(value)&&value>=1&&value<=168?value:24;}
function accountKey(studentId) { return require("crypto").createHmac("sha256",require("../config").auth.secret).update(String(studentId)).digest("hex"); }
async function identity(openid) {
 const credential=await require("../models/credential").getCredential(openid);
 if(!credential)throw new AppError(400,"CREDENTIAL_REQUIRED","请先保存学校账号");
 return {accountKey:accountKey(credential.studentId),credential};
}
const view=s=>s?{step:s.step,busy:!!(s.busy||s.busyPlan),message:s.message||"",connected:s.step==="ready",captchaImage:s.captchaImage||null,verificationType:"APP",expiresAt:new Date(s._lastUsed+15*60000).toISOString()}:{step:"none",connected:false,busy:false};
async function persist(s) {
 await require("./schoolAccountBindings").bindVerifiedOwner(s.openid,s.accountKey);
 await pool.query("INSERT INTO academic_sessions(openid,account_key,state_encrypted,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? HOUR)) ON DUPLICATE KEY UPDATE state_encrypted=VALUES(state_encrypted),expires_at=VALUES(expires_at)",
 [s.openid,s.accountKey,encrypt(JSON.stringify(await s.page.context().storageState())),retentionHours()]);
}
async function check(s) {
 let r;try{r=await s.page.request.get(ORIGIN+"/xfj/queryBjxsmd",{timeout:20000,maxRedirects:0});}
 catch{throw new AppError(503,"ACADEMIC_UNAVAILABLE","教务暂时没有响应，登录状态保留，请稍后重试");}
 if(r.status()>=500||r.status()===429)throw new AppError(503,"ACADEMIC_UNAVAILABLE","教务暂时繁忙，登录状态保留，请稍后重试");
 if(r.status()!==200)return false;
 const html=await r.text();
 return /不及格门数/.test(html)&&/pageZydm/.test(html)&&!/id=["']password["']/.test(html);
}
async function appCode(s,send=false) {
 const p=s.page;
 const current=await p.evaluate(()=>typeof reAuthParams!=="undefined"?String(reAuthParams.reAuthType):null);
 if(current!=="13"){await p.locator("#tab_13").click();await p.waitForFunction(()=>typeof reAuthParams!=="undefined"&&String(reAuthParams.reAuthType)==="13",{},{timeout:10000})}
 s.step="code";s.message="请查看HIT APP本次验证码";
 if(send){
  const btn=p.locator("#getDynamicCode:visible").first();
  if(await btn.isEnabled()) {await btn.click();s.codeRequested=true;await p.waitForTimeout(800)}
  s.message="请填写HIT APP本次验证码；如未收到，可稍后重新获取";
 }
}
async function fillLogin(s,captcha) {
 const p=s.page,c=s.credential;
 if(!c)throw new AppError(409,"ACADEMIC_AUTH_REQUIRED","请重新连接教务");
 await p.locator("#username:visible").fill(c.studentId);
 // The school disables this field after encrypting a prior submission.
 await p.locator("#password").evaluate(e=>{e.disabled=false});await p.locator("#password").fill(c.password);
 const cap=p.locator("#captcha:visible");
 if(await cap.count()){
  if(!captcha){s.step="captcha";// Capture only the captcha area, never a full page of credentials.
   const el=p.locator("#captcha").locator("..");s.captchaImage="data:image/png;base64,"+(await el.screenshot()).toString("base64");s.message="请填写学校图片验证码";return false}
  await cap.fill(captcha);
 }
 await p.evaluate(()=>{const salt=document.getElementById("pwdEncryptSalt"),pwd=document.getElementById("password");if(salt?.value&&window.encryptPassword){document.getElementById("saltPassword").value=window.encryptPassword(pwd.value,salt.value);pwd.disabled=true}});
 await p.locator("#login_submit").click();await p.waitForTimeout(1200);return true;
}
function isNavigationRace(error) {
 return /net::ERR_ABORTED|Navigation .* interrupted by another navigation|Execution context was destroyed/i.test(String(error?.message||""));
}
async function navigate(s,url,phase) {
 s.phase=phase;
 try {await s.page.goto(url,{waitUntil:"domcontentloaded",timeout:25000});return true}
 catch(error){
  if(!isNavigationRace(error))throw error;
  s.navigationRetries=(s.navigationRetries||0)+1;
  if(s.navigationRetries>5)throw new AppError(503,"ACADEMIC_NAVIGATION_INTERRUPTED","学校登录跳转多次中断，请稍后重新连接");
  require("../utils/logger").info("Academic navigation settling",{stage:phase});
  await s.page.waitForLoadState("domcontentloaded",{timeout:6000}).catch(()=>{});
  await s.page.waitForTimeout(600);
  // CAS tickets are single-use. Do not blindly navigate to the same ticket again.
  return false;
 }
}
async function markReady(s) {
 s.step="ready";s.message=s.restoredFrom?"已恢复有效教务连接，无需重复验证":"教务已连接，可查询成绩";s.captchaImage=null;s.navigationRetries=0;
 await persist(s);s.credential=null;
}
function ssoTarget(value) {
 try {
  const source=new URL(value);
  if(source.hostname!=="ids.hit.edu.cn")return null;
  const service=source.searchParams.get("service");if(!service)return null;
  const target=new URL(service);
  if(target.hostname==="ivpn.hitwh.edu.cn")return "vpn";
  if(["jwts.hitwh.edu.cn",new URL(ORIGIN).hostname].includes(target.hostname))return "academic";
 }catch{}
 return null;
}
function trackPage(s,page){
 if(typeof page.on==="function")page.on("framenavigated",frame=>{
  if(typeof frame.parentFrame==="function"&&frame.parentFrame())return;
  const target=ssoTarget(frame.url());if(target)s.routeTarget=target;
 });
}
const ACADEMIC_CAS="https://ids.hit.edu.cn/authserver/login?service="+encodeURIComponent("http://jwts.hitwh.edu.cn/loginCAS");
// Silent recovery uses only an existing official CAS login and verifies the
// protected teaching page; it never submits credentials or requests MFA.
async function tryAcademicSso(s){
 let r;try{r=await s.page.request.get(ACADEMIC_CAS,{maxRedirects:0,timeout:20000});}
 catch{throw new AppError(503,'ACADEMIC_UNAVAILABLE','学校认证暂时没有响应，登录状态保留，请稍后重试');}
 if(r.status()>=500||r.status()===429)throw new AppError(503,'ACADEMIC_UNAVAILABLE','学校认证暂时繁忙，登录状态保留，请稍后重试');
 if(r.status()!==302)return false;
 const location=r.headers?.().location;if(!location)return false;
 let dest;try{dest=new URL(location,'https://ids.hit.edu.cn');}catch{return false;}
 if(dest.origin!=='http://jwts.hitwh.edu.cn'||dest.pathname!=='/loginCAS'||!dest.searchParams.has('ticket'))return false;
 await navigate(s,ORIGIN+dest.pathname+dest.search,'cas_callback');
 return check(s);
}
async function enterAcademic(s) {
 s.routeTarget="academic";s.phase="cas_callback";
 // The native CAS Location points at the campus-only host. Obtain a fresh
 // ticket without following that redirect, then consume it through WebVPN.
 const response=await s.page.request.get(ACADEMIC_CAS,{maxRedirects:0,timeout:20000});
 if(response.status()===302){
  const dest=new URL(response.headers().location,"https://ids.hit.edu.cn");
  if(dest.origin==="http://jwts.hitwh.edu.cn"&&dest.pathname==="/loginCAS"&&dest.searchParams.has("ticket")){
   await navigate(s,ORIGIN+dest.pathname+dest.search,"cas_callback");return;
  }
  if(dest.origin==="https://ids.hit.edu.cn"&&dest.pathname.startsWith("/authserver/")){
   await navigate(s,dest.href,"school_sso");return;
  }
  throw new AppError(502,"ACADEMIC_CAS_REDIRECT_INVALID","学校教务认证返回了未识别的跳转，请稍后重试");
 }
 if(response.status()!==200)throw new AppError(503,"ACADEMIC_CAS_UNAVAILABLE","学校教务认证暂不可用，请稍后重试");
 await navigate(s,ACADEMIC_CAS,"school_sso");
}
async function advance(s) {
 for(let turn=0;turn<9;turn++){
  let p=s.page,u=new URL(p.url());
  s.routeTarget=ssoTarget(p.url())||s.routeTarget||"vpn";
  if(u.hostname==="ids.hit.edu.cn"){
   s.phase="school_sso";
   if(await p.locator("#dynamicCode:visible").count()){await appCode(s,s.autoRequestCode!==false&&!s.codeRequested);return}
      if(await require('./trustedDevice').chooseTrustedDevice(p)){await p.waitForTimeout(900);continue}
   if(await p.locator("#username:visible").count()){
    if(s.loginAttempted)throw new AppError(401,"ACADEMIC_LOGIN_FAILED","学校账号未通过验证，请检查账号或图片验证码后重连");
    s.loginAttempted=true;if(!(await fillLogin(s)))return;continue;
   }
   // Finish the SSO service that is actually in progress. A school cookie is
   // not a VPN cookie: do not fetch an academic ticket while VPN CAS is pending.
   const target=s.routeTarget==="vpn"?"vpn":"academic";
   s.phase=target==="vpn"?"vpn_callback":"cas_callback";
   const serviceUrl=target==="vpn"?ENTRY:"https://ids.hit.edu.cn/authserver/login?service="+encodeURIComponent("http://jwts.hitwh.edu.cn/loginCAS");
   const r=await p.request.get(serviceUrl,{maxRedirects:0,timeout:20000});
   if(r.status()===302){
    const dest=new URL(r.headers().location,"https://ids.hit.edu.cn");
    if(target==="vpn"&&dest.hostname==="ivpn.hitwh.edu.cn"&&dest.pathname==="/auth/cas_validate"){await navigate(s,dest.href,"vpn_callback");continue}
    if(target==="academic"&&dest.hostname==="jwts.hitwh.edu.cn"&&dest.pathname==="/loginCAS"&&dest.searchParams.has("ticket")){await navigate(s,ORIGIN+dest.pathname+dest.search,"cas_callback");continue}
    if(dest.hostname==="ids.hit.edu.cn"&&dest.pathname.startsWith("/authserver/")){await navigate(s,dest.href,"school_sso");continue}
   }
   s.step="entry_unverified";s.message="学校认证尚未完成，请刷新连接状态";return;
  }
  if(u.origin===ORIGIN){
   s.phase="academic_entry";
   if(await check(s)){await markReady(s);return}
   await enterAcademic(s);continue;
  }
  if(u.hostname==="ivpn.hitwh.edu.cn"||u.hostname==="jwts.hitwh.edu.cn"){
   await enterAcademic(s);continue;
  }
  throw new AppError(502,"ACADEMIC_ENTRY_UNRECOGNIZED","学校登录进入了未识别的页面，请重新连接");
 }
 throw new AppError(503,"ACADEMIC_ENTRY_UNVERIFIED","未取得可读成绩的教务连接，请重试");
}
function run(s,fn) {
 if(s.busy||s.busyPlan)throw new AppError(409,"ACADEMIC_BUSY","教务正在处理查询或连接，请稍候");
 s.busy=true;s.busyPlan=true;s._lastUsed=Date.now();
 s.job=(async()=>{let timer;try{
  await Promise.race([fn(),new Promise((_,reject)=>{timer=setTimeout(()=>{void browser.releaseContext(s.slot);reject(new AppError(504,"ACADEMIC_TIMEOUT","连接超时，请重试"))},120000)})]);
 }catch(e){
 if(isNavigationRace(e)){
  try{await s.page.waitForLoadState("domcontentloaded",{timeout:6000}).catch(()=>{});if(await check(s)){await markReady(s);return}}catch{}
  s.navigationRetries=(s.navigationRetries||0)+1;
  if(s.navigationRetries<=5){s.step="entry_unverified";s.message="学校登录正在跳转，正在继续检查教务连接";return}
 }
 const credential=s.credential;
 let detail=String(e.message||e.name).split("\n")[0].replace(/https?:\/\/\S+/g,"[URL]");
 for(const secret of [credential?.password,credential?.studentId])if(secret)detail=detail.split(secret).join("[redacted]");
 s.failure={stage:s.phase||"connect",name:e.name,detail};
 require("../utils/logger").warn("Academic connection failed",s.failure);
 s.step="failed";s.message=e instanceof AppError?e.message:(({vpn_entry:"学校VPN连接",restore_entry:"教务登录恢复",school_sso:"学校身份验证",vpn_callback:"VPN登录跳转",cas_callback:"教务登录跳转",academic_entry:"教务页面加载",vpn_portal:"VPN门户加载"})[s.phase]||"教务连接")+"未完成，请稍后重新连接";s.credential=null;await browser.releaseContext(s.slot)}
 finally{clearTimeout(timer);s.busy=false;s.busyPlan=false;s._lastUsed=Date.now()}})();
 return view(s);
}
async function start(openid,{requestVerification=true,force=false}={}) {
 const {accountKey,credential}=await identity(openid),old=sessions.peek(openid);
 if(old?.busy||old?.busyPlan)throw new AppError(409,"ACADEMIC_BUSY","请等待当前教务操作完成");
 if(!force&&old?.accountKey===accountKey&&['code','captcha'].includes(old.step)){
  if(old.step==='code'&&requestVerification&&!old.codeRequested)return run(old,()=>appCode(old,true));
  return view(old);
 }
 const reusable=!force&&old?.accountKey===accountKey&&old.step==='ready'&&old._createdAt+2*3600000>Date.now()?old:null;
 if(!reusable)await sessions.dispose(openid);
 const s=reusable||{openid,accountKey,step:"connecting",message:"正在连接教务"};Object.assign(s,{credential,autoRequestCode:requestVerification});if(!reusable)sessions.set(openid,s);
 return run(s,async()=>{
  if(reusable){s.phase='reuse_live';if(await check(s)){s.restoredFrom='live';await markReady(s);return;}await browser.releaseContext(s.slot);s.slot=null;s.loginAttempted=false;s.codeRequested=false;s.restoredFrom=null;s.navigationRetries=0;s.captchaImage=null;}
  let storageState;
  const [saved]=await pool.query("SELECT state_encrypted FROM academic_sessions WHERE openid=? AND account_key=? AND expires_at>UTC_TIMESTAMP()",[openid,accountKey]);
  if(saved[0])try{storageState=JSON.parse(decrypt(saved[0].state_encrypted))}catch{}
  if(!storageState){
   const [school]=await pool.query("SELECT state_encrypted,account_key FROM school_login_sessions WHERE openid=? AND expires_at>UTC_TIMESTAMP()",[openid]);
   if(school[0]?.account_key===accountKey)try{storageState=JSON.parse(decrypt(school[0].state_encrypted))}catch{}
  }
  const acquired=await browser.acquireContext({ignoreHTTPSErrors:true,storageState});Object.assign(s,acquired);
  if(storageState){
   s.phase="restore_entry";
   if(await check(s)){s.restoredFrom='saved';await markReady(s);return}
   if(await tryAcademicSso(s)){s.restoredFrom='sso';await markReady(s);return}
   // An expired teaching cookie must not drag a new login back into stale SSO.
   await browser.releaseContext(s.slot);
   Object.assign(s,await browser.acquireContext({ignoreHTTPSErrors:true}));
  }
  s.routeTarget="vpn";trackPage(s,s.page);
  s.phase="vpn_entry";
  await navigate(s,ENTRY,s.phase);
  await advance(s);
 });
}
async function code(openid,value){
 const s=sessions.get(openid);if(!s||!["code","captcha"].includes(s.step))throw new AppError(409,"ACADEMIC_AUTH_REQUIRED","验证码会话已变化，请重连教务");
 const pattern=s.step==="code"?/^\d{4,8}$/:/^[A-Za-z0-9]{4,8}$/;
 if(typeof value!=="string"||!pattern.test(value.trim()))throw new AppError(400,"INVALID_CODE","请填写本次学校验证码");
 return run(s,async()=>{
  if(s.step==="captcha"){s.captchaImage=null;if(!(await fillLogin(s,value.trim())))return}
  else{
   await appCode(s);await s.page.locator("#dynamicCode:visible").fill(value.trim());await s.page.locator("#reAuthSubmitBtn:visible").first().click();await s.page.waitForTimeout(1200);await s.page.waitForLoadState("domcontentloaded",{timeout:6000}).catch(()=>{});
   if(new URL(s.page.url()).hostname==="ids.hit.edu.cn"&&/验证码错误|验证码已失效|验证码已过期/.test(await s.page.locator("body").innerText())){s.step="code";s.message="学校提示验证码错误或已失效，请获取最新HIT APP验证码";return}
  }
  await advance(s);
 });
}
async function status(openid){const s=sessions.get(openid);if(s){const {accountKey}=await identity(openid);if(s.accountKey!==accountKey){if(!s.busyPlan)await sessions.dispose(openid);return view(null)}}if(s&&!s.busy&&!s.busyPlan&&s.step==="entry_unverified")return run(s,()=>advance(s));return view(s)}
async function release(openid){const s=sessions.peek(openid);if(s?.busy||s?.busyPlan)throw new AppError(409,"ACADEMIC_BUSY","查询处理中，请稍后断开");await sessions.dispose(openid);await pool.query("DELETE FROM academic_sessions WHERE openid=?",[openid]);return view(null)}
async function requestCode(openid){const s=sessions.get(openid);if(s?.step!=="code")throw new AppError(409,"ACADEMIC_AUTH_REQUIRED","请先发起教务连接");return run(s,()=>appCode(s,true))}
async function withSession(openid,fn){
 const {accountKey}=await identity(openid);let s=sessions.get(openid);
 if(!s){await start(openid,{requestVerification:false});s=sessions.get(openid);await s.job}
 if(s.accountKey!==accountKey || s.step!=="ready")throw new AppError(409,"ACADEMIC_AUTH_REQUIRED",s.step==="code"&&!s.codeRequested?"教务需要二次验证，请进入教务连接，点击重新获取HIT APP验证码后继续":"请先连接教务并完成HIT APP验证");
 if(s.busy||s.busyPlan)throw new AppError(409,"ACADEMIC_BUSY","教务正在处理其他请求，请稍候");
 s.busyPlan=true;s._lastUsed=Date.now();
 try{
  if(!(await check(s))){if(await tryAcademicSso(s)){s.restoredFrom='sso';await markReady(s);}else{s.step="expired";throw new AppError(409,"ACADEMIC_AUTH_REQUIRED","教务连接已过期，请重新验证")}}
  const result=await fn(s);
  // A snapshot failure must not make a completed business operation look uncommitted.
  await persist(s).catch(()=>require('../utils/logger').warn('Academic session snapshot could not be refreshed'));
  return result;
 }
 finally{s.busyPlan=false;s._lastUsed=Date.now()}
}
module.exports={start,code,status,release,requestCode,withSession,identity,accountKey,isNavigationRace,navigate,ssoTarget,enterAcademic,sessions,view,ORIGIN,check,persist,retentionHours,tryAcademicSso};
