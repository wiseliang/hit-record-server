const { v4: uuidv4 } = require('uuid')
const pool = require('../config/database')

async function createTask(openid, type, week, options) {
  const taskUuid = uuidv4()
  await pool.query(
    `INSERT INTO tasks (task_uuid, openid, type, week, options, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
    [taskUuid, openid, type, week, options ? JSON.stringify(options) : null]
  )
  return taskUuid
}

async function getTask(taskUuid) {
  const [rows] = await pool.query('SELECT * FROM tasks WHERE task_uuid = ?', [taskUuid])
  if (!rows.length) return null
  const t = rows[0]

  // Parse errors field - new format: {details, errorList}, old format: [...]
  let errors = []
  let details = []
  if (t.errors) {
    if (Array.isArray(t.errors)) {
      errors = t.errors
    } else if (t.errors.errorList) {
      errors = t.errors.errorList
      details = t.errors.details || []
    }
  }

  let options = t.options || {}
  if (typeof options === 'string') { try { options = JSON.parse(options) } catch (_) { options = {} } }
  return {
    calendar: options.calendar || null,
    taskUuid: t.task_uuid, type: t.type, week: t.week, status: t.status,
    total: t.total,
    progress: { processed: t.processed, success: t.success_count, skipped: t.skipped_count, error: t.error_count },
    currentStudent: t.current_student, errors, details,
    paused: !!t.paused, startedAt: t.started_at, completedAt: t.completed_at, createdAt: t.created_at
  }
}

module.exports = { createTask, getTask }
