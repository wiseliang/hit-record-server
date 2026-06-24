/**
 * 成绩查询任务编排器
 */

const logger = require('../utils/logger')
const pool = require('../config/database')
const browser = require('./browser')
const {
  navigateToVpnLogin,
  performSsoLogin,
  submitMfaCode,
  enterNewAcademicPlatform,
  handlePlatformLogin,
  navigateToGradeQuery,
  fillAndQuery,
  extractStudentList,
  extractStudentCourses,
  waitingLogins,
  diagnosePage
} = require('./gradeQuery')
const { getCredential } = require('../models/credential')
const {
  getGradeTask,
  updateStatus,
  saveStudentResults,
  updateStudentCourses,
  markCompleted,
  markFailed
} = require('../models/grade')
const { decrypt } = require('../utils/crypto')

const sleep = ms => new Promise(r => setTimeout(r, ms))

// 存储每个任务的当前页面，供诊断 API 使用
const gradePages = new Map() // taskUuid -> { page, currentStep }

async function executeGradeQuery(taskUuid) {
  const db = await pool.getConnection()
  let slot = null
  let page = null

  try {
    const task = await getGradeTask(taskUuid)
    if (!task) { logger.error(`Grade task ${taskUuid} not found`); return }

    const [cr] = await db.query('SELECT * FROM credentials WHERE openid = ?', [task.openid])
    if (!cr.length) {
      await markFailed(taskUuid, '未配置凭证')
      return
    }

    const studentId = decrypt(cr[0].student_id)
    const password = decrypt(cr[0].password)

    await updateStatus(taskUuid, 'logging_in', '正在登录...')

    // 检查是否有完整预登录的页面（前端 login-start 完成后的）
    const { gradeLoginSessions } = require('./gradeQuery')
    const preLogin = gradeLoginSessions.get(task.openid)
    if (preLogin && preLogin.step === 'done' && preLogin.page) {
      logger.info('[GradeOrchestrator] Reusing pre-logged-in page from gradeLoginSessions')
      slot = preLogin.slot
      page = preLogin.page
      gradeLoginSessions.delete(task.openid)
      gradePages.set(taskUuid, { page, step: '已登录教务平台，准备查询...' })
      // 跳过全部登录步骤，直接进入查询
    } else if (preLogin && preLogin.page) {
      // 登录未完成（比如还在 portal），尝试继续
      logger.info('[GradeOrchestrator] Pre-login page exists but step=' + preLogin.step + ', trying to continue...')
      slot = preLogin.slot
      page = preLogin.page
      // 继续下面的流程，从当前步骤开始
    }

    // 检查是否有二维码扫码登录完成的页面（复用，跳过登录流程）
    const qrSession = waitingLogins.get(task.openid)
    if (!page && qrSession && qrSession.page) {
      logger.info('[GradeOrchestrator] Reusing QR-scanned page from waitingLogins')
      slot = qrSession.slot
      page = qrSession.page
      waitingLogins.delete(task.openid)
      gradePages.set(taskUuid, { page, step: '二维码已登录，进入教务平台...' })
    }

    if (!page) {
      logger.info(`[GradeOrchestrator] Acquiring browser context for ${taskUuid}`)
      const ctx = await browser.acquireContext()
      slot = ctx.slot
      page = ctx.page

      // Step 1: ivpn → SSO
      gradePages.set(taskUuid, { page, step: '正在打开 VPN 登录页...' })
      await updateStatus(taskUuid, 'logging_in', '正在打开 VPN 登录页...')
      page = await navigateToVpnLogin(slot.context)
      gradePages.set(taskUuid, { page, step: 'VPN 页面已打开，准备 SSO 登录' })

      // Step 2: SSO 登录
      gradePages.set(taskUuid, { page, step: '正在进行统一身份认证...' })
      await updateStatus(taskUuid, 'logging_in', '正在进行统一身份认证...')
      const loginResult = await performSsoLogin(page, studentId, password)

      if (loginResult.loginFailed) {
        logger.error('[GradeOrchestrator] SSO login failed: ' + loginResult.message)
        await markFailed(taskUuid, 'SSO登录失败：' + (loginResult.message || '认证未通过'))
        return
      }

      if (loginResult.needsCaptcha) {
        await db.query(
          `UPDATE grade_tasks SET status = 'awaiting_code', current_phase = '需要图片验证码'
           WHERE task_uuid = ?`, [taskUuid]
        )
        const captchaResult = await new Promise((resolve, reject) => {
          waitingLogins.set(taskUuid, { page, slot, resolve, reject, captchaImage: loginResult.captchaImage })
        })
        if (!captchaResult) {
          await markFailed(taskUuid, '验证码输入取消')
          return
        }
        const retryResult = await performSsoLogin(page, studentId, password)
        if (retryResult.needsCode) {
          await handleMfaWait(taskUuid, page, slot, db)
        }
      } else if (loginResult.needsCode) {
        await handleMfaWait(taskUuid, page, slot, db)
      }
    } // end if (!page)

    // CAS 验证后可能停在 XML 页面，需手动导航到 portal
    const bodyStart = await page.evaluate(() => (document.body?.innerText || '').substring(0, 100)).catch(() => '')
    if (bodyStart.includes('This XML file') || bodyStart.includes('<Auth>')) {
      logger.info('CAS returned XML, navigating to ivpn portal...')
      await page.goto('https://ivpn.hitwh.edu.cn/portal/', { waitUntil: 'domcontentloaded', timeout: 15000 })
      await sleep(3000)
      logger.info('Portal URL: ' + page.url().substring(0, 100))
    }

    // Step 3: ivpn 门户 → 新教务平台（可能打开新标签页）
    gradePages.set(taskUuid, { page, step: '正在进入新教务平台...' })
    await updateStatus(taskUuid, 'navigating', '正在进入新教务平台...')
    const platformResult = await enterNewAcademicPlatform(page)
    // 使用返回的新页面（如果点击打开了新标签页）
    if (platformResult && platformResult.newPage) {
      page = platformResult.newPage
      logger.info('Switched to new platform tab: ' + page.url().substring(0, 100))
    }

    // Step 4: 新教务平台登录（可能切换页面）
    gradePages.set(taskUuid, { page, step: '新教务平台登录中...' })
    await updateStatus(taskUuid, 'navigating', '正在进入新教务平台...')
    const loginResult = await handlePlatformLogin(page, studentId, password)
    if (loginResult && loginResult.newPage) page = loginResult.newPage

    // Step 4b: 教务系统需要独立扫码（ivpn 登录态不跨服务）
    if (loginResult && loginResult.needsQrScan && loginResult.qrcode) {
      logger.info('[GradeOrchestrator] Academic platform needs QR scan')
      await db.query(
        `UPDATE grade_tasks SET status = 'awaiting_code', current_phase = '教务系统需要扫码登录',
         verify_code = ? WHERE task_uuid = ?`,
        [loginResult.qrcode, taskUuid]
      )
      gradePages.set(taskUuid, { page, step: '等待扫码登录教务系统...' })

      const { waitForQrLogin } = require('./login')
      const scanResult = await waitForQrLogin(page, 120000)
      if (!scanResult.success) {
        await markFailed(taskUuid, '教务系统扫码登录超时')
        return
      }
      logger.info('[GradeOrchestrator] Academic QR scan successful')
      await db.query(
        `UPDATE grade_tasks SET status = 'navigating', current_phase = '教务系统登录成功' WHERE task_uuid = ?`,
        [taskUuid]
      )
    }

    // Step 4c: 验证登录状态 — 确保 SSO 登录成功，不在登录页
    const isStillOnLogin = await page.evaluate(() => {
      const body = (document.body?.innerText || '')
      return body.includes('统一身份认证登录') || body.includes('统一身份认证')
    }).catch(() => true) // 如果页面崩溃，当作登录失败处理
    if (isStillOnLogin) {
      logger.error('[GradeOrchestrator] SSO login did not complete — still on login page: ' + page.url().substring(0, 100))
      await diagnosePage(page, 'sso_login_failed')
      await markFailed(taskUuid, '统一身份认证登录失败，页面未跳转，请重试')
      return
    }

    // Step 5: 导航到成绩查询（可能切换页面）
    await updateStatus(taskUuid, 'navigating', '正在进入成绩查询页面...')
    const navResult = await navigateToGradeQuery(page)
    if (navResult && navResult.newPage) page = navResult.newPage

    // Step 6: 查询
    await updateStatus(taskUuid, 'querying', '正在执行成绩查询...')
    await fillAndQuery(page, {
      year: task.year, school: task.school, major: task.major, className: task.className
    })

    // Step 7: 提取学生列表
    await updateStatus(taskUuid, 'querying', '正在提取学生列表...')
    const students = await extractStudentList(page)

    if (!students || students.length === 0) {
      await markFailed(taskUuid, '未查询到学生数据，请检查筛选条件')
      return
    }

    let totalGpa = 0, totalFailed = 0, gpaCount = 0
    for (const s of students) {
      if (s.gpa > 0) { totalGpa += s.gpa; gpaCount++ }
      totalFailed += s.failedCount || 0
    }
    const avgGpa = gpaCount > 0 ? Math.round((totalGpa / gpaCount) * 100) / 100 : 0

    // 提取学生摘要（不存完整课程数据避免 JSON 过大）
    const summary = students.map(s => ({
      studentId: s.studentId, name: s.name, className: s.className,
      gpa: s.gpa, failedCount: s.failedCount, coursesExtracted: false
    }))
    await saveStudentResults(taskUuid, summary, avgGpa, totalFailed)
    logger.info('[GradeOrchestrator] Saved ' + summary.length + ' students, avg GPA: ' + avgGpa)

    // Step 8: 提取课程详情
    let courseCount = 0
    if (task.extractCourses && summary.length > 0) {
      await updateStatus(taskUuid, 'extracting_courses', '正在提取课程详情...')
      for (let i = 0; i < summary.length; i++) {
        try {
          const courses = await extractStudentCourses(page, i)
          summary[i].courses = courses
          summary[i].coursesExtracted = true
          courseCount++
          if (i % 5 === 0 || i === summary.length - 1) {
            await pool.query('UPDATE grade_tasks SET course_progress=?, current_phase=? WHERE task_uuid=?',
              [courseCount, '提取课程 ' + courseCount + '/' + summary.length, taskUuid])
          }
        } catch (e) {
          logger.warn('Failed to extract courses for student ' + i + ': ' + e.message)
          summary[i].courses = []
          summary[i].coursesExtracted = false
        }
      }
      logger.info('[GradeOrchestrator] Course extraction complete: ' + courseCount + '/' + summary.length)
    }

    // 最终只存摘要（课程数据太大，单独查）
    const finalSummary = summary.map(s => ({
      studentId: s.studentId, name: s.name, className: s.className,
      gpa: s.gpa, failedCount: s.failedCount, coursesExtracted: !!s.coursesExtracted,
      courseCount: (s.courses || []).length
    }))
    await pool.query(
      'UPDATE grade_tasks SET status=?, completed_at=NOW(), results=?, avg_gpa=?, total_failed=?, course_progress=?, current_phase=? WHERE task_uuid=?',
      ['completed', JSON.stringify(finalSummary), avgGpa, totalFailed, courseCount, '查询完成', taskUuid]
    )
    logger.info('[GradeOrchestrator] Task completed — ' + finalSummary.length + ' students, ' + courseCount + ' with courses')

  } catch (e) {
    logger.error(`[GradeOrchestrator] Task failed: ${e.message}`)
    try { await markFailed(taskUuid, e.message) } catch (_) {}
  } finally {
    db.release()
    gradePages.delete(taskUuid)
    if (slot) { try { await browser.releaseContext(slot) } catch (_) {} }
    waitingLogins.delete(taskUuid)
  }
}

async function handleMfaWait(taskUuid, page, slot, db) {
  await db.query(
    `UPDATE grade_tasks SET status = 'awaiting_code', current_phase = '需要HIT APP验证码'
     WHERE task_uuid = ?`, [taskUuid]
  )
  await new Promise((resolve, reject) => {
    waitingLogins.set(taskUuid, { page, slot, resolve, reject })
  })
  waitingLogins.delete(taskUuid)
}

async function submitGradeCode(taskUuid, code) {
  const waiter = waitingLogins.get(taskUuid)
  if (!waiter) throw new Error('任务未在等待验证码')
  try {
    const { submitMfaCode } = require('./gradeQuery')
    await submitMfaCode(waiter.page, code)
    waiter.resolve({ success: true })
    return { success: true }
  } catch (e) {
    waiter.reject(e)
    throw e
  }
}

module.exports = { executeGradeQuery, submitGradeCode, gradePages }
