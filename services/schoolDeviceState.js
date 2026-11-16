// Long-lived official browser state is only available to an already verified App owner.
// It is never loaded into the anonymous school-signin flow.
const officialDomain=domain=>['ids.hit.edu.cn','hit.edu.cn'].includes(String(domain||'').replace(/^\./,''));
function retainedState(state,now=Date.now(),days=90){
 const deadline=now+days*86400000;
 const cookies=(state?.cookies||[]).filter(c=>officialDomain(c.domain)&&Number.isFinite(c.expires)&&c.expires*1000>now).map(c=>({...c,expires:Math.min(c.expires,deadline/1000)}));
 const origins=(state?.origins||[]).filter(o=>o.origin==='https://ids.hit.edu.cn'&&Array.isArray(o.localStorage)&&o.localStorage.length).map(o=>({origin:o.origin,localStorage:o.localStorage}));
 if(!cookies.length&&!origins.length)return null;
 return {state:{cookies,origins},expiresAt:new Date(origins.length?deadline:Math.min(deadline,Math.max(...cookies.map(c=>c.expires*1000))))};
}
function mergeDeviceState(device,session){
 if(!device)return session;if(!session)return device;
 const cookies=new Map();for(const c of [...device.cookies,...session.cookies]){if(c.expires===-1||!c.expires||c.expires*1000>Date.now())cookies.set(c.domain+'|'+c.path+'|'+c.name,c)}
 const origins=new Map();for(const o of [...device.origins,...session.origins]){const previous=origins.get(o.origin)||new Map();for(const v of o.localStorage||[])previous.set(v.name,v);origins.set(o.origin,previous)}
 return {cookies:[...cookies.values()],origins:[...origins].map(([origin,values])=>({origin,localStorage:[...values.values()]}))};
}
function createDeviceStore({pool,encrypt,decrypt,now=Date.now,days=90}){
 async function allowed(openid,key){const [rows]=await pool.query('SELECT openid FROM school_account_bindings WHERE account_key=? AND openid=?',[key,openid]);return rows.length===1}
 return {
  async capture(openid,key,state,{trustSelected=false,trustSelectedAt=null}={}){
   const retained=retainedState(state,now(),days);if(!retained)return false;
   if(!await allowed(openid,key))return false;
   await pool.query(`INSERT INTO school_device_states(openid,account_key,state_encrypted,expires_at,validated_at,trust_selected_at) VALUES(?,?,?,?,UTC_TIMESTAMP(),?) ON DUPLICATE KEY UPDATE state_encrypted=VALUES(state_encrypted),expires_at=VALUES(expires_at),validated_at=VALUES(validated_at),trust_selected_at=COALESCE(VALUES(trust_selected_at),trust_selected_at)`,[openid,key,encrypt(JSON.stringify(retained.state)),retained.expiresAt,trustSelectedAt?new Date(trustSelectedAt):(trustSelected?new Date(now()):null)]);return true;
  },
  async load(openid,key){
   if(!await allowed(openid,key))return null;
   const [rows]=await pool.query('SELECT state_encrypted FROM school_device_states WHERE openid=? AND account_key=? AND expires_at>UTC_TIMESTAMP()',[openid,key]);
   if(!rows[0])return null;
   try{return retainedState(JSON.parse(decrypt(rows[0].state_encrypted)),now(),days)?.state||null}catch{return null}
  },
  async status(openid,key){if(!await allowed(openid,key))return {saved:false};const [rows]=await pool.query('SELECT expires_at,validated_at,trust_selected_at FROM school_device_states WHERE openid=? AND account_key=? AND expires_at>UTC_TIMESTAMP()',[openid,key]);return rows[0]?{saved:true,expiresAt:rows[0].expires_at,validatedAt:rows[0].validated_at,trustSelectedAt:rows[0].trust_selected_at}:{saved:false}},
  async forget(openid){await pool.query('DELETE FROM school_device_states WHERE openid=?',[openid])}
 }
}
let instance;function store(){if(!instance){const value=Number(process.env.SCHOOL_DEVICE_RETENTION_DAYS||90);instance=createDeviceStore({pool:require('../config/database'),...require('../utils/crypto'),days:Number.isInteger(value)&&value>=1&&value<=180?value:90})}return instance}
module.exports={mergeDeviceState,retainedState,createDeviceStore,store};
