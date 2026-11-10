const logger = require('../utils/logger')

const sleep = ms => new Promise(r => setTimeout(r, ms))

const pendingLogins = new (require('./sessionStore').SessionStore)({ttlMs:5*60*1000,onExpire:async s=>require('./browser').releaseContext(s.slot)}) // openid -> { slot, page, studentId, password }

// 检查是否在学工系统（按域名判断，避免 URL 参数中的 xuegong 误判）
function isOnXuegong(url) {
  try {
    const u = new URL(url)
    return u.hostname === 'xuegong.hitwh.edu.cn' && !u.pathname.includes('login') && !u.pathname.endsWith('/cas') && !u.pathname.includes('casLogin')
  } catch (_) {
    return url.includes('xuegong.hitwh.edu.cn') && !url.includes('/login') && !url.includes('/cas') && !url.includes('casLogin')
  }
}

function isOnAuthserver(url) {
  return url.includes('ids.hit.edu.cn') || url.includes('authserver')
}

function isOnMfa(url) {
  return url.includes('reAuth') || url.includes('multifactor')
}

async function startLogin(page, studentId, password) {
  logger.info('Starting login to xuegong system...')

  // 带 502 重试的页面导航
  for (let attempt = 0; attempt < 3; attempt++) {
    let response
    try {
      response = await page.goto('https://xuegong.hitwh.edu.cn/login?jg=x&url=x', {
        waitUntil: 'domcontentloaded', timeout: 20000
      })
    } catch (e) {
      logger.warn(`page.goto failed (attempt ${attempt + 1}/3): ${e.message}`)
      if (attempt < 2) { await sleep(3000); continue }
      throw e
    }

    // 检测 502/503 — 先看 HTTP 状态码，再看页面文本
    const status = response ? response.status() : 0
    const is5xx = status >= 500
    let is502Body = false
    if (!is5xx) {
      try {
        const body = await page.evaluate(() => (document.body?.innerText || '').substring(0, 200))
        is502Body = body.includes('502') || body.includes('Bad Gateway') || body.includes('503')
      } catch (_) {}
    }

    if (!is5xx && !is502Body) {
      logger.info(`Xuegong page loaded OK (status=${status})`)
      break
    }

    logger.warn(`Bad response on xuegong login (status=${status}, body502=${is502Body}), attempt ${attempt + 1}/3`)
    if (attempt < 2) await sleep(3000)
    else throw new Error(`学工系统返回 ${status || '502'}，请稍后重试`)
  }

  // 检查已登录
  const currentUrl = page.url()
  const alreadyLoggedIn = await page.evaluate(() => !document.getElementById('xg_login_tysfrz_btn'))
  if (alreadyLoggedIn && isOnXuegong(currentUrl)) {
    logger.info('Already logged in')
    return { needsCode: false, message: '已登录，无需验证码' }
  }

  // SSO
  const hasBtn = await page.evaluate(() => {
    const btn = document.getElementById('xg_login_tysfrz_btn')
    if (btn) { btn.click(); return true }
    return false
  })
  if (!hasBtn) throw new Error('未找到统一身份认证登录按钮')

  // 等待跳转：可能去 authserver，也可能直接 CAS 回 xuegong
  await sleep(5000)
  let afterSsoUrl = page.url()
  logger.info('After SSO URL: ' + afterSsoUrl.substring(0, 100))

  // 如果 CAS 直接跳回了 xuegong，说明已有有效 session
  if (isOnXuegong(afterSsoUrl)) {
    await sleep(2000)
    logger.info('CAS auto-login successful, no credentials needed')
    return { needsCode: false, message: '已登录，无需验证码' }
  }

  // 先检查是否已在 MFA 页面（reAuth），跳过 credential 填写
  const isMfa = afterSsoUrl.includes('reAuth') || afterSsoUrl.includes('multifactor')
  if (isMfa) {
    logger.info('Already on MFA page')
    await page.evaluate(() => {
      const btn = document.getElementById('getDynamicCode') ||
        Array.from(document.querySelectorAll('button')).find(b =>
          b.offsetParent && (b.textContent.includes('获取验证码') || b.textContent.includes('Send')))
      if (btn) btn.click()
    })
    await sleep(1500)
    return { needsCode: true, message: '已发送验证码，请在 HIT APP 中查看' }
  }

  // 在 authserver 页面：调用共享登录函数（先填凭证，后检测 captcha/MFA）
  if (isOnAuthserver(afterSsoUrl)) {
    logger.info('On authserver, delegating to performAuthserverLogin')
    const result = await performAuthserverLogin(page, studentId, password)

    // 登录失败 — 将截图返回给前端
    if (result.loginFailed) {
      return result
    }

    // 如果登录成功且跳转回了学工系统，保存 cookies
    if (!result.needsCode && !result.needsCaptcha) {
      const currentUrl = page.url()
      if (isOnXuegong(currentUrl)) {
        logger.info('Login successful, back on xuegong')
        await closeTrustDialog(page)
        return { needsCode: false, message: '登录成功' }
      }
    }

    return result
  }

  // 不在 authserver 也不在 xuegong → 未知状态
  logger.info('Login flow completed, URL: ' + page.url().substring(0, 100))
  return { needsCode: false, message: '登录完成' }
}

async function submitCode(page, code) {
  logger.info('Submitting MFA verification code...')

  await sleep(1000)

  const codeInput = await page.$('#dynamicCode') || await page.$('#code') || await page.$('[name="code"]')
  if (!codeInput) {
    const diag = await page.evaluate(() => ({
      url: location.href.substring(0, 100),
      inputIds: Array.from(document.querySelectorAll('input')).map(i => i.id).filter(Boolean)
    }))
    logger.error('Code input not found', diag)
    throw new Error('未找到验证码输入框')
  }

  await codeInput.fill(code)
  await sleep(500)

  // 点击登录（中: 登录, 英: Sign in）
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button')
    for (const b of btns) {
      const txt = (b.textContent || '').trim()
      if (b.offsetParent !== null && (txt === '登录' || txt === 'Sign in')) {
        b.click(); return
      }
    }
  })
  await sleep(3000)

  // 信任弹窗 — 优先信任此设备（避免后续重复 MFA）
  // 注意：点击信任按钮后页面可能立即跳转，需要捕获执行上下文销毁的错误
  for (let i = 0; i < 3; i++) {
    try {
      const clicked = await page.evaluate(() => {
        const btns = document.querySelectorAll('button')
        const preferred = ['信任此设备', 'Trust this device', '信任', 'Trust']
        const fallback = ['仅本次登录', 'Login this time only']
        const all = [...preferred, ...fallback]
        for (const target of all) {
          for (const b of btns) {
            const txt = (b.textContent || '').trim()
            if (b.offsetParent !== null && txt === target) {
              b.click(); return txt
            }
          }
        }
        return null
      })
      if (clicked) {
        logger.info('Trust dialog handled: ' + clicked)
        await sleep(1500)
        // 检查是否已经跳转回学工系统
        try {
          const u = page.url()
          if (isOnXuegong(u)) {
            logger.info('Already redirected to xuegong after trust dialog')
            break
          }
        } catch (_) { break }
      }
    } catch (e) {
      // 页面已跳转，执行上下文销毁是正常的
      if (e.message && e.message.includes('Execution context was destroyed')) {
        logger.info('Page navigated after trust dialog (expected)')
        await sleep(2000)
        break
      }
      logger.warn('Trust dialog error: ' + e.message)
      break
    }
  }

  // 再次点登录（以防信任弹窗后需要重新确认）
  // 如果页面已跳转，跳过这步
  try {
    const u = page.url()
    if (isOnAuthserver(u)) {
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button')
        for (const b of btns) {
          const txt = (b.textContent || '').trim()
          if (b.offsetParent !== null && (txt === '登录' || txt === 'Sign in')) {
            b.click(); return
          }
        }
      })
      await sleep(2000)
    }
  } catch (e) {
    // 页面可能已跳转
    logger.info('Second login click skipped (page navigated): ' + e.message)
  }

  // 等待跳转回学工系统
  try {
    // 先检查是否已在学工系统
    const beforeWait = page.url()
    if (!isOnXuegong(beforeWait)) {
      await page.waitForURL(url => isOnXuegong(url), { timeout: 20000 })
    }
  } catch (_) {
    const currentUrl = page.url()
    // 如果已经在学工系统，不算失败
    if (!isOnXuegong(currentUrl)) {
      logger.error('Timeout waiting for xuegong redirect, URL: ' + currentUrl)
      throw new (require('../utils/errors').AppError)(400,'SCHOOL_CODE_REJECTED','学校未接受本次验证码，请检查后重试；超时请重新发送或重新登录')
    }
    logger.info('Already on xuegong (waitForURL timeout was due to completed navigation)')
  }

  await sleep(2000)
  await closeTrustDialog(page)

  logger.info('MFA verification successful')
  return { success: true }
}

async function submitCaptcha(page, captchaText, studentId, password) {
  logger.info('Submitting captcha...')

  // 重新填凭证（确保所有字段就绪）
  try {
    const hasUser = await page.$('#username')
    if (hasUser) {
      await page.fill('#username', studentId)
      await sleep(200)
      await page.fill('#password', password)
      await sleep(200)
      // 重新 AES 加密
      await page.evaluate(() => {
        const pwd = document.getElementById('password')
        const saltInput = document.getElementById('pwdEncryptSalt')
        if (pwd && saltInput && saltInput.value && window.encryptPassword) {
          document.getElementById('saltPassword').value = window.encryptPassword(pwd.value, saltInput.value)
          pwd.disabled = true
        }
      })
      await sleep(200)
    }
  } catch (e) {
    logger.warn('Refill credentials failed: ' + e.message)
  }

  // 填验证码
  await page.fill('#captcha', captchaText)
  await sleep(300)

  // 点击登录 - 尝试多种方式
  let submitted = await page.evaluate(() => {
    // 方式1: #login_submit
    const btn = document.querySelector('#login_submit')
    if (btn) { btn.click(); return 'login_submit' }
    // 方式2: name="_eventId" value="submit"
    const eventBtn = document.querySelector('[name="_eventId"][value="submit"]')
    if (eventBtn) { eventBtn.click(); return '_eventId' }
    return null
  })

  if (!submitted) {
    // 方式3: 直接设置 _eventId 并提交 form
    await page.evaluate(() => {
      const form = document.querySelector('form#pwdFromId') || document.querySelector('form')
      if (form) {
        let eventInput = form.querySelector('input[name="_eventId"]')
        if (!eventInput) {
          eventInput = document.createElement('input')
          eventInput.type = 'hidden'
          eventInput.name = '_eventId'
          form.appendChild(eventInput)
        }
        eventInput.value = 'submit'
        form.submit()
      }
    })
    submitted = 'form submit'
  }

  logger.info('Captcha submitted via: ' + submitted)

  // 等待跳转
  await page.waitForURL(url => {
    return isOnXuegong(url) || isOnMfa(url)
  }, { timeout: 10000 }).catch(() => {})
  await sleep(2000)

  const afterUrl = page.url()
  logger.info('After captcha login URL: ' + afterUrl.substring(0, 100))

  // 检查是否又回到登录页（captcha错误）
  if (isOnAuthserver(afterUrl) && afterUrl.includes('login')) {
    // 检查是否还是 captcha
    const stillCaptcha = await page.evaluate(() => {
      const cap = document.getElementById('captcha')
      return !!(cap && cap.offsetParent !== null)
    })
    if (stillCaptcha) {
      const capBuf = await page.screenshot({ type: 'png', fullPage: false })
      const base64 = capBuf.toString('base64')
      return { retry: true, captchaImage: `data:image/png;base64,${base64}`, message: '验证码错误，请重试' }
    }
    throw new Error('登录失败，请检查工号和密码')
  }

  // 检查 MFA
  const isMfaPage = isOnMfa(afterUrl)
  const hasCodeField = await page.evaluate(() => {
    return !!(document.querySelector('#dynamicCode') || document.querySelector('#code') || document.querySelector('[name="code"]'))
  })

  if (isMfaPage || hasCodeField) {
    logger.info('MFA required after captcha')
    try {
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button, a, span')
        for (const b of btns) {
          const t = (b.textContent || '').trim()
          if (b.offsetParent !== null && (t.includes('Obtain') || t.includes('获取') || t.includes('Send'))) { b.click(); return }
        }
      })
      await sleep(1000)
    } catch (_) {}
    return { needsCode: true, message: '已发送验证码，请在 HIT APP 中查看' }
  }

  if (isOnXuegong(afterUrl)) {
    await closeTrustDialog(page)
    return { needsCode: false, message: '登录成功' }
  }

  return { needsCode: false, message: '登录完成' }
}

async function closeTrustDialog(page) {
  try {
    await page.evaluate(() => {
      document.querySelectorAll('.k-i-close, .close, .dialog-close').forEach(c => c.click())
      const btns = document.querySelectorAll('button')
      for (const b of btns) {
        const t = b.textContent || ''
        if (/关闭|取消|信任|Close|Cancel|Trust/.test(t)) { b.click(); return }
      }
    })
    await sleep(1000)
  } catch (_) {}
}

async function navigateToWorkLog(page) {
  logger.info('Navigating to work log page...')

  // 如果已经在工作日志页面（包含学生列表），直接复用，不重新打开
  const currentUrl = page.url()
  // 注意：不能匹配 zhxy-xgzs/com（CAS 回调页），必须匹配具体的工作日志路径
  if (currentUrl.includes('xg_fdygzrz/rzgl')) {
    logger.info('Already on work log page, reusing: ' + currentUrl.substring(0, 100))
    await sleep(2000)
    try { await page.waitForLoadState('networkidle', { timeout: 10000 }) } catch (_) {}
    return page
  }

  const ctx = page.context()
  const pagesBefore = ctx.pages().length

  // 直接在新标签页中打开工作日志 goUrl
  // goUrl 会处理跳转链：goUrl → redirect → 工作日志页面
  const goUrl = 'https://xuegong.hitwh.edu.cn/goUrl?url=%2Fxg_fdygzrz%2Frzgl'
  logger.info('Opening work log URL: ' + goUrl)

  const newPagePromise = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null)

  // 方式1: 用 JS 打开新窗口
  try {
    await page.evaluate((url) => {
      window.open(url, '_blank')
    }, goUrl)
    logger.info('Called window.open for goUrl')
  } catch (e) {
    logger.warn('window.open failed: ' + e.message)
  }

  // 方式2: 如果 window.open 没触发新页面，用 page.evaluate 导航
  let workPage = await newPagePromise
  if (!workPage) {
    logger.info('window.open did not create new page, trying getNewPage...')
    const np2 = ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null)
    try {
      await page.evaluate(() => {
        if (typeof getNewPage === 'function') getNewPage('xg_fdygzrz/rzgl')
      })
    } catch (_) {}
    workPage = await np2
  }

  // 方式3: 直接在 context 中创建新页面
  if (!workPage) {
    logger.info('Creating new page directly...')
    workPage = await ctx.newPage()
    await workPage.goto(goUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    logger.info('Direct page URL: ' + (await workPage.url()).substring(0, 100))
  }

  if (!workPage) {
    throw new Error('无法打开工作日志页面，请检查学工系统是否正常')
  }

  try { await workPage.waitForLoadState('domcontentloaded', { timeout: 10000 }) } catch (_) {}
  logger.info('Work page: ' + (await workPage.url()).substring(0, 100))

  // 等待 goUrl 跳转完成，遇到 502/404 等错误尝试 fallback
  let goUrlFailed = false
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    const u = await workPage.url()
    const body = await workPage.evaluate(() => document.body.innerText.substring(0, 100)).catch(() => '')

    if (body.includes('502') || body.includes('Bad Gateway')) {
      logger.warn('502 Bad Gateway on goUrl, retrying...')
      await workPage.reload().catch(() => {})
      await sleep(2000)
      continue
    }

    // goUrl 返回"页面未找到" — 跳转服务可能已变更，尝试直接导航
    if (body.includes('页面未找到') || body.includes('404') || body.includes('Not Found')) {
      logger.warn('goUrl returned page not found, trying direct navigation...')
      goUrlFailed = true
      break
    }

    if (!u.includes('/goUrl') && !u.includes('/jg/mh')) {
      // 检测是否被重定向到 SSO 登录页（session 过期）
      if (isOnAuthserver(u)) {
        logger.warn('Redirected to authserver — session expired')
        throw new Error('SESSION_EXPIRED')
      }
      logger.info('Redirect completed: ' + u.substring(0, 100))
      break
    }
    if (i % 3 === 0) logger.info('Waiting... ' + u.substring(0, 80))
  }

  // goUrl 失败时的 fallback：直接导航到已知的工作日志路径
  if (goUrlFailed) {
    logger.info('goUrl failed, trying direct URL...')
    try { await workPage.close() } catch (_) {}
    workPage = await ctx.newPage()

    // 学工系统有路径前缀 zhxy-xgzs，直接导航
    await workPage.goto('https://xuegong.hitwh.edu.cn/zhxy-xgzs//xg_fdygzrz/rzgl', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    await sleep(5000)
    const fallbackUrl = await workPage.url()
    logger.info('Fallback final URL: ' + fallbackUrl.substring(0, 100))

    // 如果仍然失败，回主页再试 goUrl
    if (fallbackUrl.includes('chrome-error') || fallbackUrl.includes('页面未找到')) {
      logger.warn('Direct URL also failed, trying main page...')
      await workPage.goto('https://xuegong.hitwh.edu.cn/jg/mh', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
      await sleep(3000)
      await workPage.evaluate(() => { window.open('https://xuegong.hitwh.edu.cn/goUrl?url=%2Fxg_fdygzrz%2Frzgl', '_self') }).catch(() => {})
      await sleep(5000)
    }
  }

  try { await workPage.waitForLoadState('networkidle', { timeout: 15000 }) } catch (_) {}
  await sleep(1000)

  const finalUrl = await workPage.url()
  logger.info('Final URL: ' + finalUrl.substring(0, 100))

  // 最终检查：是否被重定向到 SSO 登录页
  if (isOnAuthserver(finalUrl)) {
    logger.warn('navigateToWorkLog: final page is authserver, session expired')
    throw new Error('SESSION_EXPIRED')
  }

  return workPage
}

/**
 * 共享函数：在 authserver (ids.hit.edu.cn) 页面填写凭证并登录
 * 被 startLogin (录入流程) 和 performSsoLogin (成绩查询流程) 共同调用
 *
 * @returns {{ needsCode: boolean, needsCaptcha?: boolean, captchaImage?: string, message: string }}
 */
async function performAuthserverLogin(page, studentId, password) {
  logger.info('[AuthserverLogin] Filling credentials on authserver...')

  // 等待页面完全加载（authserver 是 SPA，需要等待 JS 渲染完成）
  await sleep(2000)
  try { await page.waitForLoadState('networkidle', { timeout: 10000 }) } catch (_) {}

  // 填账号密码 — 带重试，处理页面导航导致的执行上下文丢失
  let filled = false
  for (let attempt = 0; attempt < 3 && !filled; attempt++) {
    try {
      const hasUser = await page.$('#username')
      if (hasUser) {
        await page.fill('#username', studentId)
        await sleep(300)
        await page.fill('#password', password)
        await sleep(300)

        // AES 加密
        await page.evaluate(() => {
          const pwd = document.getElementById('password')
          const saltInput = document.getElementById('pwdEncryptSalt')
          if (pwd && saltInput && saltInput.value && window.encryptPassword) {
            document.getElementById('saltPassword').value = window.encryptPassword(pwd.value, saltInput.value)
            pwd.disabled = true
          }
        })
        await sleep(200)
        logger.info('Credentials filled & AES encrypted')
        filled = true
      } else {
        logger.warn('Username field #username not found on attempt ' + (attempt + 1))
        await sleep(2000)
      }
    } catch (e) {
      logger.warn(`Credential field interaction failed on attempt ${attempt + 1}`)
      if (attempt < 2) await sleep(3000)
    }
  }

  if (!filled) {
    // 截图诊断
    let diag = {}
    try {
      diag = await page.evaluate(() => ({
        url: location.href.substring(0, 200),
        title: document.title,
        bodyText: (document.body?.innerText || '').substring(0, 300),
        hasUsername: !!document.getElementById('username'),
        visibleInputs: Array.from(document.querySelectorAll('input:not([type="hidden"])'))
          .filter(i => i.offsetParent !== null)
          .map(i => ({ id: i.id, name: i.name, type: i.type }))
      }))
    } catch (_) {}
    logger.error('Failed to fill credentials after 3 attempts:', JSON.stringify(diag))
    throw new Error('无法填写登录凭证，页面可能已变更，请稍后重试')
  }

  // 检查 captcha
  const captchaVisible = await page.evaluate(() => {
    const cap = document.getElementById('captcha')
    return !!(cap && cap.offsetParent !== null)
  })
  if (captchaVisible) {
    logger.info('Captcha detected on authserver')
    const buf = await page.screenshot({ type: 'png', fullPage: false })
    return { needsCaptcha: true, captchaImage: `data:image/png;base64,${buf.toString('base64')}`, message: '请输入图片验证码' }
  }

  // 点击登录 — 与原始 startLogin 一致的逻辑
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('#login_submit')
    if (btn) { btn.click(); return true }
    return false
  })
  if (!clicked) {
    await page.evaluate(() => {
      const form = document.querySelector('.loginFromClass') || document.querySelector('form')
      if (form) form.submit()
    })
  }
  logger.info('Login submitted')

  // 等待跳转（离开 authserver 或进入 MFA）
  await page.waitForURL(url => {
    return !isOnAuthserver(url) || isOnMfa(url)
  }, { timeout: 15000 }).catch(() => {})
  await sleep(2000)

  const afterUrl = page.url()
  logger.info('After authserver login URL: ' + afterUrl.substring(0, 100))

  // MFA 检测
  const isMfaPage = isOnMfa(afterUrl)
  const hasCodeField = await page.evaluate(() => {
    return !!(document.querySelector('#dynamicCode') || document.querySelector('#code') || document.querySelector('[name="code"]'))
  })

  if (isMfaPage || hasCodeField) {
    logger.info('MFA required after authserver login')
    // 点击获取验证码
    await page.evaluate(() => {
      const btn = document.getElementById('getDynamicCode')
      if (btn && btn.offsetParent !== null) { btn.click(); return }
      const btns = document.querySelectorAll('button')
      for (const b of btns) {
        const t = (b.textContent || '').trim()
        if (b.offsetParent !== null && (t.includes('获取验证码') || t.includes('Obtain') || t.includes('Send'))) {
          b.click(); return
        }
      }
    })
    await sleep(1500)
    return { needsCode: true, message: '已发送验证码，请在 HIT APP 中查看' }
  }

  // 登录成功 — 处理信任弹窗
  await closeTrustDialog(page)

  // 如果还在 authserver，说明登录失败 — 截图返回前端让用户能看到
  if (isOnAuthserver(afterUrl)) {
    const diag = await page.evaluate(() => {
      const cap = document.getElementById('captcha')
      return {
        url: location.href.substring(0, 200),
        title: document.title,
        bodyText: (document.body?.innerText || '').substring(0, 500),
        hasCaptchaEl: !!cap,
        captchaVisible: !!(cap && cap.offsetParent !== null),
        visibleButtons: Array.from(document.querySelectorAll('button'))
          .filter(b => b.offsetParent !== null)
          .map(b => (b.textContent || '').trim().substring(0, 30)),
        visibleInputs: Array.from(document.querySelectorAll('input:not([type="hidden"])'))
          .filter(i => i.offsetParent !== null)
          .map(i => ({ id: i.id, name: i.name, type: i.type, hasValue: !!i.value }))
      }
    })
    logger.error('Authserver login failed, still on authserver:', JSON.stringify(diag))

    // 截图
    let screenshot = null
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 50, fullPage: false })
      screenshot = 'data:image/jpeg;base64,' + buf.toString('base64')
    } catch (_) {}

    return {
      loginFailed: true,
      screenshot,
      diag,
      message: `登录停留在认证页面。URL: ${diag.url}, 按钮: ${diag.visibleButtons.join(',')}`
    }
  }

  logger.info('Authserver login successful')
  return { needsCode: false, message: '登录成功' }
}

/**
 * 获取 authserver 页面上的登录二维码
 * 优先获取原始 img src，其次截取元素区域
 * 返回 { qrcode: base64_image, message: string }
 */
async function captureQrCode(page) {
  const pageUrl = page.url()
  logger.info(`[QRCode] Looking for QR code on page: ${pageUrl.substring(0, 120)}`)

  // 先确保页面是中文
  try {
    await page.evaluate(() => {
      const cnBtn = document.querySelector('.cn_btn') || document.querySelector('[class*="cn"]')
      if (cnBtn && cnBtn.offsetParent !== null) cnBtn.click()
    })
    await sleep(500)
  } catch (_) {}

  // 关闭可能的弹窗
  try {
    await page.evaluate(() => {
      document.querySelectorAll('.close, .k-i-close, [class*="close"]').forEach(c => c.click())
    })
    await sleep(500)
  } catch (_) {}

  // 策略1: 找 img 标签的原始 src（最清晰）
  const imgSrc = await page.evaluate(() => {
    const imgs = document.querySelectorAll('img')
    for (const img of imgs) {
      const src = img.src || ''
      if (img.offsetParent !== null && img.naturalWidth > 80 &&
          (src.includes('qr') || src.includes('code') || src.includes('scan') ||
           src.includes('getQrCode') || src.includes('qrcode') || src.includes('QR'))) {
        return { src, width: img.naturalWidth, height: img.naturalHeight }
      }
    }
    for (const img of imgs) {
      if (img.offsetParent !== null && img.naturalWidth > 150 && img.naturalWidth < 600 &&
          img.naturalWidth === img.naturalHeight) {
        return { src: img.src, width: img.naturalWidth, height: img.naturalHeight }
      }
    }
    return null
  })

  if (imgSrc && imgSrc.src) {
    logger.info(`[QRCode] Found QR img: ${imgSrc.width}x${imgSrc.height}, src=${imgSrc.src.substring(0, 80)}`)
    if (imgSrc.src.startsWith('data:image')) {
      return { qrcode: imgSrc.src, message: '请使用 HIT APP 扫描二维码登录' }
    }
    try {
      const base64 = await page.evaluate(async (url) => {
        const resp = await fetch(url)
        const blob = await resp.blob()
        return new Promise((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result)
          reader.readAsDataURL(blob)
        })
      }, imgSrc.src)
      return { qrcode: base64, message: '请使用 HIT APP 扫描二维码登录' }
    } catch (_) {}
  }

  // 策略2: 找 canvas / 含 QR 的元素，截取元素区域
  const qrSelector = await page.evaluate(() => {
    // 找 canvas
    const canvases = document.querySelectorAll('canvas')
    for (const c of canvases) {
      if (c.offsetParent !== null && c.width > 100 && c.height > 100) {
        c.setAttribute('data-qr-found', 'true')
        return { selector: 'canvas[data-qr-found="true"]', type: 'canvas' }
      }
    }
    // 找 QR 容器
    const qrContainers = document.querySelectorAll(
      '[class*="qr"], [id*="qr"], [class*="Qr"], [id*="Qr"], ' +
      '[class*="scan"], [class*="login_qr"], #qrLogin, .qrcode, #qrcode'
    )
    for (const el of qrContainers) {
      if (el.offsetParent !== null) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 100 && rect.height > 100) {
          el.setAttribute('data-qr-found', 'true')
          return { selector: '[data-qr-found="true"]', type: 'container' }
        }
      }
    }
    // 最后兜底：找所有方形 img
    const imgs = document.querySelectorAll('img')
    for (const img of imgs) {
      if (img.offsetParent !== null && img.naturalWidth > 100 &&
          Math.abs(img.naturalWidth - img.naturalHeight) < 10) {
        img.setAttribute('data-qr-found', 'true')
        return { selector: 'img[data-qr-found="true"]', type: 'img-element' }
      }
    }
    return null
  })

  if (qrSelector) {
    logger.info(`[QRCode] Found QR element: ${qrSelector.type}, taking element screenshot`)
    try {
      const el = await page.$(qrSelector.selector)
      if (el) {
        const buf = await el.screenshot({ type: 'png' })
        return { qrcode: 'data:image/png;base64,' + buf.toString('base64'), message: '请使用 HIT APP 扫描二维码登录' }
      }
    } catch (_) {}
  }

  logger.warn('[QRCode] No QR element found')
  return {qrcode:null,message:'未获取到学校二维码，请刷新或改用密码登录'}
}

/**
 * 等待二维码扫码登录成功（页面离开 authserver）
 * @returns { success: boolean }
 */
async function waitForQrLogin(page, timeoutMs = 120000) {
  logger.info(`[QRCode] Waiting for scan login (timeout: ${timeoutMs/1000}s)...`)

  try {
    await page.waitForURL(url => {
      return !isOnAuthserver(url) && !url.includes('ids.hit.edu.cn')
    }, { timeout: timeoutMs })
    logger.info('[QRCode] Scan login successful — page redirected: ' + page.url().substring(0, 100))
    return { success: true }
  } catch (_) {
    logger.warn('[QRCode] Scan login timeout')
    return { success: false, message: '扫码登录超时，请重试' }
  }
}

/**
 * 尝试从 session 过期中恢复 — 使用已存凭证重新登录
 * @returns {{ success: boolean, message: string }}
 */
async function recoverSession(page, openid) {
  const session = pendingLogins.get(openid)
  if (!session || !session.studentId || !session.password) {
    logger.warn(`recoverSession: no credentials for openid ${openid}`)
    return { success: false, message: '未配置凭证，无法自动恢复会话。请重新扫码登录。' }
  }

  logger.info('recoverSession: attempting re-login...')
  try {
    const result = await startLogin(page, session.studentId, session.password)
    if (result.loginFailed) {
      return { success: false, message: result.message || '自动重新登录失败' }
    }
    if (result.needsCaptcha || result.needsCode) {
      // 需要用户交互（验证码），暂存状态
      pendingLogins.set(openid, { slot: session.slot, page, studentId: session.studentId, password: session.password })
      return { success: false, needsInteraction: true, ...result, message: '会话已过期，需要重新验证' }
    }
    // 登录成功
    const workPage = await navigateToWorkLog(page)
    session.page = workPage
    pendingLogins.set(openid, session)
    logger.info('recoverSession: re-login successful')
    return { success: true, page: workPage }
  } catch (e) {
    logger.error('recoverSession failed: ' + e.message)
    return { success: false, message: '会话恢复失败: ' + e.message }
  }
}

module.exports = { startLogin, submitCode, submitCaptcha, navigateToWorkLog, pendingLogins, performAuthserverLogin, captureQrCode, waitForQrLogin, recoverSession }
