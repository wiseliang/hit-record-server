const express = require('express')
const router = express.Router()
const { getCredential } = require('../models/credential')
const { createGradeTask, getGradeTask } = require('../models/grade')
const { executeGradeQuery, submitGradeCode, gradePages } = require('../services/gradeOrchestrator')
const { waitingLogins, gradeLoginSessions, performIvpnLoginStep, submitIvpnLoginCode } = require('../services/gradeQuery')
const logger = require('../utils/logger')

// ===== 成绩查询完整登录（前移到前端登录阶段） =====

// 开始 ivpn 登录链
router.post('/login-start', async (req, res, next) => {
  try {
    const openid = req.body.openid || req.headers['x-openid']
    if (!openid) return res.status(400).json({ error: '缺少 openid' })

    const mode = req.body.mode || 'password'
    const result = await performIvpnLoginStep(openid, mode)
    if (result.error) return res.status(400).json({ error: result.error })
    res.json(result)
  } catch (e) { next(e) }
})

// 提交登录过程中的验证码
router.post('/login-submit-code', async (req, res, next) => {
  try {
    const openid = req.body.openid || req.headers['x-openid']
    const { code } = req.body
    if (!openid || !code) return res.status(400).json({ error: '缺少参数' })

    const result = await submitIvpnLoginCode(openid, code)
    if (result.error) return res.status(400).json({ error: result.error })
    res.json(result)
  } catch (e) { next(e) }
})

// 查询登录状态
router.get('/login-status', async (req, res, next) => {
  try {
    const openid = req.query.openid || req.headers['x-openid']
    const session = gradeLoginSessions.get(openid)
    res.json({
      loggedIn: !!(session && session.step === 'done'),
      step: session ? session.step : 'none'
    })
  } catch (e) { next(e) }
})

/**
 * POST /api/grade/start-query
 * 创建成绩查询任务
 */
router.post('/start-query', async (req, res, next) => {
  try {
    const openid = req.body.openid || req.headers['x-openid']
    if (!openid) return res.status(400).json({ error: '缺少 openid' })

    // 验证凭证
    const cred = await getCredential(openid)
    if (!cred) return res.status(400).json({ error: '请先配置凭证' })

    const { year, school, major, className, extractCourses } = req.body
    const taskUuid = await createGradeTask(openid, {
      year: year || '2022',
      school: school || '信息科学与工程学院',
      major: major || '自动化',
      className: className || '',
      extractCourses: extractCourses !== false  // 默认提取
    })

    // 异步执行
    executeGradeQuery(taskUuid).catch(e => {
      logger.error(`Grade query ${taskUuid} error: ${e.message}`)
    })

    res.json({
      taskUuid,
      status: 'pending',
      message: '成绩查询任务已创建'
    })
  } catch (e) { next(e) }
})

/**
 * GET /api/grade/:taskUuid
 * 查询任务进度/结果
 */
router.get('/:taskUuid', async (req, res, next) => {
  try {
    const task = await getGradeTask(req.params.taskUuid)
    if (!task) return res.status(404).json({ error: '任务不存在' })

    // 检查是否在等待验证码/MFA/QR扫码
    const waiter = waitingLogins.get(req.params.taskUuid)
    const qrWaiter = gradePages.get(req.params.taskUuid)

    // 如果任务状态是 awaiting_code 且有 QR 码（教务系统需要扫码）
    if (task.status === 'awaiting_code' && task.verify_code) {
      return res.json({
        taskUuid: task.taskUuid,
        status: 'awaiting_code',
        currentPhase: task.currentPhase,
        qrcode: task.verify_code,
        message: '教务系统需要扫码登录，请用 HIT APP 扫描二维码'
      })
    }

    const response = {
      taskUuid: task.taskUuid,
      status: task.status,
      year: task.year,
      school: task.school,
      major: task.major,
      className: task.className,
      extractCourses: task.extractCourses,
      studentCount: task.studentCount,
      courseProgress: task.courseProgress,
      avgGpa: task.avgGpa,
      totalFailed: task.totalFailed,
      currentPhase: task.currentPhase,
      results: task.results,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      createdAt: task.createdAt
    }

    if (waiter && waiter.captchaImage) {
      response.needsCaptcha = true
      response.captchaImage = waiter.captchaImage
      response.status = 'awaiting_code'
    }

    res.json(response)
  } catch (e) { next(e) }
})

/**
 * POST /api/grade/:taskUuid/submit-code
 * 提交验证码（图片验证码或 MFA）
 */
router.post('/:taskUuid/submit-code', async (req, res, next) => {
  try {
    const { code, captcha } = req.body
    const codeValue = code || captcha
    if (!codeValue) return res.status(400).json({ error: '缺少验证码' })

    await submitGradeCode(req.params.taskUuid, codeValue)
    res.json({ success: true, message: '验证码已提交' })
  } catch (e) {
    res.status(400).json({ error: e.message || '提交失败' })
  }
})

/**
 * GET /api/grade/:taskUuid/export
 * 获取导出格式的数据
 */
router.get('/:taskUuid/export', async (req, res, next) => {
  try {
    const task = await getGradeTask(req.params.taskUuid)
    if (!task) return res.status(404).json({ error: '任务不存在' })
    if (task.status !== 'completed') return res.status(400).json({ error: '任务尚未完成' })

    const students = task.results || []
    const format = req.query.format || 'json'

    if (format === 'csv') {
      // CSV 格式
      let csv = '﻿学号,姓名,班级,学分绩,不及格门数\n'  // BOM for Excel
      for (const s of students) {
        csv += `${s.studentId},${s.name},${s.className},${s.gpa},${s.failedCount}\n`
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename=grade_export.csv')
      res.send(csv)
    } else if (format === 'text') {
      // 纯文本制表符分隔
      let text = '学号\t姓名\t班级\t学分绩\t不及格门数\n'
      for (const s of students) {
        text += `${s.studentId}\t${s.name}\t${s.className}\t${s.gpa}\t${s.failedCount}\n`
      }
      res.json({ plainText: text, studentCount: students.length })
    } else {
      // JSON 格式（含课程详情）
      res.json({
        taskUuid: task.taskUuid,
        year: task.year,
        school: task.school,
        major: task.major,
        summary: {
          studentCount: students.length,
          avgGpa: task.avgGpa,
          totalFailed: task.totalFailed,
          coursesExtractedCount: students.filter(s => s.coursesExtracted).length
        },
        students,
        plainText: generatePlainText(students),
        csvData: generateCsv(students)
      })
    }
  } catch (e) { next(e) }
})

/**
 * GET /api/grade/:taskUuid/student/:studentIndex/courses
 * 获取单个学生的课程详情
 */
router.get('/:taskUuid/student/:studentIndex/courses', async (req, res, next) => {
  try {
    const task = await getGradeTask(req.params.taskUuid)
    if (!task) return res.status(404).json({ error: '任务不存在' })

    const studentIndex = parseInt(req.params.studentIndex)
    const students = task.results || []
    if (studentIndex < 0 || studentIndex >= students.length) {
      return res.status(404).json({ error: '学生索引无效' })
    }

    res.json({
      student: {
        studentId: students[studentIndex].studentId,
        name: students[studentIndex].name,
        className: students[studentIndex].className,
        gpa: students[studentIndex].gpa,
        failedCount: students[studentIndex].failedCount
      },
      courses: students[studentIndex].courses || [],
      coursesExtracted: students[studentIndex].coursesExtracted || false
    })
  } catch (e) { next(e) }
})

// ===== 辅助函数 =====

function generatePlainText(students) {
  let text = '学号\t姓名\t班级\t学分绩\t不及格门数\n'
  for (const s of students) {
    text += `${s.studentId}\t${s.name}\t${s.className}\t${s.gpa}\t${s.failedCount}\n`
  }
  return text
}

function generateCsv(students) {
  let csv = '﻿学号,姓名,班级,学分绩,不及格门数\n'
  for (const s of students) {
    csv += `${s.studentId},${s.name},${s.className},${s.gpa},${s.failedCount}\n`
  }
  return csv
}

/**
 * GET /api/grade/:taskUuid/diagnose
 * 诊断端点：返回当前浏览器页面的状态，所有操作 3 秒超时避免卡死
 */
router.get('/:taskUuid/diagnose', async (req, res, next) => {
  try {
    const task = await getGradeTask(req.params.taskUuid)
    if (!task) return res.status(404).json({ error: '任务不存在' })

    const gp = gradePages.get(req.params.taskUuid)
    const diag = {
      taskStatus: task.status,
      taskPhase: task.currentPhase,
      hasPage: !!(gp && gp.page),
      debugStep: gp ? gp.step : '未设置',
      url: null, title: null, bodySnippet: null,
      visibleButtons: null, visibleInputs: null,
      screenshot: null, errors: []
    }

    if (!gp || !gp.page) {
      diag.hint = '任务尚未开始或已完成，浏览器页面已释放'
      return res.json(diag)
    }

    const page = gp.page
    const timeout = (ms, fn) => Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ])

    // url() 不会卡，直接获取
    try { diag.url = page.url() } catch (e) { diag.errors.push('url: ' + e.message) }

    // title — 3s 超时
    try {
      diag.title = await timeout(3000, () => page.title())
    } catch (e) { diag.errors.push('title: ' + e.message) }

    // body 文本 — 3s 超时
    try {
      diag.bodySnippet = await timeout(3000, () =>
        page.evaluate(() => (document.body?.innerText || '').substring(0, 800))
      )
    } catch (e) { diag.errors.push('body: ' + e.message) }

    // 可见按钮 — 3s 超时
    try {
      diag.visibleButtons = await timeout(3000, () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('button'))
            .filter(b => b.offsetParent !== null)
            .map(b => (b.textContent || '').trim().substring(0, 40)).slice(0, 8)
        )
      )
    } catch (e) { diag.errors.push('buttons: ' + e.message) }

    // 可见输入框 — 3s 超时
    try {
      diag.visibleInputs = await timeout(3000, () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('input:not([type="hidden"])'))
            .filter(i => i.offsetParent !== null)
            .map(i => ({ id: i.id, type: i.type, placeholder: (i.placeholder || '').substring(0, 30) }))
            .slice(0, 8)
        )
      )
    } catch (e) { diag.errors.push('inputs: ' + e.message) }

    // 截图 — 5s 超时，低质量
    try {
      const buf = await timeout(5000, () => page.screenshot({ type: 'jpeg', quality: 30, fullPage: false }))
      diag.screenshot = 'data:image/jpeg;base64,' + buf.toString('base64')
    } catch (e) { diag.errors.push('screenshot: ' + e.message) }

    res.json(diag)
  } catch (e) { next(e) }
})

module.exports = router
