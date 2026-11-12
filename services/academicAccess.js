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
  if(await btn.isEnabled()) {await btn.click();await p.waitForTimeout(800)}
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
async function advance(s) {
 for(let turn=0;turn<9;turn++){
  let p=s.page,u=new URL(p.url());
  if(u.hostname==="ids.hit.edu.cn"){
   if(await p.locator("#dynamicCode:visible").count()){await appCode(s,true);return}
   const trust=p.getByRole("button",{name:/^(仅本次登录|Login this time only)$/}).first();
   if(await trust.isVisible().catch(()=>false)){await trust.click();await p.waitForTimeout(900);continue}
   if(await p.locator("#username:visible").count()){
    if(s.loginAttempted)throw new AppError(401,"ACADEMIC_LOGIN_FAILED","学校账号未通过验证，请检查账号或图片验证码后重连");
    s.loginAttempted=true;if(!(await fillLogin(s)))return;continue;
   }
   // Official CAS service stays on the school's original domain; VPN transports its callback.
   const r=await p.request.get("https://ids.hit.edu.cn/authserver/login?service="+encodeURIComponent("http://jwts.hitwh.edu.cn/loginCAS"),{maxRedirects:0,timeout:20000});
   if(r.status()===302){const location=r.headers().location;const dest=new URL(location,"https://ids.hit.edu.cn");if(dest.hostname==="jwts.hitwh.edu.cn"&&dest.pathname==="/loginCAS"&&dest.searchParams.has("ticket")){await p.goto(ORIGIN+dest.pathname+dest.search,{waitUntil:"domcontentloaded",timeout:25000});continue}}
   s.step="entry_unverified";s.message="学校认证尚未完成，请刷新连接状态";return;
  }
  if(u.origin===ORIGIN){
   if(u.pathname!=="/loginCAS")await p.goto(ORIGIN+"/loginCAS",{waitUntil:"domcontentloaded",timeout:25000});
   if(await check(s)){s.step="ready";s.message="教务已连接，可查询成绩";s.credential=null;s.captchaImage=null;await persist(s);return}
   const link=p.getByText("统一身份认证登录",{exact:false}).first();
   if(await link.isVisible().catch(()=>false)){await link.click();await p.waitForTimeout(900);continue}
  }
  if(u.hostname==="ivpn.hitwh.edu.cn" && u.pathname.includes("/auth/cas_validate")){await p.goto("https://ivpn.hitwh.edu.cn/portal/",{waitUntil:"domcontentloaded",timeout:25000});continue}
  const link=p.getByText(/新教务系统|新教务平台/).first();
  if(await link.isVisible().catch(()=>false)){
   const opened=p.context().waitForEvent("page",{timeout:4000}).catch(()=>null);await link.click();const next=await opened;
   if(next){s.page=next;await next.waitForLoadState("domcontentloaded",{timeout:20000}).catch(()=>{})}
   await s.page.waitForTimeout(700);continue;
  }
  await p.goto(ORIGIN+"/loginCAS",{waitUntil:"domcontentloaded",timeout:25000});
 }
 throw new AppError(503,"ACADEMIC_ENTRY_UNVERIFIED","未取得可读成绩的教务连接，请重试");
}
function run(s,fn) {
 if(s.busy||s.busyPlan)throw new AppError(409,"ACADEMIC_BUSY","教务正在处理查询或连接，请稍候");
 s.busy=true;s.busyPlan=true;s._lastUsed=Date.now();
 s.job=(async()=>{let timer;try{
  await Promise.race([fn(),new Promise((_,reject)=>{timer=setTimeout(()=>{void browser.releaseContext(s.slot);reject(new AppError(504,"ACADEMIC_TIMEOUT","连接超时，请重试"))},120000)})]);
 }catch(e){s.step="failed";s.message=e instanceof AppError?e.message:"教务连接暂时不可用，请重试";s.credential=null;await browser.releaseContext(s.slot)}
 finally{clearTimeout(timer);s.busy=false;s.busyPlan=false;s._lastUsed=Date.now()}})();
 return view(s);
}
async function start(openid) {
 const {accountKey,credential}=await identity(openid),old=sessions.peek(openid);
 if(old?.busy||old?.busyPlan)throw new AppError(409,"ACADEMIC_BUSY","请等待当前教务操作完成");
 await sessions.dispose(openid);
 const s={openid,accountKey,credential,step:"connecting",message:"正在连接教务"};sessions.set(openid,s);
 return run(s,async()=>{
  let storageState;
  const [saved]=await pool.query("SELECT state_encrypted FROM academic_sessions WHERE openid=? AND account_key=? AND expires_at>UTC_TIMESTAMP()",[openid,accountKey]);
  if(saved[0])try{storageState=JSON.parse(decrypt(saved[0].state_encrypted))}catch{}
  if(!storageState){
   const [school]=await pool.query("SELECT state_encrypted,account_key FROM school_login_sessions WHERE openid=? AND expires_at>UTC_TIMESTAMP()",[openid]);
   if(school[0]?.account_key===accountKey)try{storageState=JSON.parse(decrypt(school[0].state_encrypted))}catch{}
  }
  const acquired=await browser.acquireContext({ignoreHTTPSErrors:true,storageState});Object.assign(s,acquired);
  await s.page.goto(storageState?ORIGIN+"/loginCAS":ENTRY,{waitUntil:"domcontentloaded",timeout:30000});
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
   await appCode(s);await s.page.locator("#dynamicCode:visible").fill(value.trim());await s.page.locator("#reAuthSubmitBtn:visible").first().click();await s.page.waitForTimeout(1200);
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
module.exports={start,code,status,release,requestCode,withSession,identity,accountKey,sessions,view,ORIGIN,check,persist};
