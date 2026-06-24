const pool = require('../config/database')

const TYPE_INFO = {
  companion: '录入陪伴',
  talk: '录入谈话'
}

async function getHistory(openid, page = 1, pageSize = 20) {
  const offset = (page - 1) * pageSize

  const [countRows] = await pool.query(
    'SELECT COUNT(*) AS total FROM tasks WHERE openid = ?',
    [openid]
  )
  const total = countRows[0].total

  const [rows] = await pool.query(
    `SELECT task_uuid, type, week, status, total, success_count, skipped_count,
            error_count, created_at
     FROM tasks WHERE openid = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [openid, pageSize, offset]
  )

  return {
    items: rows.map(t => ({
      taskUuid: t.task_uuid,
      week: t.week,
      type: t.type,
      typeName: TYPE_INFO[t.type] || t.type,
      status: t.status,
      total: t.total,
      success: t.success_count,
      skipped: t.skipped_count,
      error: t.error_count,
      createdAt: t.created_at
    })),
    total,
    page,
    pageSize
  }
}

module.exports = { getHistory }
