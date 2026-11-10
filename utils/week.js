const fs = require('fs')
const path = require('path')
const CONFIG_FILE = process.env.SEMESTER_CONFIG_PATH || path.join(__dirname, '..', '.data', 'semester.json')
// Verified against the Weihai campus 2026 autumn opening notice.
const DEFAULT_START = '2026-08-31'
const DAY = 86400000
function parseMonday(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式无效，请使用 YYYY-MM-DD')
  const day = new Date(date + 'T00:00:00Z')
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0,10) !== date || day.getUTCDay() !== 1) throw new Error('请选择有效的周一日期')
  return day
}
function getWeekStart() {
  try {
    const date = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).startDate
    parseMonday(date)
    return date
  } catch (e) { if (e.code === 'ENOENT') return DEFAULT_START; throw e }
}
function setWeekStart(date) {
  parseMonday(date)
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 })
  const temp = CONFIG_FILE + '.' + process.pid + '.tmp'
  fs.writeFileSync(temp, JSON.stringify({ startDate: date }) + '\n', { mode: 0o600 })
  fs.renameSync(temp, CONFIG_FILE)
}
function getCurrentWeek(now = new Date()) {
  const start = new Date(getWeekStart() + 'T00:00:00+08:00')
  return Math.max(1, Math.floor((now.getTime()-start.getTime())/(7*DAY))+1)
}
function getAcademicTerm() {
  const start = parseMonday(getWeekStart())
  const year = start.getUTCFullYear(), month = start.getUTCMonth()+1
  const semester = month >= 8 ? '秋季' : month === 7 ? '夏季' : '春季'
  const firstYear = semester === '秋季' ? year : year-1
  return { academicYear: `${firstYear}—${firstYear+1}`, semester }
}
function getWeekType(week) { return week % 2 === 1 ? 'companion' : 'talk' }
function getBaseDate(week) {
  if (!Number.isInteger(week) || week < 1) throw new Error('无效周次')
  const date = parseMonday(getWeekStart())
  date.setUTCDate(date.getUTCDate()+(week-1)*7)
  // Return a calendar date in the host timezone for existing form automation.
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}
function getWeekRange(week) {
  const date = parseMonday(getWeekStart())
  date.setUTCDate(date.getUTCDate()+(week-1)*7)
  const fmt=d=>String(d.getUTCMonth()+1).padStart(2,'0')+'/'+String(d.getUTCDate()).padStart(2,'0')
  const from=fmt(date);date.setUTCDate(date.getUTCDate()+6)
  return from+'-'+fmt(date)
}
module.exports = {getCurrentWeek,getWeekType,getWeekRange,getBaseDate,getWeekStart,setWeekStart,getAcademicTerm}
Object.defineProperty(module.exports, 'WEEK1_START', {get:()=>getBaseDate(1)})
