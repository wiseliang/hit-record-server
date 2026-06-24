// ⚠️ 全局兜底必须在最前面 — 防止任何未处理异常杀死进程
process.on('unhandledRejection', (reason) => {
  console.error('UnhandledRejection:', reason?.message || reason, reason?.stack)
})
process.on('uncaughtException', (err) => {
  console.error('UncaughtException:', err.message, err.stack)
})

// GC every 5min to prevent memory leaks (requires --expose-gc)
if (global.gc) { setInterval(() => { global.gc() }, 300000) }

const express = require('express')
console.log('[startup] express loaded')

const config = require('./config')
console.log('[startup] config loaded, port=' + config.port)

const errorHandler = require('./middleware/error')
const logger = require('./utils/logger')

const app = express()

app.use(express.json())

// CORS - 允许小程序请求
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-openid')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

// 路由
app.use('/api/week', require('./routes/week'))
app.use('/api/auth', require('./routes/auth'))
app.use('/api/task', require('./routes/task'))
app.use('/api/history', require('./routes/history'))
app.use('/api/grade', require('./routes/grade'))

// 健康检查（含内存信息，便于运维监控）
app.get('/api/health', (req, res) => {
  const mem = process.memoryUsage()
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    memory: {
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
      external: Math.round(mem.external / 1024 / 1024) + 'MB'
    }
  })
})

// 全局错误处理
app.use(errorHandler)

// 记录信号来源但不退出 — 用于排查谁在发 SIGINT
process.on('SIGINT', () => {
  const mem = process.memoryUsage()
  logger.info(`SIGINT received — IGNORED. pid=${process.pid}, ppid=${process.ppid}, heap=${Math.round(mem.heapUsed/1024/1024)}MB, rss=${Math.round(mem.rss/1024/1024)}MB, uptime=${Math.round(process.uptime())}s`)
  console.error(`[SIGINT] pid=${process.pid}, ppid=${process.ppid}, uptime=${Math.round(process.uptime())}s — IGNORED`)
})
process.on('SIGTERM', () => {
  logger.info(`SIGTERM received — IGNORED. pid=${process.pid}, uptime=${Math.round(process.uptime())}s`)
  console.error(`[SIGTERM] pid=${process.pid}, uptime=${Math.round(process.uptime())}s — IGNORED`)
})

app.listen(config.port, () => {
  logger.info(`Server started on port ${config.port}, pid=${process.pid}, cwd=${process.cwd()}`)
  const mem = process.memoryUsage()
  logger.info(`Startup memory: heap=${Math.round(mem.heapUsed/1024/1024)}MB, rss=${Math.round(mem.rss/1024/1024)}MB`)
})

module.exports = app
