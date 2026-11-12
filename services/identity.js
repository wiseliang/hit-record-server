const crypto = require("crypto");
const pool = require("../config/database");
const { issueToken } = require("../utils/session");
const { encrypt, decrypt } = require("../utils/crypto");
const { AppError } = require("../utils/errors");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function recoveryKey() {
  return "REC-" + crypto.randomBytes(24).toString("hex").toUpperCase();
}
async function account(openid) {
  const [rows] = await pool.query(
    "SELECT openid FROM app_accounts WHERE openid=?",
    [openid],
  );
  if (rows.length) return null;
  const key = recoveryKey();
  const [inserted] = await pool.query(
    "INSERT IGNORE INTO app_accounts(openid,recovery_hash) VALUES (?,?)",
    [openid, hash(key)],
  );
  return inserted.affectedRows === 1 ? key : null;
}
async function openSession(openid) {
  const recovery = await account(openid),
    refreshToken = crypto.randomBytes(48).toString("base64url"),
    sid = crypto.randomUUID();
  await pool.query(
    "INSERT INTO app_sessions(id,openid,refresh_hash,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 365 DAY))",
    [sid, openid, hash(refreshToken)],
  );
  return {
    openid,
    token: issueToken(openid, { sid, ttl: 900 }),
    refreshToken,
    ...(recovery ? { recoveryKey: recovery } : {}),
  };
}
async function refresh(refreshToken, operationId) {
  if(operationId!==undefined && (typeof operationId!=="string" || !/^[A-Za-z0-9._-]{16,100}$/.test(operationId)))throw new AppError(400,"INVALID_REFRESH_OPERATION","请重新发起登录续期");
  const operationHash=operationId?hash(operationId):null;
  if (typeof refreshToken !== "string" || refreshToken.length < 32)
    throw new AppError(
      401,
      "SESSION_RECOVERY_REQUIRED",
      "请使用学校账号重新验证，原账号记录仍保留",
    );
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT * FROM app_sessions WHERE (refresh_hash=? OR (previous_refresh_hash=? AND (previous_valid_until>UTC_TIMESTAMP() OR (refresh_operation_hash=? AND ? IS NOT NULL)))) AND revoked=0 AND expires_at>UTC_TIMESTAMP() FOR UPDATE",
      [hash(refreshToken), hash(refreshToken), operationHash, operationHash],
    );
    if (!rows.length)
      throw new AppError(
        401,
        "SESSION_RECOVERY_REQUIRED",
        "请使用学校账号重新验证，原账号记录仍保留",
      );
    const row = rows[0],
      isPrevious = row.refresh_hash !== hash(refreshToken),
      rotated = isPrevious
        ? decrypt(row.rotated_refresh)
        : crypto.randomBytes(48).toString("base64url");
    if (!isPrevious)
      await connection.query(
        "UPDATE app_sessions SET previous_refresh_hash=refresh_hash,previous_valid_until=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 60 SECOND),refresh_hash=?,rotated_refresh=?,refresh_operation_hash=?,expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 365 DAY) WHERE id=?",
        [hash(rotated), encrypt(rotated), operationHash, row.id],
      );
    await connection.commit();
    return {
      openid: row.openid,
      token: issueToken(row.openid, { sid: row.id, ttl: 900 }),
      refreshToken: rotated,
    };
  } catch (e) {
    await connection.rollback();
    throw e;
  } finally {
    connection.release();
  }
}
async function recover(key) {
  if (
    typeof key !== "string" ||
    !/^REC-[A-F0-9]{48}$/.test(key.trim().toUpperCase())
  )
    throw new AppError(401, "INVALID_RECOVERY", "恢复码无效，请检查后重试");
  const [rows] = await pool.query(
    "SELECT openid FROM app_accounts WHERE recovery_hash=?",
    [hash(key.trim().toUpperCase())],
  );
  if (!rows.length)
    throw new AppError(401, "INVALID_RECOVERY", "恢复码无效，请检查后重试");
  await pool.query("UPDATE app_sessions SET revoked=1 WHERE openid=?", [
    rows[0].openid,
  ]);
  await pool.query("UPDATE app_accounts SET legacy_blocked=1 WHERE openid=?", [
    rows[0].openid,
  ]);
  return openSession(rows[0].openid);
}
async function rotateRecovery(openid) {
  const key = recoveryKey();
  await pool.query("UPDATE app_accounts SET recovery_hash=? WHERE openid=?", [
    hash(key),
    openid,
  ]);
  return key;
}
async function validSession(sid, openid) {
  const [rows] = await pool.query(
    "SELECT id FROM app_sessions WHERE id=? AND openid=? AND revoked=0 AND expires_at>UTC_TIMESTAMP()",
    [sid, openid],
  );
  return rows.length > 0;
}
async function legacyBlocked(openid) {
  const [rows] = await pool.query(
    "SELECT legacy_blocked FROM app_accounts WHERE openid=?",
    [openid],
  );
  return !!rows[0]?.legacy_blocked;
}
module.exports = {
  legacyBlocked,
  openSession,
  refresh,
  recover,
  rotateRecovery,
  validSession,
  hash,
};
