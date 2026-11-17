const {createHash,createHmac,randomUUID}=require('crypto'),{AppError}=require('../utils/errors');
const hash=s=>createHash('sha256').update(s).digest('hex');
function createMemoryBridge({env=process.env,fetchImpl=fetch}={}){
 function key(){if(!env.MEMORY_BRIDGE_SECRET||env.MEMORY_BRIDGE_SECRET.length<32)throw new AppError(503,'MEMORY_UNAVAILABLE','背诵服务尚未连接');return env.MEMORY_BRIDGE_SECRET}
 const subject=a=>createHmac('sha256',env.MEMORY_SUBJECT_SECRET||key()).update('student-recorder:'+a.openid+':'+a.accountKey).digest('hex');
 async function call(a,action,body){if(!['sync','snapshot','events','progress'].includes(action))throw new AppError(400,'INVALID_MEMORY_ACTION','记忆操作无效');const path='/internal/v1/school-memory/'+action,time=Math.floor(Date.now()/1000),text=JSON.stringify(body),claim={iss:'student-recorder',aud:'palm-quiz-memory',sub:subject(a),iat:time,exp:time+45,jti:randomUUID(),method:'POST',path,bodyHash:hash(text)},payload=Buffer.from(JSON.stringify(claim)).toString('base64url'),sig=createHmac('sha256',key()).update(payload).digest('hex');let r;
  try{r=await fetchImpl(new URL(path,env.MEMORY_BRIDGE_URL||'http://127.0.0.1:4526'),{method:'POST',headers:{'Content-Type':'application/json','X-Memory-Assertion':payload+'.'+sig},body:text,redirect:'error',signal:AbortSignal.timeout(30000)})}catch{throw new AppError(503,'MEMORY_UNAVAILABLE','背诵服务暂时不可用，本机已下载资料和待同步记录保留')}
  let value;try{value=await r.json()}catch{throw new AppError(502,'MEMORY_INVALID_RESPONSE','背诵服务响应无效')}
  if(!r.ok)throw new AppError(r.status,r.status===409?'MEMORY_CONFLICT':'MEMORY_UNAVAILABLE',value.error||'背诵服务暂时不可用');return value;
 }
 return {call,subject,configured:()=>{try{key();return true}catch{return false}}};
}
module.exports={createMemoryBridge};
