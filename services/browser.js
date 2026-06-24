const { chromium } = require('playwright')
const logger = require('../utils/logger')

// CDP 模式：连到外部手动启动的 Chrome，避免 navigator.webdriver 标记
// 服务器上先启动: ./start-chrome.sh
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const USE_CDP = process.env.CDP_URL || process.env.USE_CDP === 'true'

// 并发配置（2核2G服务器优化：降低并发数减少内存压力）
const MAX_CONTEXTS = 3        // 最多同时 3 个用户
const IDLE_SHUTDOWN_MS = 60000 // 空闲 60 秒关闭浏览器释放内存（原120s→60s），仅 launch 模式

let browser = null
let cdpConnected = false     // CDP 模式下不关闭浏览器
const contexts = []           // 空闲上下文池 { context, inUse, pages }
const waitQueue = []          // 等待队列 [{ resolve }]
let idleTimer = null

async function launch() {
  // 检查已有 browser 是否还活着
  if (browser) {
    try {
      // CDP 模式：通过 version 请求检查连通性
      if (cdpConnected) {
        await browser.newContext().then(ctx => ctx.close())
      }
      return // browser 正常
    } catch (_) {
      logger.warn('Browser connection lost, reconnecting...')
      browser = null
      cdpConnected = false
      contexts.length = 0
    }
  }

  if (USE_CDP) {
    // === CDP 模式：连到外部 Chrome ===
    try {
      logger.info(`Connecting to Chrome via CDP: ${CDP_URL}`)
      browser = await chromium.connectOverCDP(CDP_URL)
      cdpConnected = true
      logger.info('CDP connected — using externally managed Chrome (no webdriver flag)')
      return
    } catch (e) {
      logger.warn(`CDP connection failed: ${e.message}, falling back to chromium.launch()`)
      // fall through to launch mode
    }
  }

  // === Launch 模式：Playwright 自己启动 Chromium ===
  logger.info('Launching headless Chrome...')
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-sync',
      '--no-zygote',
      '--single-process',
      '--max-old-space-size=256',
      '--disable-features=site-per-process,TranslateUI,VizDisplayCompositor',
      '--disable-software-rasterizer',
      '--disable-smooth-scrolling',
      '--disable-default-apps',
      '--disable-translate',
      '--disable-background-networking',
      '--disable-hang-monitor',
      '--disable-prompt-on-repost',
      '--disable-client-side-phishing-detection',
      '--disable-component-update',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--disable-low-res-tiling',
      '--blink-settings=primaryHoverType=2,availableHoverTypes=2',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling'
    ]
  })
  logger.info('Chrome launched')
}

async function createContext() {
  return await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  })
}

// 获取一个可用的上下文（带重连）
async function acquireContext() {
  clearIdleTimer()

  // 尝试启动/连接，失败时重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await launch()
      break
    } catch (e) {
      if (attempt === 1) throw e
      logger.warn(`Launch failed, retrying: ${e.message}`)
      browser = null
      cdpConnected = false
      contexts.length = 0
      await new Promise(r => setTimeout(r, 2000))
    }
  }

  // 找空闲上下文
  const free = contexts.find(c => !c.inUse)
  if (free) {
    free.inUse = true
    const page = await free.context.newPage()
    free.pages.push(page)
    logger.info(`Reusing context, ${contexts.filter(c=>c.inUse).length}/${MAX_CONTEXTS} active`)
    return { slot: free, page }
  }

  // 创建新上下文（未达上限）
  if (contexts.length < MAX_CONTEXTS) {
    const ctx = await createContext()
    const slot = { context: ctx, inUse: true, pages: [] }
    contexts.push(slot)
    const page = await ctx.newPage()
    slot.pages.push(page)
    logger.info(`New context created, ${contexts.filter(c=>c.inUse).length}/${MAX_CONTEXTS} active`)
    return { slot, page }
  }

  // 到达上限，排队等待（最多60秒超时）
  logger.info(`All ${MAX_CONTEXTS} contexts busy, queuing...`)
  return new Promise((resolve, reject) => {
    const wrappedResolve = (value) => {
      clearTimeout(timeoutId)
      resolve(value)
    }
    const timeoutId = setTimeout(() => {
      const idx = waitQueue.indexOf(wrappedResolve)
      if (idx >= 0) waitQueue.splice(idx, 1)
      reject(new Error('系统繁忙，请稍后重试（排队超过60秒）'))
    }, 60000)
    waitQueue.push(wrappedResolve)
  })
}

// 释放上下文（关闭所有页面但保留上下文）
async function releaseContext(slot, keepPage = null) {
  // 关闭不需要的页面
  for (const p of slot.pages) {
    if (p !== keepPage && !p.isClosed()) {
      try { await p.close() } catch (_) {}
    }
  }
  slot.pages = keepPage && !keepPage.isClosed() ? [keepPage] : []
  slot.inUse = false

  // 通知等待队列
  if (waitQueue.length > 0) {
    const next = waitQueue.shift()
    const freeSlot = contexts.find(c => !c.inUse)
    if (freeSlot) {
      freeSlot.inUse = true
      const page = await freeSlot.context.newPage()
      freeSlot.pages.push(page)
      next({ slot: freeSlot, page })
      return
    }
  }

  // 检查是否所有上下文都空闲（CDP 模式不关闭浏览器）
  if (!cdpConnected && contexts.every(c => !c.inUse)) {
    scheduleIdleShutdown()
  }
}

// 保留指定页面，关闭该上下文中的其他页面
async function keepOnly(slot, page) {
  for (const p of slot.pages) {
    if (p !== page && !p.isClosed()) {
      try { await p.close() } catch (_) {}
    }
  }
  slot.pages = [page]
}

async function withContext(fn) {
  const { slot, page } = await acquireContext()
  try {
    return await fn(page, slot)
  } finally {
    await releaseContext(slot)
  }
}

function scheduleIdleShutdown() {
  clearIdleTimer()
  idleTimer = setTimeout(async () => {
    logger.info('All contexts idle, shutting down browser to free memory...')
    await shutdown()
  }, IDLE_SHUTDOWN_MS)
}

function clearIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
}

async function shutdown() {
  clearIdleTimer()
  if (browser && !cdpConnected) {
    try { await browser.close() } catch (_) {}
    browser = null
    contexts.length = 0
    logger.info('Browser closed, all memory freed')
  }
}

function activeCount() {
  return contexts.filter(c => c.inUse).length
}

function queueLength() {
  return waitQueue.length
}

module.exports = { acquireContext, releaseContext, keepOnly, withContext, activeCount, queueLength, shutdown }
