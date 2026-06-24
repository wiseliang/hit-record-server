function log(level, msg, data = {}) {
  const ts = new Date().toISOString()
  const line = `[${ts}] [${level}] ${msg} ${Object.keys(data).length ? JSON.stringify(data) : ''}`
  if (level === 'ERROR') console.error(line)
  else console.log(line)
}

module.exports = {
  info: (msg, data) => log('INFO', msg, data),
  warn: (msg, data) => log('WARN', msg, data),
  error: (msg, data) => log('ERROR', msg, data)
}
