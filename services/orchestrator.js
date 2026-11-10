const logger = require('../utils/logger')
const pool = require('../config/database')
const browser = require('./browser')
const { startLogin, submitCode, navigateToWorkLog, pendingLogins } = require('./login')
const { navigateAndQuery, extractStudentNames } = require('./navigator')
const { recordCompanion } = require('./companion')
const { recordTalk } = require('./talk')
const { decrypt } = require('../utils/crypto')
const { getCredential } = require('../models/credential')
const { getCurrentWeek, getWeekType, getWeekStart, withSemester, getSemesterSnapshot } = require('../utils/week')

const waitingTasks = new Map()

function selectStudentIndices(students, opts, week) {
  if (Array.isArray(opts.studentIds)) {
    const selected = new Set(opts.studentIds)
    const found = students.filter(s=>selected.has(s.studentId))
    if (found.length !== selected.size) throw new Error(`所选学生不在第${week}周名单中，请重新选择`)
    return found.map(s=>s.index)
  }
  if (Array.isArray(opts.studentIndices)) return opts.studentIndices.filter(i=>Number.isInteger(i)&&i>=0&&i<students.length)
  return students.map(s=>s.index)
}

/** 检查暂停标记，若暂停则轮询等待恢复；若放弃则抛异常 */
async function checkPause(db, taskUuid) {
  while (true) {
    const [rows] = await db.query('SELECT paused, status FROM tasks WHERE task_uuid = ?', [taskUuid])
    if (!rows.length) throw new Error('TASK_ABORTED')
    const { paused, status } = rows[0]
    if (status === 'failed') throw new Error('TASK_ABORTED')
    if (!paused) return
    // 暂停中，每秒轮询
    await new Promise(r => setTimeout(r, 1000))
  }
}

async function executeTask(taskUuid) {
  const [rows] = await pool.query('SELECT options FROM tasks WHERE task_uuid = ?', [taskUuid])
  if (!rows.length) return
  let options = rows[0].options || {}
  if (typeof options === 'string') options = JSON.parse(options)
  return withSemester(options.calendar || getSemesterSnapshot(), () => executeTaskWithinSemester(taskUuid))
}

async function executeTaskWithinSemester(taskUuid) {
  const db = await pool.getConnection()
  let task, credRows, studentId, password
  try {
    const [rows] = await db.query('SELECT * FROM tasks WHERE task_uuid = ?', [taskUuid])
    if (!rows.length) { logger.error(`Task ${taskUuid} not found`); return }
    task = rows[0]

    const [cr] = await db.query('SELECT * FROM credentials WHERE openid = ?', [task.openid])
    const hasPendingSession = pendingLogins.has(task.openid)
    if (!cr.length && !hasPendingSession) { await failTask(db, taskUuid, '未配置凭证且无活跃登录会话'); return }
    credRows = cr

    studentId = credRows.length ? decrypt(credRows[0].student_id) : ''
    password = credRows.length ? decrypt(credRows[0].password) : ''

    // 解析录制选项
    let opts = {}
    try { opts = task.options ? JSON.parse(typeof task.options === 'string' ? task.options : JSON.stringify(task.options)) : {} } catch (_) {}

    await db.query("UPDATE tasks SET status = 'running', started_at = NOW() WHERE task_uuid = ?", [taskUuid])

    // 检查是否有暂挂的登录页
    const pending = pendingLogins.get(task.openid)
    let page, slot
    if (pending && pending.page) {
      page = pending.page
      slot = pending.slot
      pendingLogins.delete(task.openid)
      logger.info('Reusing pending login page')
    } else {
      const ctx = await browser.acquireContext()
      page = ctx.page
      slot = ctx.slot
      try {
      const loginResult = await startLogin(page, studentId, password)

      if (loginResult.needsCaptcha) {
        // 图片验证码 — 循环等待直到正确或需要 MFA
        logger.info('Task needs captcha, waiting for user input...')
        const { submitCaptcha } = require('./login')

        let captchaAttempts = 0
        let captchaResult = loginResult
        while (captchaResult && (captchaResult.needsCaptcha || captchaResult.retry) && captchaAttempts < 3) {
          captchaAttempts++
          await db.query(
            "UPDATE tasks SET status = 'awaiting_code', current_student = ? WHERE task_uuid = ?",
            [captchaResult.retry ? '验证码错误，请重试' : '需要图片验证码', taskUuid]
          )
          // 暂存 captcha 图片
          waitingTasks.set(taskUuid, {
            page, slot,
            captchaImage: captchaResult.captchaImage,
            resolve: null, reject: null,
            _isCaptcha: true
          })
          // 等待用户提交
          const captchaText = await new Promise((resolve, reject) => {
            const waiter = waitingTasks.get(taskUuid)
            waiter.resolve = resolve
            waiter.reject = reject
          })
          captchaResult = await submitCaptcha(page, captchaText, studentId, password)
          logger.info(`Captcha result: retry=${captchaResult.retry}, needsCode=${captchaResult.needsCode}`)
        }

        if (captchaResult && captchaResult.needsCode) {
          // captcha 正确但还需要 MFA
          await db.query("UPDATE tasks SET status = 'awaiting_code' WHERE task_uuid = ?", [taskUuid])
          const code = await new Promise((resolve, reject) => {
            waitingTasks.set(taskUuid, { page, slot, resolve, reject })
          })
          await submitCode(page, code)
          waitingTasks.delete(taskUuid)
        }
        await db.query("UPDATE tasks SET status = 'running' WHERE task_uuid = ?", [taskUuid])
      } else if (loginResult.needsCode) {
        // MFA 验证码（5 分钟超时）
        logger.info('Task needs MFA code, waiting for user input...')
        await db.query("UPDATE tasks SET status = 'awaiting_code' WHERE task_uuid = ?", [taskUuid])
        const code = await new Promise((resolve, reject) => {
          waitingTasks.set(taskUuid, { page, slot, resolve, reject })
          // 5 分钟超时，防止浏览器 session 过期
          setTimeout(() => {
            if (waitingTasks.has(taskUuid)) {
              waitingTasks.delete(taskUuid)
              reject(new Error('验证码等待超时（5分钟），请重新发起录入'))
            }
          }, 300000)
        })
        await submitCode(page, code)
        waitingTasks.delete(taskUuid)
        await db.query("UPDATE tasks SET status = 'running' WHERE task_uuid = ?", [taskUuid])
      }
    } catch (loginError) {
      logger.error(`Login phase failed: ${loginError.message}`)
      if (slot) { try { await browser.releaseContext(slot) } catch (_) {} }
      throw loginError
    }
    }

    try {
      const workPage = await navigateToWorkLog(page)
      await browser.keepOnly(slot, workPage)

      // 解析录制周次
      let weeks = [task.week]
      if (opts.weeks && Array.isArray(opts.weeks) && opts.weeks.length > 0) {
        weeks = opts.weeks
      } else if (task.week) {
        weeks = [task.week]
      }

      if (task.type === 'fill-missing') {
        await executeFillMissing(workPage, task, opts, db, taskUuid)
      } else if (task.type === 'batch') {
        await executeBatch(workPage, task, opts, db, taskUuid)
      } else {
        // 按周次依次录入
        for (const w of weeks) {
          await executeSingle(workPage, task, w, opts, db, taskUuid)
        }
        // 所有周次完成后统一标记
        await db.query(
          `UPDATE tasks SET status='completed', completed_at=NOW() WHERE task_uuid=?`,
          [taskUuid]
        )
      }
    } finally {
      if (slot) {
        try { await browser.releaseContext(slot) } catch (_) {}
      }
    }

  } catch (e) {
    if (e.message === 'TASK_ABORTED') {
      logger.info(`Task ${taskUuid} aborted by user, status already set`)
    } else {
      logger.error(`Task ${taskUuid} failed: ${e.message}`)
      await failTask(db, taskUuid, e.message)
    }
  } finally {
    db.release()
    waitingTasks.delete(taskUuid)
    // 清理 pendingLogins 中的过期会话，防止下次绕过登录
    if (task?.openid) {
      pendingLogins.delete(task.openid)
    }
  }
}

/** 单周单个类型录入 */
async function executeSingle(page, task, week, opts, db, taskUuid) {
  const pageTotal = await navigateAndQuery(page, week)

  // 提取学生姓名（用于结果显示）
  const studentNames = await extractStudentNames(page)
  const nameByIndex = {}
  studentNames.forEach(s => { nameByIndex[s.index] = s.name })

  // 确定要处理的学生索引（先确定，再更新 total 为实际处理数）
  const indices = selectStudentIndices(studentNames, opts, week)

  const actualTotal = indices.length
  await db.query('UPDATE tasks SET total = COALESCE(total,0) + ? WHERE task_uuid = ?',
    [actualTotal, taskUuid])
  logger.info(`Week ${week}: ${actualTotal}/${pageTotal} students`)

  const [previous] = await db.query('SELECT success_count, skipped_count, errors FROM tasks WHERE task_uuid = ?', [taskUuid])
  const prior = previous[0] || {}
  let saved = prior.errors || {}
  if (typeof saved === 'string') { try { saved = JSON.parse(saved) } catch (_) { saved = {} } }
  let success = Number(prior.success_count) || 0, skipped = Number(prior.skipped_count) || 0
  const weekBefore = { success, skipped }
  const errors = Array.isArray(saved) ? [...saved] : [...(saved.errorList || [])]
  const details = Array.isArray(saved) ? [] : [...(saved.details || [])]

  for (const i of indices) {
    await checkPause(db, taskUuid)

    const recordFn = task.type === 'companion' ? recordCompanion : recordTalk
    const result = await recordFn(page, i, week, opts)

    if (result.result === 'success') success++
    else if (result.result === 'skipped') skipped++
    else errors.push({ seq: i + 1, reason: result.reason || '未知错误' })

    details.push({ week, seq: i + 1, name: nameByIndex[i] || `学生${i + 1}`, result: result.result, reason: result.reason || '' })

    const processed = success + skipped + errors.length
    await updateProgress(db, taskUuid, processed, success, skipped, errors)

    // 每处理一个学生，额外更新一次 current_student 以便前端及时显示
    await db.query('UPDATE tasks SET current_student = ? WHERE task_uuid = ?',
      [`第${week}周 ${i+1}/${actualTotal}`, taskUuid])
  }

  // Store per-student details alongside errors
  await db.query('UPDATE tasks SET errors = ? WHERE task_uuid = ?',
    [JSON.stringify({ details, errorList: errors }), taskUuid])

  // 写入周汇总
  if (task.openid && task.type !== 'batch') {
    await db.query(
      `INSERT INTO weekly_summary (openid, semester_start_date, week, type, total, success, skipped, task_uuid)
       VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE total=VALUES(total), success=VALUES(success), skipped=VALUES(skipped)`,
      [task.openid, getWeekStart(), week, task.type, actualTotal, success - weekBefore.success, skipped - weekBefore.skipped, taskUuid]
    )
  }
}

/** 补录缺失：扫描所有周次，对差次的学生强制录入陪伴上课 */
async function executeFillMissing(page, task, opts, db, taskUuid) {
  const { getCompletionStatus } = require('./navigator')
  const currentWeek = getCurrentWeek()

  let totalSuccess = 0, totalSkipped = 0
  const allErrors = []
  const allDetails = []
  let grandTotal = 0

  for (const w of (opts.weeks?.length ? opts.weeks : Array.from({length:currentWeek},(_,i)=>i+1))) {
    const weekType = getWeekType(w) // 'companion' for odd, 'talk' for even
    const isCompanion = weekType === 'companion'

    // 检查 session 是否过期，过期则重新登录
    const pageBody = await page.evaluate(() => (document.body?.innerText || '').substring(0, 100)).catch(() => '')
    if (pageBody.includes('统一身份认证') || pageBody.includes('账号登录')) {
      logger.info('Fill-missing: session expired, re-logging in...')
      const [cr] = await db.query('SELECT * FROM credentials WHERE openid = ?', [task.openid])
      if (cr.length) {
        const sid = decrypt(cr[0].student_id)
        const pwd = decrypt(cr[0].password)
        const loginResult = await startLogin(page, sid, pwd)
        if (!loginResult.loginFailed) {
          const workPage = await navigateToWorkLog(page)
          page = workPage
        }
      }
    }

    logger.info(`Fill-missing: scanning week ${w} (${weekType})`)
    const students = await getCompletionStatus(page, w)
    const incomplete = students.filter(s => s.needCount > 0 && (!opts.studentIds || opts.studentIds.includes(s.studentId)) && (!opts.studentIndices || opts.studentIndices.includes(s.index)))

    if (incomplete.length === 0) {
      logger.info(`Week ${w}: all complete`)
      continue
    }

    const weekTotal = incomplete.reduce((s, st) => s + st.needCount, 0)
    grandTotal += weekTotal
    await db.query('UPDATE tasks SET total = COALESCE(total,0) + ?, current_student = ? WHERE task_uuid = ?',
      [weekTotal, `第${w}周 需补${weekTotal}次`, taskUuid])
    logger.info(`Week ${w}: ${incomplete.length} students need ${weekTotal} recordings`)

    const weekOpts = isCompanion
      ? { ...opts, pbType: '共同上课', content: '查课', force: true }
      : { ...opts, scene: '走访寝室', content: '查寝', force: true }
    const recordFn = isCompanion ? recordCompanion : recordTalk

    for (const student of incomplete) {
      for (let n = 0; n < student.needCount; n++) {
        // 暂停检查
        const pauseSignal = await checkPause(db, taskUuid)
        if (pauseSignal === 'abort') {
          logger.info(`Task ${taskUuid} aborted during pause (fill-missing)`)
          return
        }

        const result = await recordFn(page, student.index, w, weekOpts)
        if (result.result === 'success') totalSuccess++
        else if (result.result === 'skipped') totalSkipped++
        else allErrors.push({ week: w, student: student.name, reason: result.reason || '未知错误' })

        allDetails.push({ week: w, name: student.name, result: result.result, reason: result.reason || '' })

        await db.query(
          `UPDATE tasks SET success_count = success_count + ?, skipped_count = skipped_count + ?,
           error_count = ?, processed = processed + 1, current_student = ?, errors = ? WHERE task_uuid = ?`,
          [result.result === 'success' ? 1 : 0, result.result === 'skipped' ? 1 : 0,
           allErrors.length, `第${w}周 ${student.name} ${n+1}/${student.needCount}`,
           JSON.stringify(allErrors), taskUuid]
        )
      }
    }
  }

  // Store per-student details alongside errors
  await db.query('UPDATE tasks SET errors = ? WHERE task_uuid = ?',
    [JSON.stringify({ details: allDetails, errorList: allErrors }), taskUuid])

  await db.query(
    `UPDATE tasks SET status='completed', completed_at=NOW() WHERE task_uuid=?`,
    [taskUuid]
  )
  logger.info(`Fill-missing done: ${totalSuccess} success, ${totalSkipped} skipped, ${allErrors.length} errors`)
}

/** 一键录入：从第1周到当前周，扫描缺漏后只补缺失 */
async function executeBatch(page, task, opts, db, taskUuid) {
  const { getCompletionStatus } = require('./navigator')
  const currentWeek = getCurrentWeek()
  let totalSuccess = 0, totalSkipped = 0
  const allErrors = []
  const allDetails = []

  for (const w of (opts.weeks?.length ? opts.weeks : Array.from({length:currentWeek},(_,i)=>i+1))) {
    const weekType = getWeekType(w)
    const isCompanion = weekType === 'companion'

    // 检查 session 是否过期
    const pageBody = await page.evaluate(() => (document.body?.innerText || '').substring(0, 100)).catch(() => '')
    if (pageBody.includes('统一身份认证') || pageBody.includes('账号登录')) {
      logger.info('Batch: session expired, re-logging in...')
      const [cr] = await db.query('SELECT * FROM credentials WHERE openid = ?', [task.openid])
      if (cr.length) {
        const sid = decrypt(cr[0].student_id)
        const pwd = decrypt(cr[0].password)
        const loginResult = await startLogin(page, sid, pwd)
        if (!loginResult.loginFailed) {
          const workPage = await navigateToWorkLog(page)
          page = workPage
        }
      }
    }

    logger.info(`Batch: scanning week ${w} (${weekType})`)
    const students = await getCompletionStatus(page, w)
    const incomplete = students.filter(s => s.needCount > 0 && (!opts.studentIds || opts.studentIds.includes(s.studentId)) && (!opts.studentIndices || opts.studentIndices.includes(s.index)))

    if (incomplete.length === 0) {
      logger.info(`Week ${w}: all complete`)
      continue
    }

    const weekTotal = incomplete.reduce((s, st) => s + st.needCount, 0)
    await db.query('UPDATE tasks SET total = COALESCE(total,0) + ?, current_student = ? WHERE task_uuid = ?',
      [weekTotal, `第${w}周 需补${weekTotal}次`, taskUuid])
    logger.info(`Week ${w}: ${incomplete.length} students need ${weekTotal} recordings`)

    const weekOpts = isCompanion
      ? { ...opts, pbType: opts.pbType || '共同上课', content: opts.content || '查课', force: true }
      : { ...opts, scene: opts.scene || '走访寝室', content: opts.content || '查寝', force: true }
    const recordFn = isCompanion ? recordCompanion : recordTalk

    for (const student of incomplete) {
      for (let n = 0; n < student.needCount; n++) {
        // 暂停检查
        const pauseSignal = await checkPause(db, taskUuid)
        if (pauseSignal === 'abort') {
          logger.info(`Task ${taskUuid} aborted during pause (batch)`)
          return
        }

        const result = await recordFn(page, student.index, w, weekOpts)
        if (result.result === 'success') totalSuccess++
        else if (result.result === 'skipped') totalSkipped++
        else allErrors.push({ week: w, student: student.name, reason: result.reason || '未知错误' })

        allDetails.push({ week: w, name: student.name, result: result.result, reason: result.reason || '' })

        await db.query(
          `UPDATE tasks SET success_count = success_count + ?, skipped_count = skipped_count + ?,
           error_count = ?, processed = processed + 1, current_student = ?, errors = ? WHERE task_uuid = ?`,
          [result.result === 'success' ? 1 : 0, result.result === 'skipped' ? 1 : 0,
           allErrors.length, `第${w}周 ${student.name} ${n+1}/${student.needCount}`,
           JSON.stringify(allErrors), taskUuid]
        )
      }
    }
  }

  // Store per-student details alongside errors
  await db.query('UPDATE tasks SET errors = ? WHERE task_uuid = ?',
    [JSON.stringify({ details: allDetails, errorList: allErrors }), taskUuid])

  await db.query(`UPDATE tasks SET status='completed', completed_at=NOW() WHERE task_uuid=?`, [taskUuid])
  logger.info(`Batch done: ${totalSuccess} success, ${totalSkipped} skipped, ${allErrors.length} errors`)
}

async function updateProgress(db, taskUuid, processed, success, skipped, errors) {
  await db.query(
    `UPDATE tasks SET processed=?, success_count=?, skipped_count=?, error_count=?, current_student=?, errors=? WHERE task_uuid=?`,
    [processed, success, skipped, errors.length, String(processed), JSON.stringify(errors), taskUuid]
  )
}

async function finishTask(db, taskUuid, success, skipped, errors, task) {
  await db.query(
    `UPDATE tasks SET status='completed', completed_at=NOW(), success_count=?, skipped_count=?, error_count=?, errors=? WHERE task_uuid=?`,
    [success, skipped, errors.length, JSON.stringify(errors), taskUuid]
  )
  if (task.type !== 'batch') {
    await db.query(
      `INSERT INTO weekly_summary (openid, semester_start_date, week, type, total, success, skipped, task_uuid)
       VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE total=VALUES(total), success=VALUES(success), skipped=VALUES(skipped)`,
      [task.openid, getWeekStart(), task.week, task.type, success + skipped + errors.length, success, skipped, taskUuid]
    )
  }
}

async function submitTaskCode(taskUuid, code) {
  const waiter = waitingTasks.get(taskUuid)
  if (!waiter) throw new Error('任务未在等待验证码')
  if (waiter._isCaptcha) {
    // 图片验证码
    if (!waiter.resolve) throw new Error('验证码处理器未就绪')
    waiter.resolve(code)
  } else {
    // MFA 验证码
    waiter.resolve(code)
  }
}

async function failTask(db, taskUuid, reason) {
  try { await db.query("UPDATE tasks SET status='failed', errors=? WHERE task_uuid=?", [JSON.stringify([{reason}]), taskUuid]) } catch (_) {}
}

module.exports = { executeTask, submitTaskCode, waitingTasks, selectStudentIndices }
