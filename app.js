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
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-openid, Authorization')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

// 路由
app.use('/api/week', require('./routes/week'))
app.use('/api/auth', require('./routes/auth'))
app.use('/api/task', require('./middleware/auth'), require('./routes/task'))
app.use('/api/history', require('./middleware/auth'), require('./routes/history'))
app.use('/api/grade', require('./middleware/auth'), require('./routes/grade'))

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

if (require.main === module) {
  if (!config.auth.secret || Buffer.byteLength(config.auth.secret) < 32) throw new Error('AUTH_SECRET must contain at least 32 bytes')
  const server = app.listen(config.port, process.env.HOST || '127.0.0.1', () => {
    logger.info(`Server started on port ${config.port}, pid=${process.pid}`)
  })
  let stopping = false
  async function stop() {
    if (stopping) return
    stopping = true
    const timer = setTimeout(()=>process.exit(1),10000); timer.unref()
    server.close(async()=>{
      try { await require('./services/browser').shutdown(); await require('./config/database').end() }
      finally { process.exit(0) }
    })
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

module.exports = app
