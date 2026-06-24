/**
 * 成绩查询 Playwright 自动化服务
 *
 * 自动化操作流程:
 *   hitwh.edu.cn → 数据库VPN → SSO登录 → VPN门户
 *   → 新教务平台 → SSO → 本科教学管理系统
 *   → 成绩管理 → 班主任导员成绩查询 → 筛选查询
 *   → 提取学生列表 → 逐个提取课程详情
 */

const logger = require('../utils/logger')
const fs = require('fs')
const path = require('path')
const browser = require('./browser')

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Cookie 文件（与 xuegong 分开，域名不同）
const COOKIE_FILE = path.join(__dirname, '..', 'hitwh_cookies.json')

// 等待登录的操作
const waitingLogins = new Map() // taskUuid -> { page, slot, resolve, reject }
const gradeLoginSessions = new Map() // openid -> { slot, page, step, studentId, password }

// ========== Cookie / Session 管理 ==========

function loadCookies() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'))
    }
  } catch (_) {}
  return null
}

function saveCookies(cookies) {
  try {
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2))
    logger.info('hitwh cookies saved')
  } catch (e) {
    logger.error('Failed to save hitwh cookies: ' + e.message)
  }
}

// ========== URL 判断辅助 ==========

function isOnAuthserver(url) {
  return url.includes('ids.hit.edu.cn') || url.includes('authserver')
}

function isOnHitwh(url) {
  try {
    const u = new URL(url)
    return u.hostname === 'www.hitwh.edu.cn' || u.hostname === 'i.hitwh.edu.cn'
  } catch (_) {
    return url.includes('hitwh.edu.cn')
  }
}

function isOnVpn(url) {
  return url.includes('ivpn.hitwh.edu.cn') || url.includes('i.hitwh.edu.cn') ||
         url.includes('vpn') || url.includes('portal')
}

// ========== 诊断辅助 ==========

async function diagnosePage(page, step) {
  try {
    const diag = await page.evaluate(() => ({
      url: location.href.substring(0, 200),
      title: document.title,
      bodySnippet: document.body ? document.body.innerText.substring(0, 500) : '',
      visibleButtons: Array.from(document.querySelectorAll('button'))
        .filter(b => b.offsetParent !== null)
        .map(b => ({ text: (b.textContent || '').trim().substring(0, 40), id: b.id }))
        .slice(0, 10),
      visibleLinks: Array.from(document.querySelectorAll('a'))
        .filter(a => a.offsetParent !== null && a.textContent.trim())
        .map(a => ({ text: a.textContent.trim().substring(0, 40), href: (a.href || '').substring(0, 80) }))
        .slice(0, 10),
      selects: Array.from(document.querySelectorAll('select'))
        .filter(s => s.offsetParent !== null)
        .map(s => ({
          id: s.id, name: s.name,
          options: Array.from(s.options).slice(0, 15).map(o => o.textContent.trim())
        })),
      iframes: Array.from(document.querySelectorAll('iframe')).map(f => ({
        src: (f.src || '').substring(0, 100), id: f.id, name: f.name
      }))
    }))
    logger.info(`[${step}] Page state:`, JSON.stringify(diag, null, 2).substring(0, 1000))
    return diag
  } catch (e) {
    logger.warn(`Diagnose failed at ${step}: ${e.message}`)
    return null
  }
}

// ========== 多策略点击 ==========

async function clickByText(page, texts, label) {
  for (const text of texts) {
    try {
      // 方式1: Playwright getByText
      const el = page.getByText(text, { exact: false }).first()
      if (await el.count() > 0) {
        await el.click({ timeout: 5000 })
        logger.info(`Clicked "${text}" for ${label}`)
        await sleep(2000)
        return true
      }
    } catch (_) {}
  }

  // 方式2: 自定义 JS 查找
  try {
    const found = await page.evaluate(({ texts }) => {
      for (const selector of ['a', 'button', 'span', 'div', 'li', '.menu-item', '.nav-item']) {
        for (const el of document.querySelectorAll(selector)) {
          const t = el.textContent.trim()
          for (const txt of texts) {
            if (t.includes(txt) && el.offsetParent !== null) {
              el.click(); return txt
            }
          }
        }
      }
      return null
    }, { texts })
    if (found) {
      logger.info(`JS-clicked "${found}" for ${label}`)
      await sleep(2000)
      return true
    }
  } catch (_) {}

  logger.warn(`Could not click by text: ${label} (tried: ${texts.join(', ')})`)
  return false
}

// ========== 主要的导航步骤 ==========

/**
 * Step 1: 直接打开 ivpn.hitwh.edu.cn → 自动跳转 SSO 登录页
 */
async function navigateToVpnLogin(context) {
  const page = context.pages()[0] || await context.newPage()
  logger.info('[GradeQuery] Step 1: Opening ivpn.hitwh.edu.cn')

  await page.goto('https://ivpn.hitwh.edu.cn/', {
    waitUntil: 'domcontentloaded', timeout: 30000
  })

  // 等待 SSO 重定向完成。ivpn 可能会：ivpn → SSO → CAS validate(XML) → portal
  // 需要等页面最终停在 portal（而非 XML 页面）
  for (let i = 0; i < 15; i++) {
    await sleep(2000)
    const u = page.url()
    const body = await page.evaluate(() => (document.body?.innerText || '').substring(0, 100)).catch(() => '')
    logger.info(`  ivpn nav [${(i+1)*2}s]: ${u.substring(0, 80)} body: ${body.substring(0, 50)}`)

    // XML CAS validate 页面 → 说明 CAS 验证完成，需要跳转到 portal
    if (body.includes('This XML file') || body.includes('<Auth>')) {
      logger.info('CAS validate returned XML, navigating to portal...')
      await page.goto('https://ivpn.hitwh.edu.cn/portal/', { waitUntil: 'domcontentloaded', timeout: 15000 })
      await sleep(2000)
      continue
    }

    // 已经在 portal 页面
    if (u.includes('/portal') || u.includes('#!/')) break

    // 在 SSO 页面，继续等待
    if (u.includes('ids.hit.edu.cn') || u.includes('authserver')) continue
  }

  logger.info(`After ivpn redirect URL: ${page.url().substring(0, 120)}`)
  await diagnosePage(page, 'ivpn_sso')
  return page
}

/**
 * Step 3: SSO 登录（ids.hit.edu.cn）
 * 复用 login.js 中已验证的 performAuthserverLogin 流程
 * 返回 { needsCode?, needsCaptcha?, captchaImage? }
 */
async function performSsoLogin(page, studentId, password) {
  logger.info('[GradeQuery] Step 3: SSO login')

  // 尝试恢复已保存的 cookies（跳过重复登录）
  const cookies = loadCookies()
  if (cookies && cookies.length) {
    try {
      await page.context().addCookies(cookies)
      logger.info('Restored hitwh cookies, checking if still valid...')
    } catch (_) {}
  }

  // 确保在 authserver 页面
  const currentUrl = page.url()
  if (!isOnAuthserver(currentUrl)) {
    logger.info(`Not on SSO page, current: ${currentUrl.substring(0, 100)}`)
    return { needsCode: false }
  }

  // 检测 MFA 页面（ivpn 访问需要多因子认证）
  if (currentUrl.includes('reAuth') || currentUrl.includes('multifactor')) {
    logger.info('On MFA page, clicking get-code button...')
    try {
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
    } catch (_) {}
    return { needsCode: true, message: '已发送验证码，请在 HIT APP 中查看' }
  }

  // SSO 默认是二维码模式，需要先点击"账号登录"切换到密码模式
  // 注意：如果有有效 SSO session，点"账号登录"后可能直接跳到 MFA 页面
  await sleep(1000)
  try {
    await page.evaluate(() => {
      const links = document.querySelectorAll('a')
      for (const a of links) {
        if (a.textContent.trim() === '账号登录' && a.offsetParent !== null) {
          a.click(); return true
        }
      }
      return false
    })
    await sleep(3000)
    logger.info('Clicked 账号登录, current URL: ' + page.url().substring(0, 100))
  } catch (_) {}

  // 再次检查是否跳到了 MFA 页面
  const afterClickUrl = page.url()
  if (afterClickUrl.includes('reAuth') || afterClickUrl.includes('multifactor')) {
    logger.info('Redirected to MFA after clicking 账号登录')
    try {
      await page.evaluate(() => {
        const btn = document.getElementById('getDynamicCode')
        if (btn && btn.offsetParent !== null) { btn.click(); return }
        const btns = document.querySelectorAll('button')
        for (const b of btns) {
          const t = (b.textContent || '').trim()
          if (b.offsetParent !== null && (t.includes('获取验证码') || t.includes('Obtain'))) {
            b.click(); return
          }
        }
      })
      await sleep(1500)
    } catch (_) {}
    return { needsCode: true, message: '已发送验证码，请在 HIT APP 中查看' }
  }

  // 调用共享的 authserver 登录函数（与录入流程一致）
  const { performAuthserverLogin } = require('./login')
  return await performAuthserverLogin(page, studentId, password)
}

/**
 * 提交 MFA 验证码
 */
async function submitMfaCode(page, code) {
  logger.info('[GradeQuery] Submitting MFA code')
  await sleep(1000)

  // 填验证码 - 优先 #dynamicCode，fallback 其他
  const codeInput = await page.$('#dynamicCode') || await page.$('#code') || await page.$('[name="code"]')
  if (!codeInput) {
    // JS fallback
    await page.evaluate((val) => {
      const inp = document.getElementById('dynamicCode')
      if (inp) { inp.value = val; inp.dispatchEvent(new Event('input',{bubbles:true})) }
    }, code)
  } else {
    await codeInput.fill(code)
  }
  await sleep(500)

  // 点击登录 - 优先 #reAuthSubmitBtn
  await page.evaluate(() => {
    const btn = document.getElementById('reAuthSubmitBtn')
    if (btn && btn.offsetParent !== null) { btn.click(); return }
    // fallback: 文字匹配
    const btns = document.querySelectorAll('button')
    for (const b of btns) {
      const t = (b.textContent || '').trim()
      if (b.offsetParent !== null && (t === '登录' || t === 'Sign in')) {
        b.click(); return
      }
    }
  })
  await sleep(3000)

  // 处理信任弹窗 — 优先信任此设备
  for (let i = 0; i < 5; i++) {
    try {
      const clicked = await page.evaluate(() => {
        const btns = document.querySelectorAll('button')
        const preferred = ['信任此设备', 'Trust this device', '信任', 'Trust']
        const fallback = ['仅本次登录', 'Login this time only']
        const nav = ['下一步', '确认', '关闭', 'Next']
        const all = [...preferred, ...nav, ...fallback]
        for (const target of all) {
          for (const b of btns) {
            const t = (b.textContent || '').trim()
            if (b.offsetParent !== null && t === target) {
              b.click(); return t
            }
          }
        }
        return null
      })
      if (clicked) {
        logger.info(`Trust/popup: ${clicked}`)
        await sleep(2000)
      } else {
        break
      }
    } catch (e) {
      // 页面已跳转，退出弹窗处理循环
      if (e.message.includes('Execution context was destroyed')) {
        logger.info('Page navigated, stopping popup handling')
        break
      }
      throw e
    }
  }

  // 等待跳转离开authserver（即使已跳转也安全）
  for (let i = 0; i < 15; i++) {
    try {
      const url = page.url()
      if (!url.includes('ids.hit.edu.cn') && !url.includes('authserver')) break
    } catch (_) {}
    await sleep(2000)
  }

  const finalUrl = page.url()
  if (finalUrl.includes('ids.hit.edu.cn') || finalUrl.includes('authserver')) {
    // 检查错误信息
    try {
      const errText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '')
      if (errText.includes('验证码错误') || errText.includes('错误')) {
        throw new Error('验证码错误或已过期，请重新获取')
      }
    } catch (_) {}
    throw new Error('登录超时，请检查验证码')
  }

  await sleep(2000)

  try {
    const cookies = await page.context().cookies()
    saveCookies(cookies)
  } catch (_) {}

  logger.info('MFA verification successful, entered: ' + finalUrl.substring(0, 80))
  return { success: true }
}

async function closeTrustDialog(page) {
  try {
    for (let i = 0; i < 3; i++) {
      const clicked = await page.evaluate(() => {
        const btns = document.querySelectorAll('button')
        const preferred = ['信任此设备', 'Trust this device', '信任', 'Trust']
        const fallback = ['仅本次登录', 'Login this time only']
        for (const target of [...preferred, ...fallback]) {
          for (const b of btns) {
            const t = (b.textContent || '').trim()
            if (b.offsetParent !== null && t === target) {
              b.click(); return t
            }
          }
        }
        return null
      })
      if (!clicked) break
      logger.info(`Trust dialog: ${clicked}`)
      await sleep(1500)
    }
  } catch (_) {}
}

/**
 * Step 3: ivpn 门户 → 点击"新教务平台"
 * 必须通过 VPN 门户内的链接点击（走 VPN 隧道），不能直连内网 IP
 */
async function enterNewAcademicPlatform(page) {
  const entryUrl = page.url()
  logger.info(`[GradeQuery] Step 3 ENTER: current URL = ${entryUrl.substring(0, 120)}`)

  // 检查是否已自动跳转到教务系统
  let currentUrl = entryUrl
  if (currentUrl.includes('jwts') || currentUrl.includes('8118') || currentUrl.includes('eams')) {
    logger.info(`Already on academic platform: ${currentUrl.substring(0, 100)}`)
    const diag = await diagnosePage(page, 'platform_auto_redirect')
    diag.newPage = page
    return diag
  }

  // 还在 portal，需要找到"新教务系统"并点击
  // portal 点击才能建立 VPN 隧道，不能直接 URL 导航
  const ctx = page.context()
  const allPages = ctx.pages()
  for (const p of allPages) {
    const u = p.url()
    if (u.includes('jwts') || u.includes('8118') || u.includes('eams')) {
      logger.info(`Found existing platform tab: ${u.substring(0, 100)}`)
      const diag = await diagnosePage(p, 'platform_existing_tab')
      diag.newPage = p
      return diag
    }
  }

  await sleep(3000)
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  await sleep(2000)

  await diagnosePage(page, 'vpn_portal')

  // ===== 终极诊断：用 CDP 获取元素绑定的事件监听器 =====
  const jwElInfo = await page.evaluate(() => {
    const results = []
    // 找所有文本含"教务"的元素
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent || '').trim()
      if (t === '新教务系统' || t === '新教务平台' || (t.includes('教务') && t.length <= 6)) {
        const r = el.getBoundingClientRect()
        if (r.width < 10) continue
        // 完整属性
        const attrs = {}
        for (const a of el.attributes) attrs[a.name] = (a.value || '').substring(0, 300)
        // 祖先链（带 tag 和关键属性）
        const ancestors = []
        let p = el.parentElement
        for (let i = 0; i < 8 && p && p !== document.body; i++) {
          const pa = {}
          for (const a of p.attributes) {
            const v = (a.value || '').substring(0, 200)
            if (a.name.startsWith('ms-') || a.name.startsWith('ng-') || a.name === 'onclick' ||
                a.name === 'href' || a.name === 'target' || a.name.startsWith('data-') ||
                a.name === 'class' || a.name === 'id' || a.name === 'style') {
              pa[a.name] = v
            }
          }
          if (Object.keys(pa).length > 0) ancestors.push({ tag: p.tagName, ...pa })
          p = p.parentElement
        }
        results.push({
          tag: el.tagName,
          text: t,
          visible: !!el.offsetParent,
          x: Math.round(r.x + r.width/2),
          y: Math.round(r.y + r.height/2),
          w: Math.round(r.width),
          h: Math.round(r.height),
          attrs,
          ancestors
        })
      }
    }
    return results
  })

  logger.info(`Deep scan: ${jwElInfo.length} elements matching 教务:`)
  jwElInfo.forEach(info => {
    logger.info(`  tag=${info.tag} text="${info.text}" pos=(${info.x},${info.y}) ${info.w}x${info.h} visible=${info.visible}`)
    logger.info(`    attrs: ${JSON.stringify(info.attrs)}`)
    info.ancestors.forEach((a, i) => {
      const clone = {...a}
      delete clone.style  // too long
      logger.info(`    ancestor[${i}]: ${JSON.stringify(clone)}`)
    })
  })

  // 如果有匹配元素，用 CDP 获取事件监听器
  if (jwElInfo.length > 0) {
    try {
      const cdp = await page.context().newCDPSession(page)
      const target = jwElInfo[0]
      // 获取元素节点
      const { node } = await cdp.send('DOM.getDocument')
      // 简化：直接用 JS 检测 onclick/ms-click 属性
      logger.info(`Target element: ${target.tag}, attrs keys: ${Object.keys(target.attrs).join(',')}`)
      logger.info(`Ancestors with ms-/ng-/onclick: ${target.ancestors.filter(a => Object.keys(a).some(k => k.startsWith('ms-') || k.startsWith('ng-') || k === 'onclick')).length}`)
    } catch (e) {
      logger.warn(`CDP inspect failed: ${e.message}`)
    }
  }

  // 诊断：导出 portal 上所有可见元素
  const portalItems = await page.evaluate(() => {
    const seen = new Set(), items = []
    for (const el of document.querySelectorAll('a, li, span, div, button')) {
      if (!el.offsetParent) continue
      const t = (el.textContent || '').trim()
      if (t.length < 2 || t.length > 30 || seen.has(t)) continue
      seen.add(t)
      const r = el.getBoundingClientRect()
      if (r.width < 20 || r.height < 10) continue
      items.push({ text: t.substring(0, 30), x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), tag: el.tagName })
    }
    return items.sort((a,b) => a.y-b.y || a.x-b.x)
  })
  const jwItems = portalItems.filter(i => i.text.includes('教务'))
  logger.info(`Portal: ${portalItems.length} items total, ${jwItems.length} with 教务:`)
  jwItems.forEach(i => logger.info(`  → "${i.text}" (${i.tag}) at (${i.x},${i.y})`))

  // ===== 精确 DOM 选择器点击"新教务系统" =====
  // 结构: H3.rs-list__item__title"新教务系统" → A.rs-list__item__href
  // 框架用事件委托，需点击 A 标签而非坐标
  logger.info('Trying precise DOM click on 新教务系统...')

  // 找到包含"新教务系统"的 H3 的父级 A 标签
  let domClicked = false
  try {
    const linkEl = page.locator('a:has(h3:text("新教务系统")), a:has(*:text("新教务系统"))').first()
    if (await linkEl.count() > 0) {
      const href = await linkEl.getAttribute('href')
      const text = await linkEl.textContent()
      logger.info(`Found link via locator: href=${href}, text="${text?.substring(0, 30)}"`)

      // 方式1: Playwright click with force
      try {
        await linkEl.click({ timeout: 5000, force: true })
        logger.info('Clicked via Playwright force click')
        await sleep(4000)
        domClicked = true
      } catch (e) {
        logger.warn(`Playwright click failed: ${e.message}`)
      }

      // 方式2: JS click + 事件链
      if (!domClicked || (await page.url()).includes('portal')) {
        logger.info('Trying JS event chain on link...')
        await page.evaluate(() => {
          const h3 = Array.from(document.querySelectorAll('h3')).find(el => el.textContent.trim() === '新教务系统')
          if (h3) {
            const a = h3.closest('a') || h3.parentElement?.closest('a')
            if (a) {
              a.focus()
              a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
              a.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
              a.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
              // 也尝试点击容器
              const container = a.closest('.rs-list__item') || a.parentElement
              if (container) {
                container.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
              }
            }
          }
        })
        await sleep(3000)
        domClicked = true
      }
    }
  } catch (e) {
    logger.warn(`DOM click error: ${e.message}`)
  }

  // 检查结果
  for (const p of page.context().pages()) {
    if (p.url() !== page.url() && (p.url().includes('jwts') || p.url().includes('8118') || p.url().includes('eams'))) {
      logger.info(`New tab after DOM click: ${p.url().substring(0, 100)}`)
      await p.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
      const diag = await diagnosePage(p, 'after_jw_dom')
      diag.newPage = p
      return diag
    }
  }
  if (!(await page.url()).includes('portal')) {
    const diag = await diagnosePage(page, 'after_jw_dom')
    diag.newPage = page
    return diag
  }

  // Fallback: 用 portalItems 坐标点击（兜底）
  if (jwItems.length > 0) {
    const target = jwItems[0]
    logger.info(`Clicking portal item "${target.text}" at (${target.x}, ${target.y})`)

    // 导出该元素的所有属性用于诊断
    const elDiag = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y)
      if (!el) return { found: false }
      const attrs = {}
      for (const a of el.attributes || []) attrs[a.name] = (a.value||'').substring(0, 200)
      // 查找祖先元素上的 ms-click/ng-click
      let p = el
      const parentAttrs = []
      for (let i = 0; i < 6 && p && p !== document.body; i++) {
        const pa = {}
        for (const a of p.attributes || []) {
          if (a.name.startsWith('ms-') || a.name.startsWith('ng-') || a.name === 'onclick') {
            pa[a.name] = (a.value||'').substring(0, 200)
          }
        }
        if (Object.keys(pa).length > 0) parentAttrs.push({ tag: p.tagName, attrs: pa })
        p = p.parentElement
      }
      return { found: true, tag: el.tagName, attrs, parentAttrs }
    }, { x: target.x, y: target.y })
    logger.info(`Element at click point: ${JSON.stringify(elDiag)}`)

    // 鼠标点击
    await page.mouse.click(target.x, target.y)
    await sleep(4000)

    // 检查新标签页
    for (const p of page.context().pages()) {
      if (p.url() !== page.url() && (p.url().includes('jwts') || p.url().includes('8118') || p.url().includes('eams'))) {
        logger.info(`New tab: ${p.url().substring(0, 100)}`)
        const diag = await diagnosePage(p, 'after_jw')
        diag.newPage = p
        return diag
      }
    }
    if (!(await page.url()).includes('portal')) {
      const diag = await diagnosePage(page, 'after_jw')
      diag.newPage = page
      return diag
    }

    // 点击父元素链
    logger.info('Clicking parent chain...')
    await page.evaluate(({ x, y }) => {
      let el = document.elementFromPoint(x, y)
      for (let i = 0; i < 5 && el && el !== document.body; i++) {
        el.click()
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        el = el.parentElement
      }
    }, { x: target.x, y: target.y })
    await sleep(3000)

    for (const p of page.context().pages()) {
      if (p.url() !== page.url() && (p.url().includes('jwts') || p.url().includes('8118'))) {
        logger.info(`New tab after chain: ${p.url().substring(0, 100)}`)
        const diag = await diagnosePage(p, 'after_jw_chain')
        diag.newPage = p
        return diag
      }
    }
    if (!(await page.url()).includes('portal')) {
      const diag = await diagnosePage(page, 'after_jw_chain')
      diag.newPage = page
      return diag
    }
  }

  if (jwItems.length === 0) {
    logger.info('All portal items (first 30):')
    portalItems.slice(0, 30).forEach(i => logger.info(`  "${i.text}" at (${i.x},${i.y})`))
  }

  // 等 Avalon SPA 异步加载资源列表
  logger.info('Waiting for portal async resources to load...')
  for (let i = 0; i < 15; i++) {
    await sleep(2000)
    // 检查页面中是否有"新教务平台"文本（实际内容加载完成的信号）
    const hasJw = await page.evaluate(() => {
      return document.body.innerText.includes('新教务') ||
             document.body.innerText.includes('综合教务')
    })
    if (hasJw) {
      logger.info('Portal resources loaded (教务 links found in body text)')
      break
    }
    if (i % 3 === 2) logger.info(`Still waiting for resources... (${i*2}s)`)
  }

  let clicked = false

  // 策略1: 在搜索输入框输入"教务"触发 Avalon 搜索
  // 策略0: 用坐标点击 — 找到"新教务系统/平台"文字位置，模拟真实鼠标点击
  // 优先新教务系统，只有找不到才回落综合教务管理
  logger.info('Using coordinate click on portal resource...')
  const coords = await page.evaluate(() => {
    const targets = ['新教务系统', '新教务平台', '综合教务管理']
    for (const target of targets) {
      for (const el of document.querySelectorAll('*')) {
        if (el.textContent.trim().includes(target) && el.offsetParent !== null) {
          const rect = el.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            return { text: target, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          }
        }
      }
    }
    // 放宽：找包含关键词的任意元素
    for (const el of document.querySelectorAll('*')) {
      const t = el.textContent.trim()
      if ((t.includes('新教务系统') || t.includes('新教务平台')) && el.offsetParent !== null) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0) return { text: t.substring(0,15), x: rect.left + rect.width/2, y: rect.top + rect.height/2 }
      }
    }
    return null
  })

  if (coords) {
    logger.info(`Clicking at (${Math.round(coords.x)}, ${Math.round(coords.y)}) for "${coords.text}"`)
    await page.mouse.click(coords.x, coords.y)
    await sleep(3000)

    // Avalon 框架需要额外的事件触发：点击元素 + 祖先链
    const stillOnPortal = (await page.url()).includes('portal')
    if (stillOnPortal) {
      logger.info('Still on portal after click, triggering Avalon event chain...')
      await page.evaluate(({ x, y }) => {
        let el = document.elementFromPoint(x, y)
        if (el) {
          // 点击元素及其祖先（最多5层）
          for (let i = 0; i < 5 && el && el !== document.body; i++) {
            el.click()
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
            el.dispatchEvent(new Event('mousedown', { bubbles: true }))
            el.dispatchEvent(new Event('mouseup', { bubbles: true }))
            // 尝试触发 Avalon ms-click
            if (el.getAttribute('ms-click')) {
              try { new Function(el.getAttribute('ms-click')).call(el) } catch (_) {}
            }
            el = el.parentElement
          }
        }
      }, { x: coords.x, y: coords.y })
      await sleep(3000)
    }

    // 检查是否跳转成功
    let navSuccess = false
    for (const p of page.context().pages()) {
      if (p.url() !== page.url() && (p.url().includes('jwts') || p.url().includes('8118') || p.url().includes('eams'))) {
        logger.info(`New tab after click: ${p.url().substring(0, 100)}`)
        await p.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
        const diag = await diagnosePage(p, 'after_jw_avalon')
        diag.newPage = p
        return diag
      }
    }
    if (!(await page.url()).includes('portal')) {
      navSuccess = true
      const diag = await diagnosePage(page, 'after_jw_nav')
      diag.newPage = page
      return diag
    }

    // 没跳转成功，设 clicked=false 让后续策略继续尝试
    logger.info('Coordinate click did not navigate, continuing to next strategy...')
    clicked = navSuccess ? coords.text : false
  } else {
    logger.warn('Coordinate search found nothing! Dumping visible texts...')
    const texts = await page.evaluate(() => {
      const seen = new Set()
      return Array.from(document.querySelectorAll('*'))
        .filter(el => { const t = el.textContent.trim(); return t.length >= 2 && t.length <= 15 && el.offsetParent && el.children.length < 2 && !seen.has(t) && seen.add(t) })
        .map(el => el.textContent.trim()).slice(0, 50)
    })
    logger.warn(`Visible texts: ${JSON.stringify(texts)}`)
  }

  // 如果"新教务系统"不在当前分类视图，需要切换分类标签
  if (!clicked || coords?.text === '综合教务管理') {
    logger.info('新教务系统 not in current view, scanning categories...')
    const catItems = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('*'))
        .filter(el => {
          const t = el.textContent.trim()
          return t.length >= 2 && t.length <= 8 && el.offsetParent && el.children.length < 3 &&
            (el.tagName === 'LI' || el.tagName === 'A' ||
             /cat|tab|nav|item/i.test(el.className || '') ||
             !!el.getAttribute('ng-click') || !!el.getAttribute('ms-click'))
        })
        .map(el => el.textContent.trim())
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 15)
    })
    logger.info(`Categories: ${JSON.stringify(catItems)}`)

    for (const cat of catItems) {
      // 点击分类标签
      await page.evaluate(({ cat }) => {
        for (const el of document.querySelectorAll('*')) {
          if (el.textContent.trim() === cat && el.offsetParent && el.children.length < 3) {
            el.click(); return
          }
        }
      }, { cat })
      await sleep(2000)

      // 在新视图中搜索"新教务系统"
      const found = await page.evaluate(() => {
        for (const el of document.querySelectorAll('*')) {
          if ((el.textContent.trim() === '新教务系统' || el.textContent.trim() === '新教务平台') &&
              el.children.length <= 3 && el.offsetParent !== null) {
            const rect = el.getBoundingClientRect()
            if (rect.width > 0) return { text: el.textContent.trim(), x: rect.left + rect.width/2, y: rect.top + rect.height/2 }
          }
        }
        return null
      })
      if (found) {
        logger.info(`Found "${found.text}" in category "${cat}"`)
        await page.mouse.click(found.x, found.y)
        await sleep(5000)
        clicked = found.text
        break
      }
    }
  }

  // 策略4: Playwright 原生文本定位（最可靠）
  if (!clicked) {
    logger.info('Trying Playwright text locator...')
    try {
      const locator = page.locator('text=新教务系统').first()
      if (await locator.count() > 0) {
        await locator.click({ timeout: 5000 })
        clicked = '新教务系统 (Playwright locator)'
        logger.info('Clicked via Playwright locator')
        await sleep(5000)
      }
    } catch (e) {
      logger.warn(`Playwright locator failed: ${e.message}`)
    }
  }

  if (!clicked) {
    // 策略5: 模糊文本匹配
    logger.info('Trying fuzzy text match...')
    try {
      const texts = ['新教务', '教务系统', '教务平台', '综合教务']
      for (const t of texts) {
        const loc = page.locator(`text=${t}`).first()
        if (await loc.count() > 0) {
          await loc.click({ timeout: 3000 })
          clicked = t + ' (fuzzy)'
          logger.info(`Clicked fuzzy match: ${t}`)
          await sleep(5000)
          break
        }
      }
    } catch (e) {
      logger.warn(`Fuzzy match failed: ${e.message}`)
    }
  }

  // 策略6: 导出所有可见元素，通过位置和文本匹配
  if (!clicked) {
    logger.info('Dumping all clickable elements for diagnosis...')
    const allClickable = await page.evaluate(() => {
      const results = []
      const seen = new Set()
      // 遍历所有 a, button, 以及有 onclick 的元素
      for (const el of document.querySelectorAll('a, button, [onclick], [ng-click], [ms-click], li, span, div')) {
        if (!el.offsetParent) continue
        const text = (el.textContent || '').trim()
        if (text.length < 2 || text.length > 30 || seen.has(text)) continue
        seen.add(text)
        const rect = el.getBoundingClientRect()
        if (rect.width < 20 || rect.height < 10) continue
        results.push({
          text: text.substring(0, 30),
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          tag: el.tagName,
          href: el.href ? el.href.substring(0, 80) : ''
        })
      }
      return results.sort((a, b) => a.y - b.y || a.x - b.x)
    })

    // 找包含"教务"的元素
    const jwItems = allClickable.filter(c => c.text.includes('教务'))
    logger.info(`Found ${jwItems.length} items containing 教务:`)
    jwItems.forEach(item => {
      logger.info(`  → "${item.text}" (${item.tag}) at (${item.x},${item.y}) ${item.w}x${item.h} ${item.href}`)
    })

    if (jwItems.length > 0) {
      const target = jwItems[0]
      logger.info(`Clicking "${target.text}" at (${target.x}, ${target.y})`)
      await page.mouse.click(target.x, target.y)
      await sleep(5000)
      clicked = target.text + ' (dump)'
    }

    // 如果没找到"教务"，打印前20个元素供调试
    if (!clicked) {
      logger.info('All clickable items (first 30):')
      allClickable.slice(0, 30).forEach(item => {
        logger.info(`  "${item.text}" (${item.tag}) at (${item.x},${item.y})`)
      })
    }
  }

  if (!clicked) {
    logger.info('Coordinate click failed, trying portal search...')
    // 在搜索输入框输入"教务"
    logger.info('Typing 教务 into portal search box...')
  await page.evaluate(() => {
    // 找搜索输入框
    const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input[placeholder*="搜索"], input[placeholder*="search"]')
    for (const inp of inputs) {
      if (inp.offsetParent !== null) {
        inp.value = '教务'
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        inp.dispatchEvent(new Event('change', { bubbles: true }))
        // 尝试触发回车
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        return
      }
    }
    // 如果没找到输入框，尝试通过URL
    location.hash = '#!/service?search=教务'
  })
  await sleep(5000)

  // 搜索后扫描所有可见元素中的"新教务平台"
  // 不直接用 el.click()（可能绕过门户的事件代理），找到元素后用 Playwright 原生点击
  const elemInfo = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    let node
    while (node = walker.nextNode()) {
      const text = node.textContent.trim()
      if ((text === '新教务平台' || text === '新教务系统') && node.offsetParent !== null) {
        // 找包含此文字的容器中实际的 <a> 标签
        const container = node.closest('tr') || node.closest('div') || node.parentElement
        if (container) {
          const link = container.querySelector('a')
          if (link) {
            link.setAttribute('data-found-by-code', 'true')
            return { found: 'link', href: link.href, selector: 'a[data-found-by-code="true"]' }
          }
        }
        // 没找到 A 标签，标记文本元素自身
        node.setAttribute('data-found-by-code', 'true')
        return { found: 'text', tag: node.tagName, selector: '[data-found-by-code="true"]' }
      }
    }
    return null
  })

  if (elemInfo) {
    logger.info(`Found element: ${JSON.stringify(elemInfo)}`)
    try {
      // 用 Playwright 原生点击触发门户的 JS 事件代理
      const el = await page.$(elemInfo.selector)
      if (el) {
        await el.scrollIntoViewIfNeeded().catch(() => {})
        await sleep(500)
        await el.click({ timeout: 5000 })
        clicked = '新教务平台 (Playwright click)'
        logger.info(`Clicked via Playwright: ${clicked}`)
        await sleep(5000)
      }
    } catch (e) {
      logger.warn(`Playwright click failed: ${e.message}, trying JS click...`)
      await page.evaluate(() => {
        const el = document.querySelector('[data-found-by-code="true"]')
        if (el) {
          el.scrollIntoView()
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        }
      })
      clicked = '新教务平台 (JS event)'
      await sleep(5000)
    }
  }
  if (clicked) { logger.info(`Found via search: ${clicked}`); await sleep(5000) }
  }

  // 策略2: 如果没找到，输出所有页面可见文本用于调试
  if (!clicked) {
    const visibleTexts = await page.evaluate(() => {
      const texts = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
      let node
      while (node = walker.nextNode()) {
        if (node.children.length === 0 && node.offsetParent !== null) {
          const t = (node.textContent || '').trim()
          if (t.length >= 2 && t.length <= 15) texts.push(t)
        }
      }
      return [...new Set(texts)].slice(0, 80)
    })
    logger.info(`Portal visible texts: ${JSON.stringify(visibleTexts)}`)

    // 再搜一次模糊匹配
    clicked = await page.evaluate(() => {
      for (const el of document.querySelectorAll('a, div, span, li')) {
        const t = (el.textContent || '').trim()
        if (el.offsetParent && (t === '新教务平台' || t === '新教务系统' || t.includes('新教务') || t.includes('综合教务管理'))) {
          el.click(); return t
        }
      }
      return null
    })
    if (clicked) logger.info(`Fallback click: ${clicked}`)
  }

  if (!clicked) {
    throw new Error('在 ivpn 门户中未找到"新教务系统"链接，请检查 portal 资源列表')
  }

  // 点击后可能在当前页跳转或新标签页打开
  await sleep(3000)

  // 检测是否有新标签页打开
  const afterClickPages = page.context().pages()
  logger.info(`After click: ${afterClickPages.length} pages open`)

  let newPage = page // 默认用当前页
  for (const p of afterClickPages) {
    const u = p.url()
    // 新标签页通常打开 jwts 或包含 8118 的教学系统
    if (u !== page.url() && (u.includes('jwts') || u.includes('8118') || u.includes('eams') || u.includes('教务'))) {
      logger.info(`Found new platform tab: ${u.substring(0, 100)}`)
      newPage = p
      break
    }
  }

  // 如果没找到特定 URL，就用最新的页面
  if (newPage === page && afterClickPages.length > 1) {
    newPage = afterClickPages[afterClickPages.length - 1]
    logger.info(`Using newest tab: ${newPage.url().substring(0, 100)}`)
  }

  try { await newPage.waitForLoadState('networkidle', { timeout: 20000 }) } catch (_) {}
  await sleep(2000)

  logger.info(`After click URL: ${newPage.url().substring(0, 120)}`)
  const diag = await diagnosePage(newPage, 'after_jw_click')
  // 返回诊断结果和新页面引用，供调用方切换
  diag.newPage = newPage
  return diag
}

/**
 * Step 4: 等待新教务平台加载，如有登录表单则填凭证
 */
async function handlePlatformLogin(page, studentId, password) {
  logger.info('[GradeQuery] Step 4: Handle platform login...')
  await sleep(2000)

  // 检查是否有"统一身份认证登录"按钮（教务系统 8118 入口）
  const hasSsoBtn = await page.evaluate(() => {
    const body = document.body?.innerText || ''
    return body.includes('统一身份认证') || body.includes('统一认证')
  })

  if (hasSsoBtn) {
    logger.info('Found SSO login button on platform')

    // 当前页面通过 ivpn 代理访问 (jwts-hitwh-edu-cn.ivpn.hitwh.edu.cn:8118)
    // 页面中的 SSO 链接指向内网域名 (jwts.hitwh.edu.cn)，Chrome 直接解析会 chrome-error
    // 策略: 找到 CAS 登录链接的路径，构造通过 ivpn 的 SSO URL
    const currentUrl = page.url()
    const casInfo = await page.evaluate(() => {
      for (const a of document.querySelectorAll('a')) {
        const text = (a.textContent || '').trim()
        const href = a.href || ''
        // 找 "统一身份认证登录" 的链接
        if (text.includes('统一身份认证') && href) {
          try {
            const u = new URL(href)
            return { href, pathname: u.pathname, search: u.search, host: u.host }
          } catch (_) {
            return { href, pathname: '/loginCAS', search: '', host: 'jwts.hitwh.edu.cn' }
          }
        }
      }
      return null
    })
    logger.info(`CAS link: ${JSON.stringify(casInfo)}`)
    logger.info(`Current page URL: ${currentUrl.substring(0, 120)}`)

    // CAS service URL 必须使用原始地址（非 ivpn 代理），否则 ticket 验证失败
    // ivpn 代理后的 URL 会导致 "票根不符合目标服务" 错误
    let serviceUrl = ''
    if (casInfo && casInfo.href && casInfo.href.startsWith('http')) {
      // 使用原始 CAS 链接（如 http://jwts.hitwh.edu.cn/loginCAS）
      serviceUrl = casInfo.href
    } else {
      // Fallback
      serviceUrl = 'http://jwts.hitwh.edu.cn/loginCAS'
    }
    const ssoUrl = `https://ids.hit.edu.cn/authserver/login?service=${encodeURIComponent(serviceUrl)}`
    logger.info(`Navigating to SSO: ${ssoUrl.substring(0, 150)}`)
    logger.info(`Service URL: ${serviceUrl}`)

    // 方案：用原始 URL 拿 CAS ticket
    // 1. 导航到 SSO（service=原始jwts地址）→ 利用已有 session 自动跳转
    // 2. SSO 重定向到 jwts.hitwh.edu.cn 时可能 chrome-error（内网不可达）
    // 3. 从 URL 中提取 ticket，手动构造 ivpn 代理 URL + ticket
    // 4. jwts 用该 ticket 验证（service 匹配原始地址）→ 成功
    await page.evaluate((url) => { window.location = url }, ssoUrl)
    await sleep(3000)

    let ticketUrl = ''
    for (let i = 0; i < 15; i++) {
      await sleep(2000)
      const u = page.url()
      logger.info(`  SSO nav [${(i+1)*2}s]: ${u.substring(0, 100)}`)

      // 检测到 ticket
      if (u.includes('ticket=')) {
        ticketUrl = u
        logger.info('Got ticket URL: ' + u.substring(0, 120))
        break
      }

      // chrome-error → 内网 jwts.hitwh.edu.cn 不可达，从 URL 提取 ticket
      if (u.includes('chrome-error')) {
        logger.info('chrome-error (expected for internal URL), extracting ticket...')
        const match = u.match(/[?&]ticket=([^&]+)/)
        if (match) {
          const ticket = match[1]
          const ivpnBase = currentUrl.match(/^(https?:\/\/[^/]+)/)?.[1] || currentUrl
          ticketUrl = `${ivpnBase}/loginCAS?ticket=${encodeURIComponent(ticket)}`
          logger.info('Constructed ivpn ticket URL: ' + ticketUrl.substring(0, 120))
          break
        }
      }

      // 还在 SSO 且超过 10 秒 → 可能需要扫码
      if ((u.includes('ids.hit.edu.cn') || u.includes('authserver')) && i >= 5) {
        logger.info('Still on SSO, capturing QR code...')
        const { captureQrCode } = require('./login')
        const qrResult = await captureQrCode(page)
        if (qrResult.qrcode) {
          logger.info('QR code captured for academic SSO')
          return { needsQrScan: true, qrcode: qrResult.qrcode, newPage: page }
        }
        continue
      }

      // 已离开 SSO（正常跳转）
      if (!u.includes('ids.hit.edu.cn') && !u.includes('authserver') && !u.includes('chrome-error')) break
    }

    // 有 ticket URL 但和当前不同 → 导航过去
    if (ticketUrl && !page.url().includes('ticket=')) {
      logger.info('Navigating to ticket URL via ivpn: ' + ticketUrl.substring(0, 120))
      await page.goto(ticketUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await sleep(3000)
    }
  }

  // 最终确认页面可用
  const afterSsoUrl2 = page.url()
  if (afterSsoUrl2.includes('chrome-error')) {
    logger.error('Page still shows chrome-error after SSO, cannot continue')
    const diag = await diagnosePage(page, 'chrome_error')
    diag.newPage = page
    return diag
  }

  // 注意：如果页面仍显示登录表单，不做额外处理
  // orchestrator 的 Step 4c 会检测并给出明确错误

  await sleep(2000)
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})

  // 检查页面是否有平台自己的登录表单
  const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '')
  logger.info(`Platform body: ${bodyText.substring(0, 300)}`)

  // 检测登录表单（包含"用户名"和"密码"字段）
  const hasLoginForm = await page.evaluate(() => {
    const body = document.body?.innerText || ''
    return body.includes('用户名') && body.includes('密码') && body.includes('登录')
  })

  if (hasLoginForm) {
    logger.info('Platform login form detected, filling credentials...')

    // 填写用户名
    await page.evaluate(({ uid }) => {
      for (const sel of ['#username', '#j_username', '#userName', 'input[name="username"]', 'input[name="j_username"]', 'input[placeholder*="用户名"]', 'input[placeholder*="工号"]']) {
        const el = document.querySelector(sel)
        if (el?.offsetParent !== null) { el.value = uid; el.dispatchEvent(new Event('input',{bubbles:true})); return }
      }
      // fallback: 找包含"用户名"label旁边的input
      for (const label of document.querySelectorAll('*')) {
        if (label.textContent.trim() === '用户名' && label.offsetParent !== null) {
          const input = label.parentElement?.querySelector('input') || label.nextElementSibling?.querySelector('input') || label.nextElementSibling
          if (input?.tagName === 'INPUT') { input.value = uid; input.dispatchEvent(new Event('input',{bubbles:true})); return }
        }
      }
    }, { uid: studentId })
    await sleep(200)

    // 填写密码
    await page.evaluate(({ pwd }) => {
      for (const sel of ['#password', '#j_password', 'input[name="password"]', 'input[name="j_password"]', 'input[type="password"]', 'input[placeholder*="密码"]']) {
        const el = document.querySelector(sel)
        if (el?.offsetParent !== null) { el.value = pwd; el.dispatchEvent(new Event('input',{bubbles:true})); return }
      }
    }, { pwd: password })
    await sleep(200)

    // 检查验证码
    const hasCaptcha = await page.evaluate(() => {
      const body = document.body?.innerText || ''
      return body.includes('验证码')
    })
    if (hasCaptcha) {
      logger.info('Captcha on platform login form! Taking screenshot...')
      const buf = await page.screenshot({ type: 'png' })
      const base64 = buf.toString('base64')
      // 无法在此处中断等待用户输入，先尝试跳过
      logger.warn('Platform login has captcha - may need manual intervention')
    }

    // 点击登录
    await page.evaluate(() => {
      for (const sel of ['#login_submit', 'input[type="submit"]', 'button[type="submit"]', '.login-btn', '#loginBtn']) {
        const el = document.querySelector(sel)
        if (el?.offsetParent !== null) { el.click(); return }
      }
      for (const b of document.querySelectorAll('button')) {
        if ((b.textContent || '').includes('登录') && b.offsetParent !== null) { b.click(); return }
      }
      for (const a of document.querySelectorAll('a')) {
        if ((a.textContent || '').trim() === '登录' && a.offsetParent !== null) { a.click(); return }
      }
    })
    logger.info('Platform login submitted')
    await sleep(8000)
  }

  await sleep(2000)
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }) } catch (_) {}
  const platformUrl = page.url()
  logger.info(`Platform final URL: ${platformUrl.substring(0, 120)}`)
  const diag = await diagnosePage(page, 'platform_ready')
  diag.newPage = page
  return diag
}

/**
 * Step 4: 导航到 "成绩管理 → 班主任导员成绩查询"
 */
async function navigateToGradeQuery(page) {
  logger.info('[GradeQuery] Step 5: Navigate to grade query')

  // 页面恢复函数：检测崩溃 → 开新 tab → 重新导航到教务首页
  const recover = async () => {
    let u = 'unknown'
    try { u = page.url() } catch (_) { u = 'error' }
    if (u.includes('chrome-error') || u === 'error') {
      logger.warn(`Page crashed (${u}), opening fresh tab...`)
      try { await page.close().catch(() => {}) } catch (_) {}
      const fresh = await page.context().newPage()
      await fresh.goto('http://jwts-hitwh-edu-cn.ivpn.hitwh.edu.cn:8118/', {
        waitUntil: 'domcontentloaded', timeout: 30000
      })
      await sleep(5000)
      return fresh
    }
    // 测试页面是否真的活着
    try {
      await page.evaluate(() => 1)
      return page
    } catch (_) {
      logger.warn('Page unresponsive, opening fresh tab...')
      try { await page.close().catch(() => {}) } catch (_) {}
      const fresh = await page.context().newPage()
      await fresh.goto('http://jwts-hitwh-edu-cn.ivpn.hitwh.edu.cn:8118/', {
        waitUntil: 'domcontentloaded', timeout: 30000
      })
      await sleep(5000)
      return fresh
    }
  }

  page = await recover()
  if (page.url().includes('chrome-error')) {
    logger.error('Cannot recover — page keeps crashing')
    const diag = await diagnosePage(page, 'fatal_crash')
    diag.newPage = page
    return diag
  }

  await sleep(3000)
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  await sleep(2000)

  logger.info(`Grade query entry URL: ${page.url().substring(0, 120)}`)
  await diagnosePage(page, 'platform_ready')

  // 等待完整的页面加载
  await sleep(5000)
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
  await sleep(3000)

  // EAMS 可能有角色切换：学生视图 → 班主任/辅导员视图
  // 先检查当前视图并切换角色
  const currentRole = await page.evaluate(() => document.body?.innerText?.substring(0, 1000) || '')
  logger.info(`EAMS page text: ${currentRole}`)

  // 切换到辅导员视图（如果需要）
  const roleClicked = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent || '').trim()
      if ((t.includes('班主任') || t.includes('辅导员') || t.includes('教师')) &&
          t.includes('视图') && el.offsetParent !== null && el.children.length <= 2) {
        el.click(); return t
      }
    }
    return null
  })
  if (roleClicked) {
    logger.info(`Clicked role switch: ${roleClicked}`)
    await sleep(5000)
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
    await sleep(3000)
    const newText = await page.evaluate(() => document.body?.innerText?.substring(0, 1000) || '')
    logger.info(`After role switch: ${newText}`)
  }

  // 检查 iframe
  const frames = page.frames()
  logger.info(`Frames: ${frames.length}`)
  for (const f of frames) {
    try {
      const body = await f.evaluate(() => document.body?.innerText?.substring(0, 500) || '')
      if (body.length > 20) logger.info(`Frame ${f.url().substring(0,60)}: ${body.substring(0,200)}`)
    } catch (_) {}
  }

  // 输出页面完整 body 文本
  const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 2000) || '')
  logger.info(`Full body: ${bodyText}`)

  // 输出所有可见菜单/链接项
  const menuItems = await page.evaluate(() => {
    const seen = new Set()
    return Array.from(document.querySelectorAll('a, li, .menu-item, .nav-item, .sidebar-item, span, div'))
      .filter(el => {
        if (!el.offsetParent) return false
        const t = (el.textContent || '').trim()
        if (t.length < 2 || t.length > 30) return false
        if (seen.has(t)) return false
        seen.add(t)
        return true
      })
      .map(el => el.textContent.trim().substring(0, 30))
      .slice(0, 60)
  })
  logger.info(`All menu items: ${JSON.stringify(menuItems)}`)

  // EAMS 系统：直接找"班主任导员成绩查询"菜单项
  let clicked = false

  // 先尝试点击"成绩管理"展开子菜单
  clicked = await page.evaluate(() => {
    for (const el of document.querySelectorAll('a, li, span, div')) {
      const t = (el.textContent || '').trim()
      if ((t === '成绩管理' || t.includes('成绩管理')) && el.offsetParent !== null && t.length < 15) {
        el.click(); return t
      }
    }
    return null
  })
  if (clicked) { logger.info(`Clicked: ${clicked}`); await sleep(2000) }

  // 然后点击"班主任导员成绩查询" — 可能在任何元素类型中
  let subClick = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent || '').trim()
      if ((t === '班主任导员成绩查询' || t === '班主任导员成绩查询') &&
          el.offsetParent !== null && el.children.length === 0) {
        el.click(); return { text: t, tag: el.tagName }
      }
    }
    return null
  })
  if (subClick) { logger.info(`Clicked "${subClick.text}" (${subClick.tag})`); await sleep(3000); clicked = subClick }

  // Fallback: 尝试用 Playwright 找包含此文本的任意元素
  if (!subClick) {
    logger.info('Trying Playwright text selector...')
    try {
      const el = page.locator('text=班主任导员成绩查询').first()
      if (await el.count() > 0) {
        await el.click({ timeout: 5000 })
        clicked = '班主任导员成绩查询'
        logger.info('Clicked via Playwright text selector')
        await sleep(3000)
      }
    } catch (_) {}
  }

  // 如果还是没找到，输出调试信息
  if (!clicked) {
    const allTexts = await page.evaluate(() => {
      const seen = new Set()
      return Array.from(document.querySelectorAll('*'))
        .filter(el => el.children.length === 0 && el.offsetParent && el.textContent.trim().length >= 2)
        .map(el => el.textContent.trim())
        .filter(t => { if (seen.has(t)) return false; seen.add(t); return true })
        .slice(0, 50)
    })
    logger.info(`All leaf texts: ${JSON.stringify(allTexts)}`)
  }

  await sleep(2000)
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }) } catch (_) {}

  // 验证：检查是否仍然停留在登录页面
  const stillOnLogin = await page.evaluate(() => {
    const body = document.body?.innerText || ''
    return body.includes('统一身份认证登录') || body.includes('统一身份认证')
  }).catch(() => false)
  if (stillOnLogin) {
    logger.error('[navigateToGradeQuery] Still on login page! SSO redirect did not complete.')
    throw new Error('SSO登录未完成，页面仍显示统一身份认证登录，请检查登录流程')
  }

  const diag = await diagnosePage(page, 'grade_query_page')
  diag.newPage = page
  return diag
}

/**
 * Step 8: 填写查询条件并执行查询
 * @param {object} params - { year, school, major, className }
 */
async function fillAndQuery(page, params = {}) {
  const { year = '2022', school = '信息科学与工程学院', major = '自动化' } = params
  logger.info(`[GradeQuery] Step 5: Fill form — year=${year}, school=${school}, major=${major}`)

  await sleep(3000)
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})

  // 诊断所有可见下拉框
  const selects = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('select'))
      .filter(s => s.offsetParent !== null)
      .map(s => ({ id: s.id, name: s.name, options: Array.from(s.options).slice(0, 20).map(o => ({ text: o.text.trim(), value: o.value })) }))
  })
  logger.info(`Selects: ${JSON.stringify(selects)}`)

  // 匹配并设置下拉框值
  for (const sel of selects) {
    const opts = sel.options.map(o => o.text)
    const selId = sel.id || sel.name
    if (opts.some(o => o === year || o.startsWith('202'))) {
      await page.evaluate(({ id, name, val }) => {
        const s = document.getElementById(id) || document.querySelector(`select[name="${name}"]`)
        if (!s) return
        for (const o of s.options) { if (o.text === val || o.text.includes(val)) { s.value = o.value; break } }
        s.dispatchEvent(new Event('change', { bubbles: true }))
      }, { id: sel.id, name: sel.name, val: year })
      logger.info(`Set ${selId}=${year}`)
    }
    if (opts.some(o => o.includes('信息'))) {
      await page.evaluate(({ id, name, val }) => {
        const s = document.getElementById(id) || document.querySelector(`select[name="${name}"]`)
        if (!s) return
        for (const o of s.options) { if (o.text.includes(val)) { s.value = o.value; break } }
        s.dispatchEvent(new Event('change', { bubbles: true }))
      }, { id: sel.id, name: sel.name, val: school })
      logger.info(`Set ${selId}=${school}`)
    }
    if (opts.some(o => o.includes('自动化'))) {
      await page.evaluate(({ id, name, val }) => {
        const s = document.getElementById(id) || document.querySelector(`select[name="${name}"]`)
        if (!s) return
        for (const o of s.options) { if (o.text.includes(val)) { s.value = o.value; break } }
        s.dispatchEvent(new Event('change', { bubbles: true }))
      }, { id: sel.id, name: sel.name, val: major })
      logger.info(`Set ${selId}=${major}`)
    }
  }

  // 下拉框 change 事件可能自动触发查询。等页面响应完即可。
  await sleep(3000)
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }) } catch (_) {}
  await sleep(2000)

  return await diagnosePage(page, 'query_results')
}

/**
 * Step 8b: 点击"按班级查询"并提取学生列表
 */
async function extractStudentList(page) {
  logger.info('[GradeQuery] Extracting student list...')
  // 等 AJAX 数据完全渲染
  for (let i = 0; i < 10; i++) {
    await sleep(2000)
    const hasData = await page.evaluate(() => {
      const tables = document.querySelectorAll('table')
      for (const t of tables) {
        if (Array.from(t.querySelectorAll('td')).length > 10) return true
      }
      return false
    })
    if (hasData) { logger.info(`Data loaded after ${(i+1)*2}s`); break }
  }

  // 先诊断页面结构
  const pageDiag = await page.evaluate(() => ({
    tableCount: document.querySelectorAll('table').length,
    bodyText: document.body?.innerText?.substring(0, 500) || '',
    // 检查是否有学生数据的关键词
    hasStudentId: !!(document.body?.innerText?.match(/\b\d{8,12}\b/)),
    hasGpa: !!(document.body?.innerText?.match(/\d{2}\.\d{2}/)),
  }))
  logger.info(`Page has tables:${pageDiag.tableCount}, studentIds:${pageDiag.hasStudentId}`)

  // 方式1: 表格提取
  let students = await tryExtractTableData(page)

  // 方式2: 非表格 DOM 结构 — 找重复的容器元素提取学生记录
  if (!students || students.length === 0) {
    logger.info('Table extraction failed, trying DOM structural extraction...')
    students = await page.evaluate(() => {
      // 找所有可能包含学生记录的重复结构
      // 策略: 找包含学号模式的 DOM 节点
      const allText = document.body.innerText
      const lines = allText.split('\n').map(l => l.trim()).filter(Boolean)

      // 尝试每行解析一个学生（如果数据是行式布局）
      const result = []
      // 找包含8-12位数字（学号）的行
      const idLines = []
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/\b(\d{8,12})\b/)
        if (match && !/^\d{1,3}$/.test(match[1])) {
          idLines.push({ index: i, line: lines[i], id: match[1] })
        }
      }

      // 从每个学号行提取学生信息
      for (const idLine of idLines) {
        const contextLines = lines.slice(idLine.index, idLine.index + 5)
        const context = contextLines.join(' ')
        // 从上下文中提取字段
        const nameMatch = context.match(/[一-龥]{2,4}/g)
        const gpaMatch = context.match(/(\d{2}\.\d{1,2})/g)
        const failMatch = context.match(/\b(\d)\b\s*门?/g)
        const classMatch = context.match(/(\d{7,8})/g)

        const name = nameMatch ? nameMatch.find(n => !/[0-9]/.test(n)) || '' : ''
        const gpa = gpaMatch ? parseFloat(gpaMatch[0]) : 0
        const failedCount = failMatch ? parseInt(failMatch[0]) : 0
        const classId = classMatch ? classMatch.find(c => c !== idLine.id && c.length >= 7) || '' : ''

        if (idLine.id && name) {
          result.push({
            studentId: idLine.id,
            name,
            className: classId,
            gpa,
            failedCount,
            coursesExtracted: false,
            courseCount: 0,
            courses: []
          })
        }
      }

      // 去重（按学号）
      const seen = new Set()
      return result.filter(s => { if (seen.has(s.studentId)) return false; seen.add(s.studentId); return true })
    })
  }

  if (!students || students.length === 0) {
    logger.warn('No student data found, trying fallback...')
    students = await page.evaluate(() => {
      const tables = document.querySelectorAll('table')
      return []
    })
  }

  logger.info(`Extracted ${students.length} students`)
  return students
}

/**
 * 尝试从页面提取学生数据
 */
async function tryExtractTableData(page) {
  return await page.evaluate(() => {
    const tables = document.querySelectorAll('table')
    // 先找有"学号"或"姓名"表头的表格
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('th')).map(h => h.textContent.trim())
      // 确认是学生数据表
      const hasId = headers.some(h => h.includes('学号'))
      const hasName = headers.some(h => h === '姓名' || h.includes('姓名'))
      if (!hasId && !hasName) continue

      // 确定列索引
      const colMap = {}
      headers.forEach((h, i) => {
        if (h.includes('学号')) colMap.idxId = i
        if (h === '姓名' || h.includes('姓名')) colMap.idxName = i
        if (h.includes('学分绩') || h.includes('绩点')) colMap.idxGpa = i
        if (h.includes('不及格') || h.includes('挂科')) colMap.idxFail = i
        if (h.includes('班级')) colMap.idxClass = i
      })

      const result = []
      const rows = table.querySelectorAll('tbody tr, tr')
      for (const row of rows) {
        const cells = row.querySelectorAll('td')
        if (cells.length < headers.length - 1) continue
        const texts = Array.from(cells).map(c => c.textContent.trim())
        const sid = colMap.idxId !== undefined ? texts[colMap.idxId] : ''
        if (sid && /^\d{6,12}$/.test(sid) && !/^\d{1,3}$/.test(sid)) {
          result.push({
            studentId: sid,
            name: colMap.idxName !== undefined ? (texts[colMap.idxName] || '') : '',
            className: colMap.idxClass !== undefined ? (texts[colMap.idxClass] || '') : '',
            gpa: colMap.idxGpa !== undefined ? (parseFloat(texts[colMap.idxGpa]) || 0) : 0,
            failedCount: colMap.idxFail !== undefined ? (parseInt(texts[colMap.idxFail]) || 0) : 0,
            coursesExtracted: false, courseCount: 0, courses: []
          })
        }
      }
      if (result.length > 0) return result
    }
    return []
  })
}

/**
 * Step 9-11: 提取单个学生的课程详情
 */
async function extractStudentCourses(page, studentIndex) {
  logger.info(`[GradeQuery] Step 9: Extract courses for student #${studentIndex}`)

  // 查找并点击该学生的查看按钮（放大镜图标）
  const clicked = await page.evaluate(({ idx }) => {
    const tables = document.querySelectorAll('table')
    for (const table of tables) {
      const rows = table.querySelectorAll('tbody tr, tr')
      // 跳过表头
      const dataRows = Array.from(rows).filter(r => r.querySelectorAll('td').length >= 4)
      if (idx < dataRows.length) {
        const row = dataRows[idx]
        // 在行中查找查看按钮
        const links = row.querySelectorAll('a')
        for (const a of links) {
          const text = a.textContent.trim()
          const hasIcon = a.querySelector('img, i, span.glyphicon, svg')
          // 查看按钮通常是小图标或短文本
          if (text === '查看' || text === '详情' || hasIcon || text.length <= 4) {
            a.click(); return { type: 'short_link', text }
          }
        }
        // 尝试最后一个链接
        if (links.length > 0) {
          const last = links[links.length - 1]
          last.click()
          return { type: 'last_link', text: last.textContent.trim() }
        }
        // 尝试点击行中的图片
        const imgs = row.querySelectorAll('img[src*="search"], img[src*="magnifier"], img[src*="view"]')
        if (imgs.length > 0) {
          imgs[0].click()
          return { type: 'image' }
        }
      }
    }
    return null
  }, { idx: studentIndex })

  logger.info(`Detail click result: ${JSON.stringify(clicked)}`)
  await sleep(3000)

  // 提取课程表格
  const courses = await page.evaluate(() => {
    const tables = document.querySelectorAll('table')
    for (const table of tables) {
      const rows = table.querySelectorAll('tbody tr, tr')
      const result = []
      for (const row of rows) {
        const cells = row.querySelectorAll('td')
        if (cells.length >= 5) {
          const texts = Array.from(cells).map(c => c.textContent.trim())
          // 检查第一列是否是学期（如 "2022-2023-1" 或 "2022秋"）
          if (texts[0].includes('-') || texts[0].includes('秋') || texts[0].includes('春') || texts[0].includes('学期')) {
            result.push({
              semester: texts[0],
              courseName: texts[1] || '',
              nature: texts[2] || '',
              credits: parseFloat(texts[3]) || 0,
              retakeMark: texts[4] || '',
              totalScore: texts[5] || ''
            })
          }
        }
      }
      if (result.length > 0) return result
    }
    return []
  })

  logger.info(`Extracted ${courses.length} courses`)

  // 点击返回按钮
  await clickByText(page, ['返回', '关闭', '取消', 'Back', 'Close'], '返回按钮')
  await sleep(2000)

  return courses
}

module.exports = {
  navigateToVpnLogin,
  performSsoLogin,
  submitMfaCode,
  enterNewAcademicPlatform,
  handlePlatformLogin,
  navigateToGradeQuery,
  fillAndQuery,
  extractStudentList,
  extractStudentCourses,
  waitingLogins,
  diagnosePage,
  saveCookies,
  loadCookies,
  gradeLoginSessions,
  performIvpnLoginStep,
  submitIvpnLoginCode
}

// ========== 成绩查询完整登录链（移到前端登录阶段） ==========

/**
 * 第一步：开始 ivpn 完整登录
 * 复用 QR 登录的 ivpn 入口页面，然后一直走到教务平台成绩查询页面
 */
async function performIvpnLoginStep(openid, mode) {
  // 清理旧会话
  const old = gradeLoginSessions.get(openid)
  if (old) {
    try { await browser.releaseContext(old.slot) } catch (_) {}
    gradeLoginSessions.delete(openid)
  }

  const { getCredential } = require('../models/credential')
  const cred = await getCredential(openid)
  if (!cred) return { error: '请先配置凭证' }

  // 获取浏览器上下文
  const { slot, page: initialPage } = await browser.acquireContext()
  let page = initialPage

  // 保存会话
  const session = { slot, page, studentId: cred.studentId, password: cred.password, step: 'starting' }
  gradeLoginSessions.set(openid, session)

  // Step 1: 打开 ivpn，自动跳转 SSO
  logger.info('[GradeLogin] Step 1: Opening ivpn...')
  await page.goto('https://ivpn.hitwh.edu.cn/', { waitUntil: 'domcontentloaded', timeout: 30000 })

  for (let i = 0; i < 10; i++) {
    await sleep(2000)
    const u = page.url()
    if (u.includes('ids.hit.edu.cn') || u.includes('authserver')) break
    if (u.includes('/portal') || u.includes('#!/')) break
  }
  await sleep(2000)

  const currentUrl = page.url()
  logger.info('[GradeLogin] After ivpn: ' + currentUrl.substring(0, 100))
  logger.info('[GradeLogin] Current URL: ' + currentUrl.substring(0, 100))

  // 情况1: 在 ivpn portal → 点新教务系统 → 新 context 拿 ticket
  if (!currentUrl.includes('ids.hit.edu.cn') && !currentUrl.includes('authserver') &&
      (currentUrl.includes('/portal') || currentUrl.includes('#!/'))) {
    session.step = 'portal'
    logger.info('[GradeLogin] On ivpn portal, clicking 新教务系统...')

    // Step 1: 点「新教务系统」进入 jwts 页面
    const result = await enterNewAcademicPlatform(page)
    if (result && result.newPage) { page = result.newPage; session.page = page }
    logger.info('[GradeLogin] JWTS page: ' + page.url().substring(0, 100))

    // Step 2: 用 Node.js HTTP 客户端发 SSO 请求拿 ticket（绕过 Chrome 混合内容拦截）
    const serviceUrl = 'http://jwts.hitwh.edu.cn/loginCAS'
    const ticketUrl = await fetchTicketViaHttp(page, serviceUrl)

    if (ticketUrl) {
      logger.info('[GradeLogin] Got ticket, validating via HTTP...')
      // 用 Node.js HTTP 请求 ivpn URL + ticket → 拿 jwts cookies → 注入 Chrome → 绕过导航拦截
      const jwtsCookies = await validateTicketViaHttp(ticketUrl, page)
      if (jwtsCookies && jwtsCookies.length > 0) {
        await page.context().addCookies(jwtsCookies)
        logger.info('[GradeLogin] Injected ' + jwtsCookies.length + ' jwts cookies')
        // 直接导航到 jwts 首页（已认证）
        await page.evaluate(() => { window.location = 'http://jwts-hitwh-edu-cn.ivpn.hitwh.edu.cn:8118/' })
        await sleep(5000)
      } else {
        logger.warn('[GradeLogin] Ticket validation failed, no cookies returned')
      }
    } else {
      logger.warn('[GradeLogin] HTTP fetch failed')
    }

    session.step = 'navigating'
    const navResult = await navigateToGradeQuery(page)
    if (navResult && navResult.newPage) session.page = navResult.newPage
    session.step = 'done'
    logger.info('[GradeLogin] Full login complete!')
    return { done: true, message: '登录完成，已进入教务平台成绩查询页面' }
  }
  if (currentUrl.includes('/portal') || currentUrl.includes('#!/')) {
    session.step = 'portal'
    logger.info('[GradeLogin] On ivpn portal (legacy), clicking 新教务系统...')
    const result = await enterNewAcademicPlatform(page)
    if (result && result.newPage) { page = result.newPage; session.page = page }
    // ... 沿用旧逻辑但简化
  }

  // 情况2: 在 SSO 页面
  if (currentUrl.includes('ids.hit.edu.cn') || currentUrl.includes('authserver')) {
    // 检测 MFA
    if (currentUrl.includes('reAuth') || currentUrl.includes('multifactor')) {
      await clickGetCode(page)
      session.step = 'mfa'
      return { needsCode: true, message: '已发送验证码，请查看 HIT APP 或手机短信' }
    }

    if (mode === 'qrcode') {
      // 二维码模式
      const { captureQrCode } = require('./login')
      const qrResult = await captureQrCode(page)
      if (qrResult.qrcode) {
        session.step = 'qrcode'
        return { hasQrCode: true, qrcode: qrResult.qrcode, message: '请使用 HIT APP 扫码登录' }
      }
    }

    // 密码模式：先点账号登录，再填凭证
    await sleep(1000)
    try {
      await page.evaluate(() => {
        const links = document.querySelectorAll('a')
        for (const a of links) {
          if (a.textContent.trim() === '账号登录' && a.offsetParent !== null) { a.click(); return }
        }
      })
      await sleep(3000)
    } catch (_) {}

    // 再次检查 MFA
    const afterClick = page.url()
    if (afterClick.includes('reAuth') || afterClick.includes('multifactor')) {
      await clickGetCode(page)
      session.step = 'mfa'
      return { needsCode: true, message: '已发送验证码，请查看 HIT APP 或手机短信' }
    }

    // 填凭证登录
    const { performAuthserverLogin } = require('./login')
    const loginResult = await performAuthserverLogin(page, session.studentId, session.password)

    if (loginResult.loginFailed) {
      return { error: 'SSO登录失败：' + loginResult.message, screenshot: loginResult.screenshot }
    }
    if (loginResult.needsCaptcha) {
      session.step = 'captcha'
      return { needsCaptcha: true, captchaImage: loginResult.captchaImage, message: '请输入图片验证码' }
    }
    if (loginResult.needsCode) {
      session.step = 'mfa'
      return { needsCode: true, message: '已发送验证码' }
    }

    // 登录成功，等待跳转
    await waitForIvpnPortal(page, session)
  }

  // 到了 portal → 模拟点击：改写链接 + Playwright 真实点击
  session.step = 'portal'
  logger.info('[GradeLogin] On portal, clicking 新教务系统...')

  const result = await enterNewAcademicPlatform(page)
  if (result && result.newPage) { page = result.newPage; session.page = page }
  logger.info('[GradeLogin] JWTS page: ' + page.url().substring(0, 100))

  const serviceUrl = 'http://jwts.hitwh.edu.cn/loginCAS'
  const ssoUrl = `https://ids.hit.edu.cn/authserver/login?service=${encodeURIComponent(serviceUrl)}`
  await sleep(2000)

  // 用 Node.js HTTP 拿 ticket（使用上面已声明的 serviceUrl）
  const ticketUrl = await fetchTicketViaHttp(page, serviceUrl)

  if (ticketUrl) {
    logger.info('[GradeLogin] Got ticket, validating via HTTP...')
    const jwtsCookies = await validateTicketViaHttp(ticketUrl, page)
    if (jwtsCookies && jwtsCookies.length > 0) {
      await page.context().addCookies(jwtsCookies)
      logger.info('[GradeLogin] Injected ' + jwtsCookies.length + ' jwts cookies')
      await page.evaluate(() => { window.location = 'http://jwts-hitwh-edu-cn.ivpn.hitwh.edu.cn:8118/' })
      await sleep(5000)
    }
  }

  session.step = 'navigating'
  const navResult = await navigateToGradeQuery(page)
  if (navResult && navResult.newPage) session.page = navResult.newPage
  session.step = 'done'
  logger.info('[GradeLogin] Full login complete!')
  return { done: true, message: '登录完成，已进入教务平台成绩查询页面' }
}

/**
 * 提交验证码（MFA 或 captcha）
 */
async function submitIvpnLoginCode(openid, code) {
  const session = gradeLoginSessions.get(openid)
  if (!session) return { error: '登录会话已过期' }
  const page = session.page

  if (session.step === 'captcha') {
    // 提交图片验证码
    const { submitCaptcha } = require('./login')
    const result = await submitCaptcha(page, code, session.studentId, session.password)
    if (result.retry) {
      return { needsCaptcha: true, captchaImage: result.captchaImage, message: '验证码错误，请重试' }
    }
    if (result.needsCode) {
      session.step = 'mfa'
      return { needsCode: true, message: '已发送验证码' }
    }
    await waitForIvpnPortal(page, session)
  } else if (session.step === 'mfa') {
    // 提交 MFA 验证码
    await submitMfaCode(page, code)
    await waitForIvpnPortal(page, session)
  } else if (session.step === 'qrcode') {
    // QR 扫码后的 MFA
    const { submitCode } = require('./login')
    await submitCode(page, code)
    await waitForIvpnPortal(page, session)
  }

  // 到了 portal → 点击新教务系统
  session.step = 'portal'
  const platformResult = await enterNewAcademicPlatform(page)
  if (platformResult && platformResult.newPage) session.page = platformResult.newPage

  // 处理 教务 CAS
  return await handleJwtsLogin(session.page, session)
}

async function waitForIvpnPortal(page, session) {
  // 等待离开 SSO → portal（ivpn 或 campus）
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    const u = page.url()
    const body = await page.evaluate(() => (document.body?.innerText || '').substring(0, 100)).catch(() => '')

    // CAS XML → 导航到 portal
    if (body.includes('This XML file') || body.includes('<Auth>')) {
      logger.info('[GradeLogin] CAS XML detected, navigating to portal')
      await page.goto('http://webvpn.hitwh.edu.cn/', { waitUntil: 'domcontentloaded', timeout: 15000 })
      await sleep(2000)
      continue
    }

    // 到达 portal（webvpn / ivpn / campus）
    if (u.includes('webvpn') || u.includes('/portal') || u.includes('#!/') || u.includes('mhsy') || u.includes('i.hitwh.edu.cn')) {
      logger.info('[GradeLogin] Arrived at portal: ' + u.substring(0, 80))
      break
    }
    if (i % 3 === 0) logger.info('[GradeLogin] Waiting for portal... ' + u.substring(0, 80))
  }
}

async function handleJwtsLogin(page, session) {
  // 检查是否需要 教务 CAS 登录
  await sleep(2000)
  const body = await page.evaluate(() => (document.body?.innerText || '').substring(0, 500)).catch(() => '')
  const url = page.url()

  // 在教务系统登录页 → 点击"统一身份认证登录"链接
  if (body.includes('统一身份认证登录') && (url.includes('jwts') || url.includes('8118'))) {
    logger.info('[GradeLogin] On jwts login page, handling CAS...')

    // jwts 页面的 SSO 链接指向内网 URL (jwts.hitwh.edu.cn)，Chrome 无法解析
    // 把链接 href 改成 SSO URL（service=原始jwts地址避免ticket不匹配），再点击
    const serviceUrl = 'http://jwts.hitwh.edu.cn/loginCAS'
    const ssoUrl = `https://ids.hit.edu.cn/authserver/login?service=${encodeURIComponent(serviceUrl)}`
    logger.info('[GradeLogin] Rewriting SSO link to: ' + ssoUrl.substring(0, 100))

    await page.evaluate((url) => {
      const links = document.querySelectorAll('a')
      for (const a of links) {
        if (a.textContent.includes('统一身份认证')) {
          a.href = url
          a.target = '_self'
          a.click()
          return
        }
      }
    }, ssoUrl)
    logger.info('[GradeLogin] Clicked rewritten SSO link')
    await sleep(5000)

    // 等待 SSO 跳转（有 session → 自动重定向到 jwts → chrome-error → 提取ticket）
    for (let i = 0; i < 20; i++) {
      await sleep(2000)
      const u = page.url()
      logger.info('[GradeLogin] JWTS: ' + u.substring(0, 80))

      // MFA
      if (u.includes('reAuth') || u.includes('multifactor')) {
        await clickGetCode(page)
        session.step = 'jwts_mfa'
        return { needsCode: true, message: '教务系统需要短信验证码，请查看手机' }
      }

      // chrome-error → 提取 ticket，用 ivpn URL 访问
      if (u.includes('chrome-error')) {
        const match = u.match(/[?&]ticket=([^&]+)/)
        if (match) {
          const ivpnBase = url.match(/^(https?:\/\/[^/]+)/)?.[1] || url
          const ticketUrl = `${ivpnBase}/loginCAS?ticket=${encodeURIComponent(match[1])}`
          logger.info('[GradeLogin] Extracted ticket: ' + ticketUrl.substring(0, 100))
          await page.goto(ticketUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
          await sleep(3000)
          break
        }
      }

      // 离开登录页=成功
      const body = await page.evaluate(() => (document.body?.innerText || '').substring(0, 100)).catch(() => '')
      if (!body.includes('统一身份认证登录') && !body.includes('loginCAS')) break
    }
  }

  // 导航到成绩查询页面
  session.step = 'navigating'
  const navResult = await navigateToGradeQuery(page)
  if (navResult && navResult.newPage) session.page = navResult.newPage

  session.step = 'done'
  logger.info('[GradeLogin] Full login complete! Page ready for grade query')
  return { done: true, message: '登录完成，已进入教务平台成绩查询页面' }
}

/**
 * 用 Node.js HTTP 客户端跟踪 SSO 重定向，获取 CAS ticket
 * 绕过 Chrome DNS 问题：Node.js 可以使用 /etc/hosts
 */
async function fetchTicketViaHttp(page, serviceUrl) {
  const https = require('https')
  const http = require('http')

  // 获取 SSO cookies
  const cookies = await page.context().cookies()
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  return new Promise((resolve) => {
    const ssoUrl = new URL(`https://ids.hit.edu.cn/authserver/login?service=${encodeURIComponent(serviceUrl)}`)

    const req = https.get(ssoUrl, {
      headers: { Cookie: cookieStr },
      maxRedirects: 0, // We handle redirects manually
      timeout: 15000
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        // Check for 302 redirect
        if (res.statusCode === 302 || res.statusCode === 301) {
          const location = res.headers.location
          logger.info('[TicketFetch] Got redirect: ' + (location || '').substring(0, 120))
          if (location && location.includes('ticket=')) {
            const match = location.match(/[?&]ticket=([^&]+)/)
            if (match) {
              // Now navigate to ivpn URL with ticket
              const ticketUrl = `http://jwts-hitwh-edu-cn.ivpn.hitwh.edu.cn:8118/loginCAS?ticket=${encodeURIComponent(match[1])}`
              logger.info('[TicketFetch] Got ticket via HTTP: ' + ticketUrl.substring(0, 100))
              resolve(ticketUrl)
              return
            }
          }
          // If redirect but no ticket (might be another SSO redirect), follow it
          if (location && location.includes('ids.hit.edu.cn')) {
            logger.info('[TicketFetch] Following second redirect: ' + location.substring(0, 100))
            // The SSO is redirecting to itself, which means no session → try again with a new request
            resolve(null)
            return
          }
        }
        // Check if the response body contains a redirect (meta refresh or JS)
        logger.info('[TicketFetch] Status: ' + res.statusCode + ', no ticket redirect found')
        resolve(null)
      })
    })
    req.on('error', (e) => {
      logger.warn('[TicketFetch] Request error: ' + e.message)
      resolve(null)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
  })
}

/**
 * 用 Node.js HTTP 请求 ivpn ticket URL，获取 jwts session cookies
 * 返回 cookies 数组可直接注入 Chrome context
 */
async function validateTicketViaHttp(ticketUrl, page) {
  const https = require('https')
  const http = require('http')
  const allCookies = []

      const pageCookies = await page.context().cookies()
    const cookieStr = pageCookies.map(c => c.name + '=' + c.value).join('; ')
    // Follow redirect chain to collect all cookies
  let currentUrl = ticketUrl
  for (let redirectCount = 0; redirectCount < 10; redirectCount++) {
    const result = await new Promise((resolve) => {
      const url = new URL(currentUrl)
      const mod = url.protocol === 'https:' ? https : http
      const req = mod.get(currentUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', Cookie: cookieStr },
        timeout: 10000
      }, (res) => {
        // Collect Set-Cookie headers
        const setCookieHeaders = res.headers['set-cookie']
        if (setCookieHeaders) {
          for (const sc of setCookieHeaders) {
            const match = sc.match(/^([^=]+)=([^;]+)/)
            if (match) {
              allCookies.push({
                name: match[1], value: match[2],
                domain: url.hostname, path: '/',
                httpOnly: sc.includes('HttpOnly'), secure: sc.includes('Secure')
              })
            }
          }
        }

        // Consume body
        res.on('data', () => {})
        res.on('end', () => {
          if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
            const loc = res.headers.location
            currentUrl = loc.startsWith('http') ? loc : `${url.protocol}//${url.host}${loc}`
            logger.info('[ValidateTicket] Redirect ' + redirectCount + ': ' + currentUrl.substring(0, 80))
            resolve({ redirect: currentUrl })
          } else {
            logger.info('[ValidateTicket] Final: status=' + res.statusCode + ', cookies=' + allCookies.length)
            resolve({ done: true })
          }
        })
      })
      req.on('error', (e) => resolve({ error: e.message }))
      req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }) })
    })
    if (result.done || result.error) break
  }

  return allCookies.length > 0 ? allCookies : null
}

async function clickGetCode(page) {
  try {
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
  } catch (_) {}
}
