const pool=require("../config/database"),{AppError}=require("../utils/errors"),{randomBytes}=require("crypto"),identity=require("./identity");
async function existing(accountKey){
 const [rows]=await pool.query("SELECT openid FROM school_account_bindings WHERE account_key=?",[accountKey]);
 return rows[0]?.openid||null;
}
async function resolveVerified(accountKey,{allowCreate=false}={}){
 if(!/^[a-f0-9]{64}$/.test(accountKey))throw new AppError(400,"INVALID_SCHOOL_IDENTITY","学校身份格式不正确");
 const db=await pool.getConnection();const lock="school-id:"+accountKey.slice(0,48);
 try{
  const [acquired]=await db.query("SELECT GET_LOCK(?,3) AS acquired",[lock]);
  if(acquired[0].acquired!==1)throw new AppError(409,"SCHOOL_SIGNIN_BUSY","学校身份正在处理，请稍候重试");
  await db.beginTransaction();
  const [bound]=await db.query("SELECT openid FROM school_account_bindings WHERE account_key=? FOR UPDATE",[accountKey]);
  if(bound[0]){await db.commit();return {openid:bound[0].openid,restored:true}}
  const [legacy]=await db.query("SELECT s.openid FROM school_login_sessions s JOIN app_accounts a ON a.openid=s.openid WHERE s.account_key=?",[accountKey]);
  if(legacy.length>1)throw new AppError(409,"SCHOOL_IDENTITY_REVIEW","该学校账号对应多份历史记录，请联系维护者核对；原记录均保留");
  let owner;
  if(legacy.length===1){
   owner=legacy[0].openid;
   const [other]=await db.query("SELECT account_key FROM school_account_bindings WHERE openid=? FOR UPDATE",[owner]);
   if(other.length)throw new AppError(409,"SCHOOL_IDENTITY_REVIEW","历史账号已关联另一学校身份，请联系维护者核对");
  }else{
   // Never infer account ownership from unverified saved credentials.
   const [credentials]=await db.query("SELECT openid,student_id FROM credentials");
   const {decrypt}=require("../utils/crypto"),{accountKey:makeKey}=require("./academicAccess");
   if(credentials.some(row=>{try{return makeKey(decrypt(row.student_id))===accountKey}catch{return false}}))
    throw new AppError(409,"SCHOOL_IDENTITY_REVIEW","发现尚未建立学校验证绑定的历史账号，请联系维护者核对；不会创建空账号覆盖记录");
   if(!allowCreate){await db.commit();return {requiresCreation:true}}
   owner="android_"+randomBytes(24).toString("hex");
   const backup="REC-"+randomBytes(24).toString("hex").toUpperCase();
   await db.query("INSERT INTO app_accounts(openid,recovery_hash) VALUES (?,?)",[owner,identity.hash(backup)]);
  }
  await db.query("INSERT INTO school_account_bindings(account_key,openid,source) VALUES (?,?,?)",[accountKey,owner,"fresh_school_signin"]);
  await db.commit();return {openid:owner,restored:legacy.length===1};
 }catch(e){await db.rollback();throw e}
 finally{await db.query("SELECT RELEASE_LOCK(?)",[lock]).catch(()=>{});db.release()}
}
async function bindVerifiedOwner(openid,accountKey){
 const db=await pool.getConnection();
 try{
  await db.beginTransaction();
  const [same]=await db.query("SELECT openid FROM school_account_bindings WHERE account_key=? FOR UPDATE",[accountKey]);
  if(same[0]&&same[0].openid!==openid)throw new AppError(409,"SCHOOL_ACCOUNT_ALREADY_BOUND","该学校账号已有原记录，请从学校账号登录入口找回");
  const [owner]=await db.query("SELECT account_key FROM school_account_bindings WHERE openid=?",[openid]);
  if(owner[0]&&owner[0].account_key!==accountKey)throw new AppError(409,"SCHOOL_IDENTITY_REVIEW","当前应用账号已关联另一学校身份，请使用学校账号登录切换");
  if(!same.length)await db.query("INSERT INTO school_account_bindings(account_key,openid,source) VALUES (?,?,?)",[accountKey,openid,"verified_school_connection"]);
  await db.commit();
 }catch(e){await db.rollback();throw e}finally{db.release()}
}
module.exports={existing,resolveVerified,bindVerifiedOwner};
