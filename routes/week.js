const express = require('express')
const router = express.Router()
const { getCurrentWeek, getWeekType, getWeekRange } = require('../utils/week')
const { updateCalendarIfNeeded } = require('../services/calendarUpdater')
const logger = require('../utils/logger')

const TYPE_INFO = {
  companion: { name: '录入陪伴', tag: '共同上课 · 查课' },
  talk: { name: '录入谈话', tag: '走访寝室 · 查寝' }
}

router.get('/current', (req, res) => {
  const week = getCurrentWeek()
  const type = getWeekType(week)
  const info = TYPE_INFO[type]

  res.json({
    week,
    type,
    typeName: info.name,
    typeTag: info.tag,
    weekRange: getWeekRange(week),
    isOdd: week % 2 === 1
  })
})

// 手动触发校历更新
router.post('/update-calendar', async (req, res, next) => {
  try {
    const result = await updateCalendarIfNeeded()
    res.json(result)
  } catch (e) {
    logger.error('Calendar update error: ' + e.message)
    next(e)
  }
})

// 检查是否需要更新校历（不实际更新）
router.get('/check-calendar', async (req, res, next) => {
  try {
    const { findLatestCalendar } = require('../services/calendarUpdater')
    const latest = await findLatestCalendar()
    const currentWeek = getCurrentWeek()
    res.json({
      currentWeek,
      needUpdate: currentWeek >= 18,
      latestCalendar: latest ? latest.title : null,
      latestDate: latest ? latest.date : null
    })
  } catch (e) {
    next(e)
  }
})

// 手动设置第1周周一基准日期
router.post('/set-start-date', async (req, res, next) => {
  try {
    const { date } = req.body  // 格式: "2026-03-09"
    if (!date) return res.status(400).json({ error: '缺少日期参数' })

    // 验证日期格式
    const parsed = new Date(date + 'T00:00:00+08:00')
    if (isNaN(parsed.getTime())) return res.status(400).json({ error: '日期格式无效，请使用 YYYY-MM-DD' })

    // 验证是否为周一
    if (parsed.getDay() !== 1) {
      return res.status(400).json({
        error: `该日期是周${['日','一','二','三','四','五','六'][parsed.getDay()]}，请选择周一`,
        dayOfWeek: parsed.getDay()
      })
    }

    const y = parsed.getFullYear()
    const m = parsed.getMonth()
    const d = parsed.getDate()
    const jsDateStr = `new Date(${y}, ${m}, ${d})`

    // 更新服务端 week.js
    const fs = require('fs')
    const path = require('path')
    const serverWeekPath = path.join(__dirname, '..', 'utils', 'week.js')
    let content = fs.readFileSync(serverWeekPath, 'utf-8')
    content = content.replace(
      /const WEEK1_START = new Date\(\d+,\s*\d+,\s*\d+\)/,
      `const WEEK1_START = ${jsDateStr}`
    )
    fs.writeFileSync(serverWeekPath, content, 'utf-8')
    logger.info(`[Week] Updated server WEEK1_START to ${jsDateStr}`)

    // 尝试更新小程序端 week.js
    const miniWeekPath = path.join(__dirname, '..', '..', 'miniprogram', 'utils', 'week.js')
    if (fs.existsSync(miniWeekPath)) {
      let miniContent = fs.readFileSync(miniWeekPath, 'utf-8')
      miniContent = miniContent.replace(
        /const WEEK1_START = new Date\(\d+,\s*\d+,\s*\d+\)/,
        `const WEEK1_START = ${jsDateStr}`
      )
      fs.writeFileSync(miniWeekPath, miniContent, 'utf-8')
      logger.info(`[Week] Updated miniprogram WEEK1_START to ${jsDateStr}`)
    }

    // 清除 require 缓存，让新值立即生效
    delete require.cache[require.resolve('../utils/week')]
    const { getCurrentWeek: getWeekNew, getWeekType: getTypeNew, getWeekRange: getRangeNew } = require('../utils/week')

    res.json({
      success: true,
      newDate: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      currentWeek: getWeekNew(),
      type: getTypeNew(getWeekNew()),
      weekRange: getRangeNew(getWeekNew())
    })
  } catch (e) {
    logger.error('Set start date error: ' + e.message)
    next(e)
  }
})

module.exports = router
