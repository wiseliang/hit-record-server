const browser=require("./browser"),pool=require("../config/database"),{SessionStore}=require("./sessionStore"),{AppError}=require("../utils/errors"),{encrypt,decrypt}=require("../utils/crypto"),{digest}=require("./gradeAnalysis");
const ORIGIN="http://jwts-hitwh-edu-cn.ivpn.hitwh.edu.cn:8118";
const ENTRY="https://ids.hit.edu.cn/authserver/login?service="+encodeURIComponent("https://ivpn.hitwh.edu.cn/auth/cas_validate?entry_id=2");
const sessions=new SessionStore({ttlMs:15*60000,maxAgeMs:2*3600000,onExpire:async s=>{s.credential=null;if(s.slot)await browser.releaseContext(s.slot)}});
function accountKey(studentId) { return require("crypto").createHmac("sha256",require("../config").auth.secret).update(String(studentId)).digest("hex"); }
async function identity(openid) {
 const credential=await require("../models/credential").getCredential(openid);
 if(!credential)throw new AppError(400,"CREDENTIAL_REQUIRED","请先保存学校账号");
 return {accountKey:accountKey(credential.studentId),credential};
}
const view=s=>s?{step:s.step,busy:!!s.busy,message:s.message||"",connected:s.step==="ready",captchaImage:s.captchaImage||null,verificationType:"APP",expiresAt:new Date(s._lastUsed+15*60000).toISOString()}:{step:"none",connected:false,busy:false};
async function persist(s) {
 await require("./schoolAccountBindings").bindVerifiedOwner(s.openid,s.accountKey);
 await pool.query("INSERT INTO academic_sessions(openid,account_key,state_encrypted,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR)) ON DUPLICATE KEY UPDATE state_encrypted=VALUES(state_encrypted),expires_at=VALUES(expires_at)",
 [s.openid,s.accountKey,encrypt(JSON.stringify(await s.page.context().storageState()))]);
}
async function check(s) {
 const r=await s.page.request.get(ORIGIN+"/xfj/queryBjxsmd",{timeout:20000,maxRedirects:0});
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
 s.step="ready";s.message="教务已连接，可查询成绩";s.captchaImage=null;s.navigationRetries=0;
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
async function advance(s) {
 for(let turn=0;turn<9;turn++){
  let p=s.page,u=new URL(p.url());
  s.routeTarget=ssoTarget(p.url())||s.routeTarget||"vpn";
  if(u.hostname==="ids.hit.edu.cn"){
   s.phase="school_sso";
   if(await p.locator("#dynamicCode:visible").count()){await appCode(s,s.autoRequestCode!==false&&!s.codeRequested);return}
   const trust=p.getByRole("button",{name:/^(仅本次登录|Login this time only)$/}).first();
   if(await trust.isVisible().catch(()=>false)){await trust.click();await p.waitForTimeout(900);continue}
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
   if(u.pathname!=="/loginCAS"){await navigate(s,ORIGIN+"/loginCAS","academic_entry");continue}
   if(await check(s)){await markReady(s);return}
   const link=p.getByText("统一身份认证登录",{exact:false}).first();
   if(await link.isVisible().catch(()=>false)){await link.click();await p.waitForTimeout(900);continue}
  }
  if(u.hostname==="ivpn.hitwh.edu.cn" && u.pathname.includes("/auth/cas_validate")){await navigate(s,"https://ivpn.hitwh.edu.cn/portal/","vpn_portal");continue}
  if(u.hostname==="ivpn.hitwh.edu.cn")s.routeTarget="academic";
  const link=p.getByText(/新教务系统|新教务平台/).first();
  if(await link.isVisible().catch(()=>false)){
   const opened=p.context().waitForEvent("page",{timeout:4000}).catch(()=>null);await link.click();const next=await opened;
   if(next){s.page=next;trackPage(s,next);await next.waitForLoadState("domcontentloaded",{timeout:20000}).catch(()=>{})}
   await s.page.waitForTimeout(700);continue;
  }
  await navigate(s,ORIGIN+"/loginCAS","academic_entry");
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
async function start(openid,{requestVerification=true}={}) {
 const {accountKey,credential}=await identity(openid),old=sessions.peek(openid);
 if(old?.busy||old?.busyPlan)throw new AppError(409,"ACADEMIC_BUSY","请等待当前教务操作完成");
 await sessions.dispose(openid);
 const s={openid,accountKey,credential,autoRequestCode:requestVerification,step:"connecting",message:"正在连接教务"};sessions.set(openid,s);
 return run(s,async()=>{
  let storageState,resumeAcademic=false;
  const [saved]=await pool.query("SELECT state_encrypted FROM academic_sessions WHERE openid=? AND account_key=? AND expires_at>UTC_TIMESTAMP()",[openid,accountKey]);
  if(saved[0])try{storageState=JSON.parse(decrypt(saved[0].state_encrypted));resumeAcademic=true}catch{}
  if(!storageState){
   const [school]=await pool.query("SELECT state_encrypted,account_key FROM school_login_sessions WHERE openid=? AND expires_at>UTC_TIMESTAMP()",[openid]);
   if(school[0]?.account_key===accountKey)try{storageState=JSON.parse(decrypt(school[0].state_encrypted))}catch{}
  }
  const acquired=await browser.acquireContext({ignoreHTTPSErrors:true,storageState});Object.assign(s,acquired);
  s.routeTarget=resumeAcademic?"academic":"vpn";trackPage(s,s.page);
  s.phase=resumeAcademic?"restore_entry":"vpn_entry";
  await navigate(s,resumeAcademic?ORIGIN+"/loginCAS":ENTRY,s.phase);
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
 if(!s){await start(openid);s=sessions.get(openid);await s.job}
 if(s.accountKey!==accountKey || s.step!=="ready")throw new AppError(409,"ACADEMIC_AUTH_REQUIRED","请先连接教务并完成HIT APP验证");
 if(s.busy||s.busyPlan)throw new AppError(409,"ACADEMIC_BUSY","教务正在处理其他请求，请稍候");
 s.busyPlan=true;s._lastUsed=Date.now();
 try{if(!(await check(s))){s.step="expired";throw new AppError(409,"ACADEMIC_AUTH_REQUIRED","教务连接已过期，请重新验证")}return await fn(s)}
 finally{s.busyPlan=false;s._lastUsed=Date.now()}
}
module.exports={start,code,status,release,requestCode,withSession,identity,accountKey,isNavigationRace,navigate,ssoTarget,sessions,view,ORIGIN,check,persist};
