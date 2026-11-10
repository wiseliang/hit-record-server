const express = require('express')
const router = express.Router()
const axios = require('axios')
const crypto = require('crypto')
const config = require('../config')
const logger = require('../utils/logger')
const { saveCredential, getCredential, hasCredential } = require('../models/credential')
const { startLogin, submitCode, submitCaptcha, navigateToWorkLog, pendingLogins, performAuthserverLogin, captureQrCode, waitForQrLogin, recoverSession } = require('../services/login')
const { getStudentList, getCompletionStatus } = require('../services/navigator')
const browser = require('../services/browser')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const { issueToken, verifyToken, bearer } = require('../utils/session')

// Android installations receive a random identity. Existing identities can only
// be resumed with their signed token, never with a client supplied openid/code.
router.post('/login', async (req, res, next) => {
  try {
    const { code, platform } = req.body
    let openid
    if (platform === 'android') {
      const token = bearer(req)
      openid = token ? verifyToken(token) : 'android_' + crypto.randomBytes(24).toString('hex')
      if (!openid || !openid.startsWith('android_')) return res.status(401).json({ error: '登录已失效，请重新登录' })
    } else {
      if (!code) return res.status(400).json({ error: '缺少登录code' })
      if (!config.wechat.appId || !config.wechat.appSecret) return res.status(503).json({ error: '微信登录尚未配置' })
      const { data } = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
        params: { appid: config.wechat.appId, secret: config.wechat.appSecret, js_code: code, grant_type: 'authorization_code' }, timeout: 10000
      })
      if (data.errcode || !data.openid) return res.status(400).json({ error: '微信登录失败' })
      openid = data.openid
    }
    const token = issueToken(openid)
    const hasCred = await hasCredential(openid)
    res.json({ openid, token, hasCredential: hasCred })
  } catch (e) { next(e) }
})

router.use(require('../middleware/auth'))

// 保存凭证
router.post('/credential', async (req, res, next) => {
  try {
    const { openid, studentId, password } = req.body
    if (!openid || !studentId || !password) return res.status(400).json({ error: '缺少必填字段' })
    await saveCredential(openid, studentId, password)
    res.json({ success: true })
  } catch (e) { next(e) }
})

// 查询凭证
router.get('/credential', async (req, res, next) => {
  try {
    const openid = req.query.openid || req.headers['x-openid']
    if (!openid) return res.status(400).json({ error: '缺少openid' })
    const has = await hasCredential(openid)
    res.json({ hasCredential: has })
  } catch (e) { next(e) }
})

// 查询活跃登录会话（QR登录或密码登录成功后均会存在 pendingLogins 中）
router.get('/session-status', async (req, res, next) => {
  try {
    const openid = req.query.openid || req.headers['x-openid']
    if (!openid) return res.status(400).json({ error: '缺少openid' })
    const session = pendingLogins.get(openid)
    if (!session) return res.json({ hasActiveSession: false })
    // 验证页面是否仍然有效（未被回收/关闭）
    // 用 evaluate 而非 url()，因为 url() 可能对已关闭页面不抛异常
    try {
      await session.page.evaluate(() => document.title)
      res.json({ hasActiveSession: true })
    } catch (_) {
      pendingLogins.delete(openid)
      res.json({ hasActiveSession: false })
    }
  } catch (e) { next(e) }
})

// 第一步：登录学工系统
router.post('/start-login', async (req, res, next) => {
  try {
    const { openid } = req.body
    if (!openid) return res.status(400).json({ error: '缺少openid' })
    const cred = await getCredential(openid)
    if (!cred) return res.status(400).json({ error: '未配置凭证' })

    const old = pendingLogins.get(openid)
    if (old) { try { await browser.releaseContext(old.slot) } catch (_) {}; pendingLogins.delete(openid) }

    const { slot, page } = await browser.acquireContext()
    try {
      const result = await startLogin(page, cred.studentId, cred.password)
      const loginInfo = { slot, page, studentId: cred.studentId, password: cred.password }

      // 登录失败（卡在 authserver）— 释放资源并返回截图
      if (result.loginFailed) {
        await browser.releaseContext(slot)
        return res.json({
          loginFailed: true,
          screenshot: result.screenshot,
          diag: result.diag,
          message: result.message
        })
      }

      if (result.needsCaptcha) {
        pendingLogins.set(openid, loginInfo)
        res.json({ needsCaptcha: true, captchaImage: result.captchaImage, message: result.message })
      } else if (result.needsCode) {
        pendingLogins.set(openid, loginInfo)
        res.json({ needsCode: true, message: result.message })
      } else {
        pendingLogins.set(openid, loginInfo)
        res.json({ needsCode: false, message: result.message })
      }
    } catch (e) { await browser.releaseContext(slot); throw e }
  } catch (e) { next(e) }
})

// 提交图片验证码
router.post('/submit-captcha', async (req, res, next) => {
  try {
    const { openid, captcha } = req.body
    if (!openid || !captcha) return res.status(400).json({ error: '缺少openid或验证码' })
    const session = pendingLogins.get(openid)
    if (!session) return res.status(400).json({ error: '登录会话已过期' })
    try {
      const result = await submitCaptcha(session.page, captcha, session.studentId, session.password)
      if (result.retry) {
        res.json({ needsCaptcha: true, captchaImage: result.captchaImage, message: result.message })
      } else if (result.needsCode) {
        res.json({ needsCode: true, message: result.message })
      } else {
        // 登录成功，导航到工作日志
        const workPage = await navigateToWorkLog(session.page)
        session.page = workPage
        await browser.keepOnly(session.slot, workPage)
        res.json({ needsCode: false, message: result.message })
      }
    } catch (e) { throw e }
  } catch (e) { next(e) }
})

// 提交 HIT APP 验证码，并导航到工作日志页
router.post('/submit-code', async (req, res, next) => {
  try {
    const { openid, code } = req.body
    if (!openid || !code) return res.status(400).json({ error: '缺少openid或验证码' })
    const session = pendingLogins.get(openid)
    if (!session) return res.status(400).json({ error: '登录会话已过期' })
    try {
      await submitCode(session.page, code)

      const workPage = await navigateToWorkLog(session.page)
      session.page = workPage
      await browser.keepOnly(session.slot, workPage)

      res.json({ success: true })
    } catch (e) { throw e }
  } catch (e) { next(e) }
})

router.get('/academic-calendar', async (req, res, next) => {
  try {
    const session = pendingLogins.get(req.openid)
    if (!session) return res.status(400).json({ error: '请先登录学工系统' })
    const page = await navigateToWorkLog(session.page)
    session.page = page
    await browser.keepOnly(session.slot, page)
    const calendar = await require('../services/academicCalendar').syncSchoolCalendar(page)
    session.calendar = calendar
    res.json(calendar)
  } catch (e) { next(e) }
})

// 获取学生列表（需要已登录，支持 session 过期自动恢复）
router.get('/student-list', async (req, res, next) => {
  try {
    const openid = req.query.openid || req.headers['x-openid']
    const week = parseInt(req.query.week) || 1
    if (!openid) return res.status(400).json({ error: '缺少openid' })

    const session = pendingLogins.get(openid)
    if (!session) return res.status(400).json({ error: '请先登录学工系统' })

    let workPage
    try {
      workPage = await navigateToWorkLog(session.page)
    } catch (e) {
      if (e.message !== 'SESSION_EXPIRED') throw e
      logger.warn('student-list: session expired, attempting recovery...')
      const recovered = await recoverSession(session.page, openid)
      if (!recovered.success) {
        return res.status(401).json({ error: recovered.message, sessionExpired: true })
      }
      workPage = recovered.page
    }
    session.page = workPage
    const students = await getStudentList(workPage, week)
    res.json({ students, week })
  } catch (e) { next(e) }
})

// 重发验证码
router.post('/resend-code', async (req, res, next) => {
  try {
    const { openid } = req.body
    if (!openid) return res.status(400).json({ error: '缺少openid' })
    const session = pendingLogins.get(openid)
    if (!session) return res.status(400).json({ error: '登录会话已过期，请重新检测' })

    await session.page.evaluate(() => {
      const btns = document.querySelectorAll('button, a, span')
      for (const b of btns) {
        const t = (b.textContent || '').trim()
        if (b.offsetParent !== null && (t.includes('Obtain') || t.includes('获取') || t.includes('Send'))) {
          b.click(); return
        }
      }
    })

    res.json({ success: true, message: '验证码已重新发送' })
  } catch (e) { next(e) }
})

// 查询录入完成情况（第1周到当前周，支持 session 过期自动恢复）
router.get('/check-status', async (req, res, next) => {
  try {
    const openid = req.query.openid || req.headers['x-openid']
    if (!openid) return res.status(400).json({ error: '缺少openid' })
    const session = pendingLogins.get(openid)
    if (!session) return res.status(400).json({ error: '请先登录学工系统' })

    let workPage
    try {
      workPage = await navigateToWorkLog(session.page)
    } catch (e) {
      if (e.message !== 'SESSION_EXPIRED') throw e
      logger.warn('check-status: session expired, attempting recovery...')
      const recovered = await recoverSession(session.page, openid)
      if (!recovered.success) {
        return res.status(401).json({ error: recovered.message, sessionExpired: true })
      }
      workPage = recovered.page
    }
    session.page = workPage
    await browser.keepOnly(session.slot, workPage)

    const currentWeek = require('../utils/week').getCurrentWeek()
    const allWeeks = []

    for (let w = 1; w <= currentWeek; w++) {
      const students = await getCompletionStatus(workPage, w)
      const incomplete = students.filter(s => s.needCount > 0)
      allWeeks.push({
        week: w,
        type: w % 2 === 1 ? 'companion' : 'talk',
        total: students.length,
        incomplete: incomplete.length,
        needTotal: incomplete.reduce((sum, s) => sum + s.needCount, 0),
        students: students.map(s => ({ name: s.name, needCount: s.needCount }))
      })
    }

    res.json({ weeks: allWeeks, currentWeek })
  } catch (e) { next(e) }
})

// 释放暂挂的登录页
router.post('/release', async (req, res, next) => {
  try {
    const { openid } = req.body
    const session = pendingLogins.get(openid)
    if (session) {
      pendingLogins.delete(openid)
      try { await browser.releaseContext(session.slot) } catch (_) {}
    }
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ===== 二维码登录 =====

// 存储二维码登录会话
const qrLoginSessions = new Map() // openid -> { slot, page }

// 第一步：获取二维码（target: 'xuegong' 用于录入, 'ivpn' 用于成绩查询）
router.post('/qrcode-start', async (req, res, next) => {
  try {
    const { openid, target } = req.body
    if (!openid) return res.status(400).json({ error: '缺少openid' })

    // 清理旧会话
    const old = qrLoginSessions.get(openid)
    if (old) {
      try { await browser.releaseContext(old.slot) } catch (_) {}
      qrLoginSessions.delete(openid)
    }

    // 获取浏览器上下文
    const { slot, page } = await browser.acquireContext()

    // 根据 target 选择入口
    if (target === 'ivpn') {
      // 成绩查询：走 ivpn → SSO
      logger.info('[QRLogin] Navigating to ivpn for grade query...')
      await page.goto('https://ivpn.hitwh.edu.cn/', {
        waitUntil: 'domcontentloaded', timeout: 30000
      })
      // 等待重定向到 SSO
      for (let i = 0; i < 15; i++) {
        await sleep(2000)
        const u = page.url()
        if (u.includes('ids.hit.edu.cn') || u.includes('authserver')) {
          logger.info(`[QRLogin] Redirected to SSO after ${(i+1)*2}s`)
          break
        }
        if (i % 3 === 2) logger.info(`[QRLogin] Waiting for SSO redirect... (${u.substring(0, 80)})`)
      }
      await sleep(2000)
    } else {
      // 录入：直接导航到 SSO 页面（绕过 xuegong 登录中间页）
      logger.info('[QRLogin] Navigating directly to SSO...')
      const ssoUrl = 'https://ids.hit.edu.cn/authserver/login?service=http%3A%2F%2Fxuegong.hitwh.edu.cn%2Fcas'
      await page.goto(ssoUrl, {
        waitUntil: 'domcontentloaded', timeout: 20000
      })
      await sleep(3000)
    }

    // 等待 SSO 页面加载完成
    for (let i = 0; i < 8; i++) {
      await sleep(1000)
      const u = page.url()
      if (u.includes('reAuth') || u.includes('multifactor') || u.includes('reAuthCheck')) break
      if (u.includes('ids.hit.edu.cn') || u.includes('authserver')) break
      // 如果已被重定向到其他页面（session 有效），等待跳转完成
      if (!u.includes('/login')) break
      if (i >= 3) break
    }

    const currentUrl = page.url()

    // CAS 过渡页：SSO 返回了 ticket，正在跳转到目标系统，等待跳转完成
    if (currentUrl.includes('/cas') && !currentUrl.includes('authserver')) {
      logger.info(`[QRLogin] On CAS transition page, waiting for final redirect...`)
      for (let i = 0; i < 15; i++) {
        await sleep(2000)
        const u = page.url()
        if (!u.includes('/cas') || u.includes('ids.hit.edu.cn') || u.includes('authserver')) {
          logger.info(`[QRLogin] CAS redirect complete: ${u.substring(0, 100)}`)
          break
        }
        if (i % 3 === 2) logger.info(`[QRLogin] Still on CAS page... (${u.substring(0, 80)})`)
      }
    }

    const finalUrl = page.url()

    // 如果仍卡在 CAS 过渡页，登录跳转失败
    if (finalUrl.includes('/cas') && !finalUrl.includes('authserver')) {
      logger.warn(`[QRLogin] Stuck on CAS page after wait, cannot proceed. URL: ${finalUrl.substring(0, 120)}`)
      await browser.releaseContext(slot)
      return res.json({ hasQrCode: false, message: '学工系统登录跳转失败（CAS超时），请重试' })
    }

    // 已在目标系统内（session 有效，SSO 自动跳过了）
    if (!finalUrl.includes('ids.hit.edu.cn') && !finalUrl.includes('authserver')
        && !finalUrl.includes('/login') && !finalUrl.includes('/cas')) {
      logger.info(`[QRLogin] Already logged in (session valid): ${finalUrl.substring(0, 100)}`)
      const cred = await getCredential(openid)
      const loginSession = { slot, page, studentId: cred?.studentId || '', password: cred?.password || '' }
      pendingLogins.set(openid, loginSession)
      if (target === 'ivpn') {
        try { require('../services/gradeQuery').waitingLogins.set(openid, loginSession) } catch (_) {}
      }
      return res.json({ loggedIn: true, hasQrCode: false, message: '已登录，无需扫码' })
    }

    // 检查是否直接进入了 MFA 页面（上次扫码的 session 还在）
    if (finalUrl.includes('reAuth') || finalUrl.includes('multifactor') || finalUrl.includes('reAuthCheck')) {
      logger.info('[QRLogin] Skipped to MFA page (previous session cached)')
      // 点击获取验证码
      try {
        await page.evaluate(() => {
          const btn = document.getElementById('getDynamicCode')
          if (btn && btn.offsetParent !== null) { btn.click(); return }
          const btns = document.querySelectorAll('button')
          for (const b of btns) {
            const t = (b.textContent || '').trim()
            if (b.offsetParent !== null && (t.includes('获取验证码') || t.includes('Obtain') || t.includes('Send'))) {
              b.click(); return
            }
          }
        })
        await sleep(1000)
      } catch (_) {}
      qrLoginSessions.set(openid, { slot, page, target: target || 'xuegong', needsMfa: true })
      return res.json({
        needsMfa: true,
        hasQrCode: false,
        message: '已发送验证码，请在 HIT APP 中查看'
      })
    }

    // 获取二维码
    const result = await captureQrCode(page)

    if (result.qrcode) {
      qrLoginSessions.set(openid, { slot, page, target: target || 'xuegong' })
      res.json({
        qrcode: result.qrcode,
        message: result.message,
        hasQrCode: true
      })
    } else {
      // 没找到二维码，释放资源
      await browser.releaseContext(slot)
      res.json({
        hasQrCode: false,
        message: result.message
      })
    }
  } catch (e) { next(e) }
})

// 第二步：等待扫码完成（轮询最多 60 秒）
router.post('/qrcode-wait', async (req, res, next) => {
  try {
    const { openid } = req.body
    if (!openid) return res.status(400).json({ error: '缺少openid' })

    const session = qrLoginSessions.get(openid)
    if (!session) return res.status(400).json({ error: '二维码会话已过期，请重新获取' })

    // 检查当前页面状态
    let u = ''
    try { u = session.page.url() } catch (_) {}

    // 情况1: 已离开 authserver → 登录成功
    if (!u.includes('ids.hit.edu.cn') && !u.includes('authserver')) {
      logger.info(`[QRLogin] ✅ Scan successful, redirected to: ${u.substring(0, 100)}`)
      // loggedIn = true, continue below
    }
    // 情况2: 多因子认证页面（扫码后偶尔出现）
    else if (u.includes('reAuth') || u.includes('multifactor') || u.includes('reAuthCheck')) {
      logger.info('[QRLogin] 🔐 MFA required after QR scan')
      // 点击获取验证码
      try {
        await session.page.evaluate(() => {
          const btn = document.getElementById('getDynamicCode')
          if (btn && btn.offsetParent !== null) { btn.click(); return }
          const btns = document.querySelectorAll('button')
          for (const b of btns) {
            const t = (b.textContent || '').trim()
            if (b.offsetParent !== null && (t.includes('获取验证码') || t.includes('Obtain') || t.includes('Send'))) {
              b.click(); return
            }
          }
        })
        await sleep(1000)
      } catch (_) {}
      // 标记为 MFA 等待状态
      session.needsMfa = true
      return res.json({
        needsMfa: true,
        message: '扫码成功，需要多因子认证。已发送验证码，请在 HIT APP 中查看',
        url: u.substring(0, 120)
      })
    }
    // 情况3: 还在 authserver 登录页
    else {
      logger.info(`[QRLogin] Still on authserver: ${u.substring(0, 80)}`)
      return res.json({ loggedIn: false, message: '请确认 HIT APP 已扫描并确认登录', url: u.substring(0, 120) })
    }

    // 到这里说明已登录（情况1）

    logger.info('[QRLogin] Scan successful!')

    // 转存到 pendingLogins + gradeQuery.waitingLogins
    const cred = await getCredential(openid)
    const loginSession = {
      slot: session.slot,
      page: session.page,
      studentId: cred ? cred.studentId : '',
      password: cred ? cred.password : ''
    }
    pendingLogins.set(openid, loginSession)

    if (session.target === 'ivpn') {
      try {
        const { waitingLogins: gradeWaitingLogins } = require('../services/gradeQuery')
        gradeWaitingLogins.set(openid, loginSession)
        logger.info('[QRLogin] Stored in gradeQuery.waitingLogins')
      } catch (_) {}
    }

    qrLoginSessions.delete(openid)
    res.json({ loggedIn: true, message: '扫码登录成功' })

  } catch (e) { next(e) }
})

// 提交 QR 登录流程中的 MFA 验证码
router.post('/qrcode-submit-code', async (req, res, next) => {
  try {
    const { openid, code } = req.body
    if (!openid || !code) return res.status(400).json({ error: '缺少参数' })

    const session = qrLoginSessions.get(openid)
    if (!session || !session.needsMfa) return res.status(400).json({ error: '无 MFA 会话或已过期' })

    logger.info('[QRLogin] Submitting MFA code...')

    // 填验证码
    const codeInput = await session.page.$('#dynamicCode') || await session.page.$('#code') || await session.page.$('[name="code"]')
    if (!codeInput) {
      // JS fallback
      await session.page.evaluate((val) => {
        const inp = document.getElementById('dynamicCode') || document.querySelector('#code') || document.querySelector('[name="code"]')
        if (inp) { inp.value = val; inp.dispatchEvent(new Event('input', { bubbles: true })) }
      }, code)
    } else {
      await codeInput.fill(code)
    }
    await sleep(300)

    // 点击登录
    await session.page.evaluate(() => {
      const btns = document.querySelectorAll('button')
      for (const b of btns) {
        const t = (b.textContent || '').trim()
        if (b.offsetParent !== null && (t === '登录' || t === 'Sign in')) {
          b.click(); return
        }
      }
    })
    await sleep(3000)

    // 处理信任弹窗
    for (let i = 0; i < 3; i++) {
      try {
        const clicked = await session.page.evaluate(() => {
          const btns = document.querySelectorAll('button')
          for (const b of btns) {
            const t = (b.textContent || '').trim()
            if (b.offsetParent !== null && (
              t === '信任此设备' || t === '仅本次登录' || t === '信任' ||
              t === 'Trust this device' || t === 'Login this time only' || t === 'Trust'
            )) { b.click(); return t }
          }
          return null
        })
        if (!clicked) break
        await sleep(1500)
      } catch (_) { break }
    }

    // 等跳转离开 authserver
    try {
      await session.page.waitForURL(url => {
        return !url.includes('ids.hit.edu.cn') && !url.includes('authserver')
      }, { timeout: 15000 })
    } catch (_) {}

    const finalUrl = session.page.url()
    const success = !finalUrl.includes('ids.hit.edu.cn') && !finalUrl.includes('authserver')
    logger.info(`[QRLogin] MFA result: success=${success}, url=${finalUrl.substring(0, 100)}`)

    if (success) {
      session.needsMfa = false
      res.json({ success: true, message: 'MFA 验证成功，已登录' })
    } else {
      res.json({ success: false, message: '验证码可能错误，请重试' })
    }
  } catch (e) { next(e) }
})

// 截图诊断：查看当前登录页面的实际状态（所有流程通用）
router.post('/qrcode-screenshot', async (req, res, next) => {
  try {
    const { openid, taskUuid } = req.body
    if (taskUuid) {
      const pool = require('../config/database')
      const [rows] = await pool.query(
        'SELECT task_uuid FROM tasks WHERE task_uuid = ? AND openid = ? UNION ALL SELECT task_uuid FROM grade_tasks WHERE task_uuid = ? AND openid = ?',
        [taskUuid, req.openid, taskUuid, req.openid]
      )
      if (!rows.length) return res.status(404).json({ error: '任务不存在' })
    }
    // 搜索所有可能的会话来源
    let session = qrLoginSessions.get(openid)
    if (!session) session = pendingLogins.get(openid)
    if (!session && taskUuid) {
      try {
        const { waitingTasks } = require('../services/orchestrator')
        session = waitingTasks.get(taskUuid)
      } catch (_) {}
    }
    if (!session && taskUuid) {
      try {
        const { waitingLogins: gradeWaiting } = require('../services/gradeQuery')
        session = gradeWaiting.get(taskUuid)
      } catch (_) {}
    }
    if (!session) return res.status(400).json({ error: '无活跃的登录会话' })

    const diag = await session.page.evaluate(() => ({
      url: location.href.substring(0, 200),
      title: document.title,
      bodyText: (document.body?.innerText || '').substring(0, 500),
      qrVisible: (() => {
        const qr = document.querySelector('img[src*="qrCode"]')
        return !!(qr && qr.offsetParent !== null)
      })(),
      successVisible: (() => {
        const s = document.querySelector('img[src*="success_qr"]')
        return !!(s && s.offsetParent !== null)
      })(),
      buttons: Array.from(document.querySelectorAll('button'))
        .filter(b => b.offsetParent !== null)
        .map(b => b.textContent.trim().substring(0, 30))
    }))

    let screenshot = null
    try {
      const buf = await session.page.screenshot({ type: 'jpeg', quality: 50 })
      screenshot = 'data:image/jpeg;base64,' + buf.toString('base64')
    } catch (_) {}

    res.json({ diag, screenshot })
  } catch (e) { next(e) }
})

module.exports = router
