const pool = require("../config/database"),
  { AppError } = require("../utils/errors");
async function current(openid, connection = pool) {
  const [rows] = await connection.query(
    "SELECT connection_id FROM school_login_sessions WHERE openid=?",
    [openid],
  );
  return rows[0]?.connection_id || null;
}
async function assertCurrent(openid, data, connection = pool) {
  const id = await current(openid, connection);
  if (!id || !data.connectionId || data.connectionId !== id)
    throw new AppError(
      409,
      "SCHOOL_ACCOUNT_CHANGED",
      "学校连接已变化，请重新读取名单及预览",
    );
  return id;
}
module.exports = { current, assertCurrent };
