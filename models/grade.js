const { v4: uuidv4 } = require('uuid')
const pool = require('../config/database')

async function createGradeTask(openid, params) {
  const taskUuid = 'grade_' + uuidv4().slice(0, 8)
  const { year = '2022', school = '信息科学与工程学院', major = '自动化', className = '', extractCourses = true } = params

  await pool.query(
    `INSERT INTO grade_tasks (task_uuid, openid, year, school, major, class_name, extract_courses, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [taskUuid, openid, year, school, major, className, extractCourses ? 1 : 0]
  )
  return taskUuid
}

async function getGradeTask(taskUuid) {
  const [rows] = await pool.query('SELECT * FROM grade_tasks WHERE task_uuid = ?', [taskUuid])
  if (!rows.length) return null

  const t = rows[0]
  // 解析 results JSON
  let results = null
  if (t.results) {
    try { results = typeof t.results === 'string' ? JSON.parse(t.results) : t.results } catch (_) {}
  }

  return {
    taskUuid: t.task_uuid,
    openid: t.openid,
    year: t.year,
    school: t.school,
    major: t.major,
    className: t.class_name,
    extractCourses: t.extract_courses === 1,
    status: t.status,
    studentCount: t.student_count,
    courseProgress: t.course_progress,
    avgGpa: t.avg_gpa,
    totalFailed: t.total_failed,
    currentPhase: t.current_phase,
    results,
    startedAt: t.started_at,
    completedAt: t.completed_at,
    createdAt: t.created_at
  }
}

async function updateStatus(taskUuid, status, phase = null) {
  const fields = [status]
  const sets = ['status = ?']
  if (phase) { sets.push('current_phase = ?'); fields.push(phase) }
  if (status === 'running' || status === 'logging_in' || status === 'navigating' || status === 'querying' || status === 'extracting_courses') {
    if (status === 'logging_in') { sets.push('started_at = NOW()') }
  }
  if (status === 'completed' || status === 'failed') {
    sets.push('completed_at = NOW()')
  }
  fields.push(taskUuid)
  await pool.query(`UPDATE grade_tasks SET ${sets.join(', ')} WHERE task_uuid = ?`, fields)
}

async function saveStudentResults(taskUuid, students, avgGpa, totalFailed) {
  await pool.query(
    `UPDATE grade_tasks SET student_count = ?, avg_gpa = ?, total_failed = ?, results = ?, current_phase = ?, status = ?
     WHERE task_uuid = ?`,
    [students.length, avgGpa, totalFailed, JSON.stringify(students), '学生列表已提取', 'querying', taskUuid]
  )
}

async function updateStudentCourses(taskUuid, studentIndex, courses, progress) {
  // 获取当前 results
  const [rows] = await pool.query('SELECT results FROM grade_tasks WHERE task_uuid = ?', [taskUuid])
  if (!rows.length) return

  let results = []
  if (rows[0].results) {
    try { results = typeof rows[0].results === 'string' ? JSON.parse(rows[0].results) : rows[0].results } catch (_) {}
  }

  // 更新指定学生的课程数据
  if (results[studentIndex]) {
    results[studentIndex].courses = courses
    results[studentIndex].coursesExtracted = true
    results[studentIndex].courseCount = courses.length
  }

  await pool.query(
    `UPDATE grade_tasks SET results = ?, course_progress = ?, current_phase = ?
     WHERE task_uuid = ?`,
    [JSON.stringify(results), progress, `提取课程 ${progress}/${results.length}`, taskUuid]
  )
}

async function markCompleted(taskUuid, students, avgGpa, totalFailed, courseCount) {
  await pool.query(
    `UPDATE grade_tasks SET status = 'completed', completed_at = NOW(), results = ?,
     avg_gpa = ?, total_failed = ?, course_progress = ?, current_phase = '查询完成'
     WHERE task_uuid = ?`,
    [JSON.stringify(students), avgGpa, totalFailed, courseCount, taskUuid]
  )
}

async function markFailed(taskUuid, reason) {
  await pool.query(
    `UPDATE grade_tasks SET status = 'failed', completed_at = NOW(), current_phase = ?
     WHERE task_uuid = ?`,
    [reason?.substring(0, 64) || '未知错误', taskUuid]
  )
}

module.exports = {
  createGradeTask,
  getGradeTask,
  updateStatus,
  saveStudentResults,
  updateStudentCourses,
  markCompleted,
  markFailed
}
