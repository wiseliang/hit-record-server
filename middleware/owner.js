const pool = require('../config/database')
module.exports = function owner(table) {
  if (!['tasks', 'grade_tasks'].includes(table)) throw new Error('Invalid ownership table')
  return async (req, res, next) => {
    try {
      const [rows] = await pool.query(`SELECT task_uuid FROM ${table} WHERE task_uuid = ? AND openid = ?`, [req.params.taskUuid, req.openid])
      if (!rows.length) return res.status(404).json({ error: '任务不存在' })
      next()
    } catch (e) { next(e) }
  }
}
