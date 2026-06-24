/**
 * 校历更新服务
 * 从 jwc.hitwh.edu.cn 抓取最新校历 PDF，解析第1周周一日期
 * 更新 server/utils/week.js 和 miniprogram/utils/week.js 中的 WEEK1_START
 */
const axios = require('axios')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const logger = require('../utils/logger')

const CALENDAR_LIST_URL = 'https://jwc.hitwh.edu.cn/xlxz/list.htm'
const WEEK_JS_SERVER = path.join(__dirname, '..', 'utils', 'week.js')
const WEEK_JS_MINI = path.join(__dirname, '..', '..', 'miniprogram', 'utils', 'week.js')
const TEMP_DIR = '/tmp'

// 月份中文名到数字的映射
const MONTH_MAP = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6,
  '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12
}

/**
 * 主入口：检查并更新校历
 * @returns {{ updated: boolean, newDate: string|null, title: string|null, message: string }}
 */
async function updateCalendarIfNeeded() {
  logger.info('[CalendarUpdater] Checking academic calendar...')

  // Step 1: 获取校历列表，找到最新的
  const calendarUrl = await findLatestCalendar()
  if (!calendarUrl) {
    return { updated: false, message: '未找到校历列表' }
  }
  logger.info(`[CalendarUpdater] Latest calendar: ${calendarUrl.title} -> ${calendarUrl.url}`)

  // Step 2: 下载并解析 PDF
  const week1Date = await parseCalendarPDF(calendarUrl.url, calendarUrl.title)
  if (!week1Date) {
    return { updated: false, message: 'PDF解析失败，未能提取第1周日期' }
  }
  logger.info(`[CalendarUpdater] Parsed Week 1 Monday: ${week1Date.toISOString().slice(0, 10)}`)

  // Step 3: 检查是否需要更新
  const { getCurrentWeek } = require('../utils/week')
  const currentWeek = getCurrentWeek()
  const needUpdate = currentWeek >= 18 // 接近学期末时提醒

  // Step 4: 更新 week.js 文件
  const newDateStr = `${week1Date.getFullYear()}-${week1Date.getMonth() + 1}-${week1Date.getDate()}`
  const jsDateStr = `new Date(${week1Date.getFullYear()}, ${week1Date.getMonth()}, ${week1Date.getDate()})`

  updateWeekFile(WEEK_JS_SERVER, jsDateStr)
  if (fs.existsSync(WEEK_JS_MINI)) {
    updateWeekFile(WEEK_JS_MINI, jsDateStr)
  }

  return {
    updated: true,
    newDate: newDateStr,
    title: calendarUrl.title,
    currentWeek,
    needUpdate,
    message: `校历已更新：${calendarUrl.title}，第1周周一 = ${newDateStr}`
  }
}

/**
 * 从校历列表页找到最新的校历链接
 */
async function findLatestCalendar() {
  try {
    const response = await axios.get(CALENDAR_LIST_URL, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    const html = response.data

    // 解析列表项。HTML 格式（有嵌套 a 标签）：
    // <li><span>2026-03-09</span><a href="..."><a href='...' title='2025-2026学年春夏季学期校历'>
    const items = []
    // 匹配 <li> 中的 <span>日期</span> 和紧跟着的 title='校历名'
    const liRegex = /<li>\s*<span>([^<]+)<\/span>.*?title=['"]([^'"]*校历[^'"]*)['"]/g
    let match
    while ((match = liRegex.exec(html)) !== null) {
      // 提取 href：找 title 前面的 href=['"]([^'"]+)['"]
      const titlePos = match.index + match[0].indexOf(match[2])
      const beforeTitle = html.substring(Math.max(0, titlePos - 200), titlePos)
      const hrefMatch = beforeTitle.match(/href=['"]([^'"]+)['"]/)
      const href = hrefMatch ? hrefMatch[1] : ''

      items.push({
        date: match[1].trim(),
        url: href.startsWith('http') ? href : `https://jwc.hitwh.edu.cn${href}`,
        title: match[2].trim()
      })
    }

    if (items.length === 0) return null

    // 第一个就是最新的
    return items[0]
  } catch (e) {
    logger.error('[CalendarUpdater] Failed to fetch calendar list: ' + e.message)
    return null
  }
}

/**
 * 下载校历 PDF 并解析，提取春季学期第1周周一的日期
 */
async function parseCalendarPDF(pageUrl, title) {
  const pdfPath = path.join(TEMP_DIR, 'calendar_latest.pdf')
  const txtPath = path.join(TEMP_DIR, 'calendar_latest.txt')

  try {
    // Step 1: 从页面中提取 PDF 链接
    const pageResp = await axios.get(pageUrl, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    const pdfMatch = pageResp.data.match(/pdfsrc="([^"]+)"/)
    if (!pdfMatch) {
      logger.error('[CalendarUpdater] No PDF link found on page')
      return null
    }
    const pdfUrl = pdfMatch[1].startsWith('http') ? pdfMatch[1] : `https://jwc.hitwh.edu.cn${pdfMatch[1]}`

    // Step 2: 下载 PDF
    const pdfResp = await axios.get(pdfUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    fs.writeFileSync(pdfPath, pdfResp.data)
    logger.info(`[CalendarUpdater] PDF downloaded: ${pdfResp.data.length} bytes`)

    // Step 3: 用 pdftotext 提取文本
    execSync(`pdftotext -layout ${pdfPath} ${txtPath}`, { timeout: 10000 })
    const text = fs.readFileSync(txtPath, 'utf-8')
    const lines = text.split('\n').map(l => l.trim())

    // Step 4: 解析表格，提取春季学期第1周周一日期
    const week1Date = extractWeek1Monday(lines, title)

    // 清理临时文件
    try { fs.unlinkSync(pdfPath) } catch (_) {}
    try { fs.unlinkSync(txtPath) } catch (_) {}

    return week1Date
  } catch (e) {
    logger.error('[CalendarUpdater] PDF parse error: ' + e.message)
    // 清理
    try { fs.unlinkSync(pdfPath) } catch (_) {}
    try { fs.unlinkSync(txtPath) } catch (_) {}
    return null
  }
}

/**
 * 从 PDF 文本中提取春季学期第1周周一日期
 *
 * PDF 表格格式：
 *   周次  月  一  二  三  四  五  六  日
 *    1        9  10  11  12  13  14  15
 *          2026三月
 */
function extractWeek1Monday(lines, title) {
  // 方法1（最可靠）：查找 "春季学期开始" 行
  // PDF 最后几行通常有："2026年3月9日                                 春季学期开始"
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const startMatch = line.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日.*春季学期开始/)
    if (startMatch) {
      const y = parseInt(startMatch[1])
      const m = parseInt(startMatch[2])
      const d = parseInt(startMatch[3])
      logger.info(`[CalendarUpdater] Found spring start: ${y}-${m}-${d}`)
      return new Date(y, m - 1, d)
    }
  }

  // 方法2：解析周次表格
  // 表格格式：周次 月 一 二 三 四 五 六 日
  // 第1周的那行：  1   9  10  11  12  13  14  15
  // 月份行：例如 "2026三月" 出现在第2-3周附近
  let year = null
  let month = null
  const yearMatch = title.match(/(\d{4})-(\d{4})/)
  const isSpring = title.includes('春')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 检测年份+月份
    const ymMatch = line.match(/(\d{4})\s*年?\s*([一二三四五六七八九十]+)月?/)
    if (ymMatch) {
      year = parseInt(ymMatch[1])
      const mStr = ymMatch[2]
      if (MONTH_MAP[mStr]) month = MONTH_MAP[mStr]
      else if (mStr.length >= 2 && MONTH_MAP[mStr[0]] === 10) month = 10 + (MONTH_MAP[mStr[1]] || 0)
      continue
    }

    // 检测周次行
    const weekRow = line.match(/^\s*(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})/)
    if (weekRow) {
      const weekNum = parseInt(weekRow[1])
      const mon = parseInt(weekRow[2])

      // 春夏季学期第1周：周次=1，月份3-6，且周一日期合理（≥7）
      if (weekNum === 1 && mon >= 7 && mon <= 31 && month && month >= 3 && month <= 6 && year) {
        logger.info(`[CalendarUpdater] Found spring week 1: ${year}-${month}-${mon}`)
        return new Date(year, month - 1, mon)
      }
    }
  }

  return null
}

/**
 * 更新 week.js 文件中的 WEEK1_START 常量
 */
function updateWeekFile(filePath, jsDateStr) {
  try {
    let content = fs.readFileSync(filePath, 'utf-8')

    // 替换 WEEK1_START
    const regex = /const WEEK1_START = new Date\(\d+,\s*\d+,\s*\d+\)/
    const replacement = `const WEEK1_START = ${jsDateStr}`

    if (regex.test(content)) {
      content = content.replace(regex, replacement)
      fs.writeFileSync(filePath, content, 'utf-8')
      logger.info(`[CalendarUpdater] Updated ${filePath}`)
    } else {
      logger.warn(`[CalendarUpdater] WEEK1_START not found in ${filePath}`)
    }
  } catch (e) {
    logger.error(`[CalendarUpdater] Failed to update ${filePath}: ${e.message}`)
  }
}

module.exports = { updateCalendarIfNeeded, findLatestCalendar, parseCalendarPDF }
