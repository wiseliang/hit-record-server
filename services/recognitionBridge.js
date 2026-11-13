const {createHash,createHmac,randomUUID}=require('crypto');
const {AppError}=require('../utils/errors');
const hash=x=>createHash('sha256').update(x).digest('hex');
function createBridge({env=process.env,fetchImpl=fetch}={}){
 const sessions=new Map(),inflight=new Map();
 function config(){
  if(!env.SCHOOL_BRIDGE_SECRET||Buffer.byteLength(env.SCHOOL_BRIDGE_SECRET)<32)throw new AppError(503,'RECOGNITION_UNCONFIGURED','识人服务尚未连接，请联系维护者');
  const url=new URL(env.STAFF_FINDER_URL||'http://127.0.0.1:3086/');
  if(url.username||url.password||url.search||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw new AppError(503,'RECOGNITION_UNCONFIGURED','识人服务地址配置无效');
  if(!url.pathname.endsWith('/'))url.pathname+='/';return url;
 }
 async function response(r,binary=false){if(!r.ok){const e=await r.json().catch(()=>({}));throw new AppError(r.status,e.code||'RECOGNITION_UPSTREAM',e.error||'识人服务未完成处理');}return binary?{bytes:Buffer.from(await r.arrayBuffer()),mime:r.headers.get('content-type')}:r.json();}
 async function signed(subject,route,body={}){
  const base=config(),path=new URL('internal/v1/school/'+route,base),time=Math.floor(Date.now()/1000),text=JSON.stringify(body);
  // The public reverse proxy strips the configured base path before reaching the service.
  const c={iss:env.SCHOOL_BRIDGE_ISSUER||'student-recorder',aud:'staff-finder',sub:subject,iat:time,exp:time+45,jti:randomUUID(),method:'POST',path:'/internal/v1/school/'+route,bodyHash:hash(text)};
  const payload=Buffer.from(JSON.stringify(c)).toString('base64url'),signature=createHmac('sha256',env.SCHOOL_BRIDGE_SECRET).update(payload).digest('hex');
  const r=await fetchImpl(path,{method:'POST',headers:{'Content-Type':'application/json','X-School-Assertion':payload+'.'+signature},body:text,redirect:'error',signal:AbortSignal.timeout(120000)});
  return {data:await response(r),cookie:r.headers.get('set-cookie')?.match(/^staff_session=[a-f0-9]{64}/)?.[0]};
 }
 async function exchange(subject,bind){
  if(!bind&&sessions.get(subject)?.expires>Date.now())return sessions.get(subject);
  if(!bind&&inflight.has(subject))return inflight.get(subject);
  const work=(async()=>{const r=await signed(subject,'exchange',bind?{bind}:{});if(!r.cookie)throw new AppError(502,'INVALID_BRIDGE_SESSION','识人会话响应无效');const session={...r.data,cookie:r.cookie,expires:Date.now()+7*3600000};sessions.set(subject,session);return session;})();
  if(!bind)inflight.set(subject,work);try{return await work;}finally{inflight.delete(subject);}
 }
 async function api(subject,path,{method='GET',body,binary=false}={}){
  if(!/^\/(?:me|search-scope|search|people\/[a-zA-Z0-9_-]+(?:\/photo|\/photos\/[a-zA-Z0-9_-]+\/image)?)$/.test(path))throw new AppError(400,'INVALID_BRIDGE_PATH','识人接口无效');
  for(let retry=0;retry<2;retry++){
   const s=await exchange(subject),r=await fetchImpl(new URL('api'+path,config()),{method,headers:{Cookie:s.cookie},body,redirect:'error',signal:AbortSignal.timeout(90000)});
   if(r.status===401&&retry===0){sessions.delete(subject);continue;}return response(r,binary);
  }
 }
 return {configured:()=>{try{config();return true}catch{return false}},exchange,signed:async(...args)=>(await signed(...args)).data,api};
}
module.exports={createBridge,hash};
