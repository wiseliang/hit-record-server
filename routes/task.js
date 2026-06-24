const express = require('express')
const router = express.Router()
const { createTask, getTask } = require('../models/task')
const { getCredential } = require('../models/credential')
const { executeTask, submitTaskCode, waitingTasks } = require('../services/orchestrator')
const { pendingLogins } = require('../services/login')
const logger = require('../utils/logger')

router.post('/create', async (req, res, next) => {
  try {
    const { openid, type, week, options } = req.body
    if (!openid || !type) return res.status(400).json({ error: '缺少必填字段' })
    if (!['companion', 'talk', 'batch', 'fill-missing'].includes(type)) return res.status(400).json({ error: 'type 无效' })

    const cred = await getCredential(openid)
    if (!cred && !pendingLogins.has(openid)) return res.status(400).json({ error: '请先配置凭证或扫码登录' })

    const taskUuid = await createTask(openid, type, week || 0, options)
    executeTask(taskUuid).catch(e => {
      logger.error(`Task ${taskUuid} unhandled rejection: ${e.message}`)
    })
    res.json({ taskUuid, status: 'running', message: '任务已创建' })
  } catch (e) { next(e) }
})

router.get('/:taskUuid', async (req, res, next) => {
  try {
    const task = await getTask(req.params.taskUuid)
    if (!task) return res.status(404).json({ error: '任务不存在' })

    const waiter = waitingTasks.get(req.params.taskUuid)
    const response = { ...task }

    if (waiter && waiter.captchaImage) {
      response.needsCaptcha = true
      response.captchaImage = waiter.captchaImage
      response.status = 'awaiting_code'
    }

    // 如果 DB status 是 awaiting_code 但 waitingTasks 里没有 entry，
    // 说明服务重启后状态残留，标记为失败
    if (task.status === 'awaiting_code' && !waiter) {
      logger.warn(`Task ${req.params.taskUuid} has stale awaiting_code status, marking as failed`)
      const pool = require('../config/database')
      await pool.query(
        "UPDATE tasks SET status='failed', errors=? WHERE task_uuid=?",
        [JSON.stringify([{ reason: '服务重启，验证码会话已过期，请重新发起录入' }]), req.params.taskUuid]
      )
      response.status = 'failed'
      response.errors = [{ reason: '服务重启，验证码会话已过期，请重新发起录入' }]
    }

    res.json(response)
  } catch (e) { next(e) }
})

router.post('/:taskUuid/submit-code', async (req, res, next) => {
  try {
    const { code } = req.body
    if (!code) return res.status(400).json({ error: '缺少验证码' })

    const taskUuid = req.params.taskUuid
    logger.info(`Task submit-code: uuid=${taskUuid}, hasWaiter=${waitingTasks.has(taskUuid)}`)

    await submitTaskCode(taskUuid, code)
    res.json({ success: true })
  } catch (e) {
    // 提供更友好的错误信息
    if (e.message && e.message.includes('任务未在等待验证码')) {
      return res.status(400).json({
        error: '验证码会话已过期，请返回重新发起录入',
        retryable: true
      })
    }
    next(e)
  }
})

router.post('/:taskUuid/resend-code', async (req, res, next) => {
  try {
    const waiter = waitingTasks.get(req.params.taskUuid)
    if (!waiter) return res.status(400).json({ error: '任务未在等待验证码' })

    // 重新点击发送验证码
    await waiter.page.evaluate(() => {
      const btn = document.getElementById('getDynamicCode')
      if (btn && btn.offsetParent !== null) { btn.click(); return }
      const btns = document.querySelectorAll('button')
      for (const b of btns) {
        const t = (b.textContent || '').trim()
        if ((t.includes('获取验证码') || t.includes('Obtain') || t.includes('Send')) && b.offsetParent !== null) {
          b.click(); return
        }
      }
    })

    res.json({ success: true })
  } catch (e) { next(e) }
})

// 暂停任务
router.post('/:taskUuid/pause', async (req, res, next) => {
  try {
    const pool = require('../config/database')
    await pool.query('UPDATE tasks SET paused = 1 WHERE task_uuid = ?', [req.params.taskUuid])
    logger.info(`Task ${req.params.taskUuid} pause requested`)
    res.json({ success: true })
  } catch (e) { next(e) }
})

// 恢复任务
router.post('/:taskUuid/resume', async (req, res, next) => {
  try {
    const pool = require('../config/database')
    await pool.query("UPDATE tasks SET paused = 0, status = 'running' WHERE task_uuid = ?", [req.params.taskUuid])
    logger.info(`Task ${req.params.taskUuid} resumed`)
    res.json({ success: true })
  } catch (e) { next(e) }
})

// 放弃任务
router.post('/:taskUuid/abandon', async (req, res, next) => {
  try {
    const pool = require('../config/database')
    await pool.query(
      "UPDATE tasks SET paused = 0, status = 'failed', errors = ? WHERE task_uuid = ?",
      [JSON.stringify([{ reason: '用户手动终止' }]), req.params.taskUuid]
    )
    logger.info(`Task ${req.params.taskUuid} abandoned by user`)
    res.json({ success: true })
  } catch (e) { next(e) }
})

module.exports = router
