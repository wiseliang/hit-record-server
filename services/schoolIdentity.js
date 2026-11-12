const {randomBytes}=require("crypto"),browser=require("./browser"),{SessionStore}=require("./sessionStore"),{AppError}=require("../utils/errors"),identity=require("./identity"),bindings=require("./schoolAccountBindings"),school=require("./schoolSession"),{accountKey}=require("./academicAccess");
const ENTRY="https://ids.hit.edu.cn/authserver/login?service="+encodeURIComponent("https://xuegong.hitwh.edu.cn/cas");
const sessions=new SessionStore({ttlMs:10*60000,maxAgeMs:15*60000,onExpire:async s=>{s.password="";s.identity=null;if(s.slot)await browser.releaseContext(s.slot)}});
function view(s){
 return {flowId:s.flowId,step:s.step,busy:!!s.busy,connected:s.step==="ready",message:s.message||"",captchaImage:s.captchaImage||null,...(s.step==="ready"?{identity:s.identity,restored:s.restored}:{})};
}
function required(id){
 const s=typeof id==="string"?sessions.get(id):null;
 if(!s)throw new AppError(409,"SCHOOL_SIGNIN_EXPIRED","验证已过期，请重新输入学校账号登录");
 return s;
}
async function appVerification(s,send=false){
 const p=s.page;
 const current=await p.evaluate(()=>typeof reAuthParams!=="undefined"?String(reAuthParams.reAuthType):null);
 if(current!=="13"){await p.locator("#tab_13").click();await p.waitForFunction(()=>typeof reAuthParams!=="undefined"&&String(reAuthParams.reAuthType)==="13",{},{timeout:10000})}
 if(send){
  const btn=p.locator("#getDynamicCode:visible").first();
  if(await btn.isEnabled()){await btn.click();s.codeSentAt=Date.now();await p.waitForTimeout(600)}
 }
 s.step="mfa";s.message="请在HIT APP查看本次验证码，填入下方继续验证";
}
async function finish(s){
 if(!(await school.validSchoolSession(s.page)))throw new AppError(401,"SCHOOL_SIGNIN_NOT_VERIFIED","学校尚未完成身份验证，请重新登录");
 // This is the only point where an anonymous flow may resolve an account.
 const resolved=await bindings.resolveVerified(s.accountKey,{allowCreate:s.allowCreate===true});
 if(resolved.requiresCreation){s.step="confirm_new";s.message="未找到该学校账号的历史绑定。首次使用可以创建账号；如已有旧记录，请先用本机备份或联系维护者核对";return}
 s.identity??=await identity.openSession(resolved.openid);s.restored=resolved.restored;
 if(s.remember)await require("../models/credential").saveCredential(resolved.openid,s.studentId,s.password);
 const {pendingLogins}=require("./login"),existing=pendingLogins.peek(resolved.openid);
 const active=await require("../models/tasksV12").active(resolved.openid);
 if(!existing&&!active){
  let calendar={};try{calendar=await require("./academicCalendar").syncSchoolCalendar(s.page)}catch{}
  const prior=await school.stored(resolved.openid);
  const connection={page:s.page,slot:s.slot,step:"ready",studentId:s.studentId,password:"",calendar,_openid:resolved.openid,_validatedAt:Date.now()};
  if(prior?.account_key===s.accountKey&&Number(prior.ttl)>0){
   connection.connectionId=prior.connection_id;connection.accountKey=prior.account_key;
   connection.authExpiresAt=new Date(prior.expires_at).getTime();
   await school.persist(resolved.openid,connection,{existingOnly:true});
  }else await school.persist(resolved.openid,connection);
  pendingLogins.set(resolved.openid,connection);s.slot=null;
 }
 if(s.slot){await browser.releaseContext(s.slot);s.slot=null}
 s.password="";s.captchaImage=null;s.step="ready";s.message=resolved.restored?"已找回原账号，历史记录保留":"学校身份已验证，账号已建立";
}
async function advance(s,captcha){
 for(let turn=0;turn<10;turn++){
  const p=s.page,u=new URL(p.url());
  if(u.hostname==="xuegong.hitwh.edu.cn"){
   // Navigate to a protected read page before accepting the school identity.
   await require("./login").navigateToWorkLog(p);await finish(s);return;
  }
  if(u.hostname!=="ids.hit.edu.cn")throw new AppError(502,"SCHOOL_SIGNIN_ENTRY_CHANGED","学校登录入口发生变化，请稍后重试");
  if(await p.locator("#dynamicCode:visible").count()){await appVerification(s,!s.codeSentAt);return}
  const trust=p.getByRole("button",{name:/^(仅本次登录|Login this time only)$/}).first();
  if(await trust.isVisible().catch(()=>false)){await trust.click();await p.waitForTimeout(600);continue}
  if(await p.locator("#username:visible").count()){
   if(s.submitted)throw new AppError(401,"SCHOOL_LOGIN_FAILED","学校未通过账号或密码验证，请检查后重试");
   await p.locator("#username:visible").fill(s.studentId);
   await p.locator("#password").evaluate(e=>{e.disabled=false});await p.locator("#password").fill(s.password);
   const field=p.locator("#captcha:visible");
   if(await field.count()){
    if(!captcha){s.step="captcha";s.captchaImage="data:image/png;base64,"+(await field.locator("..").screenshot()).toString("base64");s.message="请填写学校图片验证码";return}
    await field.fill(captcha);
   }
   await p.evaluate(()=>{const salt=document.getElementById("pwdEncryptSalt"),pwd=document.getElementById("password");if(salt?.value&&window.encryptPassword){document.getElementById("saltPassword").value=window.encryptPassword(pwd.value,salt.value);pwd.disabled=true}});
   s.submitted=true;await p.locator("#login_submit").click();await p.waitForTimeout(1200);continue;
  }
  // Complete only the expected official CAS callback. Never log its ticket.
  const r=await p.request.get(ENTRY,{maxRedirects:0,timeout:15000});
  if(r.status()===302){const target=new URL(r.headers().location,"https://ids.hit.edu.cn");if(target.hostname==="xuegong.hitwh.edu.cn"&&target.pathname==="/cas"&&target.searchParams.has("ticket")){await p.goto(target.href,{waitUntil:"domcontentloaded",timeout:20000});continue}}
  await p.waitForTimeout(600);
 }
 throw new AppError(502,"SCHOOL_SIGNIN_INCOMPLETE","学校认证尚未完成，请重新发起登录");
}
function run(s,fn){
 if(s.busy)throw new AppError(409,"SCHOOL_SIGNIN_BUSY","学校正在验证，请稍候");
 s.busy=true;s.busyPlan=true;
 s.job=(async()=>{let timer;try{
  await Promise.race([fn(),new Promise((_,reject)=>{timer=setTimeout(()=>{if(s.slot)void browser.releaseContext(s.slot);reject(new AppError(504,"SCHOOL_SIGNIN_TIMEOUT","学校验证超时，请重试"))},90000)})]);
 }catch(e){s.step="failed";s.message=e instanceof AppError?e.message:"学校登录暂时不可用，请重试";s.password="";if(s.slot){await browser.releaseContext(s.slot);s.slot=null}}
 finally{clearTimeout(timer);s.busy=false;s.busyPlan=false;s._lastUsed=Date.now()}})();
 return view(s);
}
async function start(body){
 if(typeof body.studentId!=="string"||!/^[A-Za-z0-9_.@-]{3,64}$/.test(body.studentId.trim())||typeof body.password!=="string"||!body.password||body.password.length>200)throw new AppError(400,"INVALID_CREDENTIAL","请填写完整学校账号和密码");
 const s={flowId:randomBytes(32).toString("base64url"),studentId:body.studentId.trim(),password:body.password,accountKey:accountKey(body.studentId.trim()),remember:body.remember===true,step:"connecting",message:"正在向学校验证身份",attempts:0};
 sessions.set(s.flowId,s);
 return run(s,async()=>{Object.assign(s,await browser.acquireContext());await s.page.goto(ENTRY,{waitUntil:"domcontentloaded",timeout:25000});await advance(s)});
}
async function status(id){return view(required(id))}
async function code(body){
 const s=required(body.flowId);
 if(s.step!=="mfa"||typeof body.code!=="string"||!/^\d{4,8}$/.test(body.code.trim()))throw new AppError(400,"INVALID_SCHOOL_CODE","请填写本次HIT APP验证码");
 if(s.attempts>=5)throw new AppError(429,"SCHOOL_CODE_ATTEMPTS","验证次数过多，请重新登录");
 return run(s,async()=>{
  s.attempts++;await appVerification(s,false);await s.page.locator("#dynamicCode:visible").fill(body.code.trim());await s.page.locator("#reAuthSubmitBtn:visible").first().click();await s.page.waitForTimeout(1200);
  if(await s.page.locator("#dynamicCode:visible").count()){s.step="mfa";s.message="学校尚未通过验证码验证，请检查是否为本次HIT APP验证码";return}
  await advance(s);
 });
}
async function captcha(body){
 const s=required(body.flowId);
 if(s.step!=="captcha"||typeof body.captcha!=="string"||!/^[A-Za-z0-9]{4,8}$/.test(body.captcha.trim()))throw new AppError(400,"INVALID_CAPTCHA","请填写学校图片验证码");
 return run(s,()=>advance(s,body.captcha.trim()));
}
async function resend(body){
 const s=required(body.flowId);
 if(s.step!=="mfa")throw new AppError(409,"SCHOOL_SIGNIN_EXPIRED","请先发起学校验证");
 if(s.codeSentAt&&Date.now()-s.codeSentAt<60000)throw new AppError(429,"RATE_LIMITED","请稍后再获取验证码");
 return run(s,()=>appVerification(s,true));
}
async function create(body){const s=required(body.flowId);if(s.step!=="confirm_new")throw new AppError(409,"SCHOOL_SIGNIN_NOT_VERIFIED","请先通过学校身份验证");s.allowCreate=true;return run(s,()=>finish(s))}
async function cancel(id){const s=required(id);if(s.busy)throw new AppError(409,"SCHOOL_SIGNIN_BUSY","学校正在处理本次请求，请稍后取消");await sessions.dispose(id);return {cancelled:true}}
module.exports={start,status,code,captcha,resend,create,cancel,sessions};
