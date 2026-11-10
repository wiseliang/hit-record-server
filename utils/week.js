const fs = require('fs')
const path = require('path')
const { AsyncLocalStorage } = require('async_hooks')
const context = new AsyncLocalStorage()
const CONFIG_FILE = process.env.SEMESTER_CONFIG_PATH || path.join(__dirname, '..', '.data', 'semester.json')
const DAY = 86400000
const DEFAULT_START = '2026-08-31'
function parseMonday(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式无效，请使用 YYYY-MM-DD')
  const day = new Date(date + 'T00:00:00Z')
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0,10) !== date || day.getUTCDay() !== 1) throw new Error('请选择有效的周一日期')
  return day
}
function normalizeSemester(value) {
  const start = parseMonday(value.startDate)
  const year = start.getUTCFullYear(), month = start.getUTCMonth()+1
  const semester = value.semester || (month >= 8 ? '秋季' : month === 7 ? '夏季' : '春季')
  const firstYear = semester === '秋季' ? year : year-1
  const academicYear = value.academicYear || `${firstYear}—${firstYear+1}`
  if (!['春季','秋季','夏季'].includes(semester) || !/^\d{4}—\d{4}$/.test(academicYear)) throw new Error('学年或学期无效')
  return { ...value, startDate: value.startDate, academicYear, semester }
}
function getSemesterSnapshot() {
  if (context.getStore()) return { ...context.getStore() }
  try { return normalizeSemester(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))) }
  catch (e) { if (e.code === 'ENOENT') return normalizeSemester({ startDate: DEFAULT_START, source: 'verified_2026_autumn_default' }); throw e }
}
function setSemester(value) {
  const snapshot = normalizeSemester(value)
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 })
  const temp = CONFIG_FILE + '.' + process.pid + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(snapshot) + '\n', { mode: 0o600 })
  fs.renameSync(temp, CONFIG_FILE)
  return snapshot
}
function withSemester(snapshot, callback) { return context.run(Object.freeze(normalizeSemester(snapshot)), callback) }
function getWeekStart() { return getSemesterSnapshot().startDate }
function setWeekStart(date) { return setSemester({ startDate: date, source: 'manual' }) }
function getCurrentWeek(now = new Date()) {
  const start = new Date(getWeekStart() + 'T00:00:00+08:00')
  return Math.max(1, Math.floor((now.getTime()-start.getTime())/(7*DAY))+1)
}
function getAcademicTerm() { const { academicYear, semester } = getSemesterSnapshot(); return { academicYear, semester } }
function getWeekType(week) { return week % 2 === 1 ? 'companion' : 'talk' }
function getBaseDate(week) {
  if (!Number.isInteger(week) || week < 1) throw new Error('无效周次')
  const date = parseMonday(getWeekStart()); date.setUTCDate(date.getUTCDate()+(week-1)*7)
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}
function getWeekRange(week) {
  const date = parseMonday(getWeekStart()); date.setUTCDate(date.getUTCDate()+(week-1)*7)
  const fmt=d=>String(d.getUTCMonth()+1).padStart(2,'0')+'/'+String(d.getUTCDate()).padStart(2,'0')
  const from=fmt(date); date.setUTCDate(date.getUTCDate()+6)
  return from+'-'+fmt(date)
}
function getWeekInfo() {
  const snapshot = getSemesterSnapshot(), week = getCurrentWeek()
  return { ...snapshot, week, weekRange: getWeekRange(week), type: getWeekType(week), isOdd: week%2===1,
    weeks: Array.from({length:week},(_,i)=>({week:i+1,range:getWeekRange(i+1)})) }
}
module.exports = {getCurrentWeek,getWeekType,getWeekRange,getBaseDate,getWeekStart,setWeekStart,getAcademicTerm,getSemesterSnapshot,setSemester,withSemester,getWeekInfo}
Object.defineProperty(module.exports, 'WEEK1_START', {get:()=>getBaseDate(1)})
