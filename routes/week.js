const express = require('express')
const router = express.Router()
const { getCurrentWeek, getWeekType, getWeekRange, getWeekStart, setWeekStart, getAcademicTerm, getWeekInfo } = require('../utils/week')
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
    ...getWeekInfo(),
    startDate: getWeekStart(),
    ...getAcademicTerm(),
    week,
    type,
    typeName: info.name,
    typeTag: info.tag,
    weekRange: getWeekRange(week),
    isOdd: week % 2 === 1
  })
})

// Global semester changes require an authenticated administrator.
router.use((req, res, next) => {
  if (req.method === 'GET') return next()
  require('../middleware/auth')(req, res, () => {
    if (!require('../config').auth.adminOpenids.includes(req.openid)) return res.status(403).json({ error: '仅管理员可修改学期基准' })
    next()
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

    try { setWeekStart(date) } catch (e) {
      if (/日期|周一/.test(e.message)) return res.status(400).json({ error: e.message })
      throw e
    }
    const week = getCurrentWeek()
    res.json({ success: true, newDate: getWeekStart(), currentWeek: week, type: getWeekType(week), weekRange: getWeekRange(week) })
  } catch (e) {
    logger.error('Set start date error: ' + e.message)
    next(e)
  }
})

module.exports = router
