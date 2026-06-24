const pool = require('../config/database')
const { encrypt, decrypt } = require('../utils/crypto')

async function saveCredential(openid, studentId, password) {
  const encryptedStudentId = encrypt(studentId)
  const encryptedPassword = encrypt(password)

  await pool.query(
    `INSERT INTO credentials (openid, student_id, password)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE student_id = VALUES(student_id), password = VALUES(password)`,
    [openid, encryptedStudentId, encryptedPassword]
  )
}

async function getCredential(openid) {
  const [rows] = await pool.query(
    'SELECT student_id, password FROM credentials WHERE openid = ?',
    [openid]
  )
  if (!rows.length) return null

  return {
    studentId: decrypt(rows[0].student_id),
    password: decrypt(rows[0].password)
  }
}

async function hasCredential(openid) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS cnt FROM credentials WHERE openid = ?',
    [openid]
  )
  return rows[0].cnt > 0
}

module.exports = { saveCredential, getCredential, hasCredential }
