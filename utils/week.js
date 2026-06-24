const WEEK1_START = new Date(2026, 2, 9) // 2026-03-09 Monday

function getCurrentWeek() {
  const now = new Date()
  const diff = now.getTime() - WEEK1_START.getTime()
  const days = Math.floor(diff / (24 * 60 * 60 * 1000))
  return Math.max(1, Math.floor(days / 7) + 1)
}

function getWeekType(week) {
  return week % 2 === 1 ? 'companion' : 'talk'
}

function getWeekRange(week) {
  const monday = new Date(WEEK1_START)
  monday.setDate(monday.getDate() + (week - 1) * 7)
  const sunday = new Date(monday)
  sunday.setDate(sunday.getDate() + 6)
  const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
  return `${fmt(monday)}-${fmt(sunday)}`
}

function getBaseDate(week) {
  const d = new Date(WEEK1_START)
  d.setDate(d.getDate() + (week - 1) * 7)
  return d
}

module.exports = { getCurrentWeek, getWeekType, getWeekRange, getBaseDate, WEEK1_START }
