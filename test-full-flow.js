const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

;(async () => {
  const DIR = path.join(__dirname, '..', 'debug_screenshots')
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const CODE_FILE = path.join(__dirname, 'mfa_code.txt')

  // 从命令行参数读取
  const uid = process.argv[2]
  const pwd = process.argv[3]
  if (!uid || !pwd) {
    console.log('Usage: node test-full-flow.js <工号> <密码>')
    console.log('Example: node test-full-flow.js 20226032 mypassword')
    process.exit(1)
  }
  console.log('UID:', uid)

  // 删除旧的code文件
  try { fs.unlinkSync(CODE_FILE) } catch (_) {}

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-gpu'] })
  const context = await browser.newContext()
  const page = await context.newPage()

  // ====== LOGIN ======
  console.log('=== LOGIN ===')
  await page.goto('https://www.hitwh.edu.cn/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(2000)
  const [vpnPage] = await Promise.all([
    context.waitForEvent('page', { timeout: 15000 }),
    page.evaluate(() => {
      const links = document.querySelectorAll('a')
      for (const a of links) {
        if (a.textContent.trim() === '数据库VPN' && a.offsetParent !== null) { a.click(); return }
      }
    })
  ])
  await vpnPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
  await sleep(4000)

  if (!vpnPage.url().includes('reAuth')) {
    console.log('Current URL:', vpnPage.url().substring(0, 120))

    // 切换到密码登录tab
    if (!vpnPage.url().includes('type=userNameLogin')) {
      console.log('Switching to password login...')
      await vpnPage.locator('#userNameLogin_a').click({ timeout: 5000 }).catch(() => {})
      await sleep(2000)
    }

    // 等待登录表单
    await vpnPage.waitForSelector('#login_submit', { state: 'visible', timeout: 5000 }).catch(() => {})
    await sleep(500)

    // 填写凭证
    await vpnPage.locator('#username').first().fill(uid, { timeout: 5000 }).catch(async () => {
      await vpnPage.evaluate((val) => {
        for (const inp of document.querySelectorAll('#username')) {
          if (inp.offsetParent !== null) { inp.value = val; inp.dispatchEvent(new Event('input',{bubbles:true})); return }
        }
      }, uid)
    })
    await sleep(200)
    await vpnPage.locator('#password').first().fill(pwd, { timeout: 5000 }).catch(async () => {
      await vpnPage.evaluate((val) => {
        for (const p of document.querySelectorAll('#password')) {
          if (p.offsetParent !== null && p.type === 'password') { p.value = val; p.dispatchEvent(new Event('input',{bubbles:true})); return }
        }
      }, pwd)
    })
    await sleep(200)

    // AES加密
    await vpnPage.evaluate(() => {
      const p = document.getElementById('password')
      const salt = document.getElementById('pwdEncryptSalt')
      if (p && salt && salt.value && window.encryptPassword) {
        document.getElementById('saltPassword').value = window.encryptPassword(p.value, salt.value)
        p.disabled = true
      }
    })
    console.log('AES done')

    // 验证表单
    const formDiag = await vpnPage.evaluate(() => ({
      user: document.getElementById('username')?.value || '',
      pwdOk: (document.getElementById('password')?.value || '').length > 0,
      saltOk: (document.getElementById('saltPassword')?.value || '').length > 0,
      url: location.href.substring(0, 80)
    }))
    console.log('Form:', JSON.stringify(formDiag))

    // 点击登录
    await vpnPage.locator('#login_submit').first().click({ timeout: 5000 }).catch(() => {
      console.log('Click failed, trying form submit...')
    })
    console.log('Login submitted')
    await sleep(10000)
  }

  // ====== MFA ======
  const curUrl = vpnPage.url()
  if (curUrl.includes('reAuth')) {
    console.log('=== MFA ===')
    await vpnPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
    await sleep(2000)
    const userName = await vpnPage.evaluate(() => document.getElementById('username')?.value || '')
    console.log('User:', userName)

    // 点击获取验证码
    await vpnPage.evaluate(() => {
      const btn = document.getElementById('getDynamicCode')
      if (btn?.offsetParent) btn.click()
    })
    await sleep(1500)
    console.log('验证码已发送！')
    console.log('请执行: echo 你的验证码 > ' + CODE_FILE)

    // 等待code文件
    let code = null
    const start = Date.now()
    while (!code && Date.now() - start < 120000) {
      try { code = fs.readFileSync(CODE_FILE, 'utf8').trim(); if (code) break } catch (_) {}
      await sleep(500)
    }
    if (!code) { console.log('TIMEOUT'); await browser.close(); process.exit(1) }
    console.log('Got code:', code)
    try { fs.unlinkSync(CODE_FILE) } catch (_) {}

    // 填码+提交
    await vpnPage.evaluate(({ val }) => {
      const inp = document.getElementById('dynamicCode')
      if (inp) { inp.value = val; inp.dispatchEvent(new Event('input',{bubbles:true})) }
    }, { val: code })
    await sleep(300)
    await vpnPage.evaluate(() => {
      const btn = document.getElementById('reAuthSubmitBtn')
      if (btn) btn.click()
    })
    console.log('Code submitted')

    // 弹窗处理
    await sleep(3000)
    for (let i = 0; i < 5; i++) {
      const clicked = await vpnPage.evaluate(() => {
        const btns = document.querySelectorAll('button')
        for (const b of btns) {
          const t = (b.textContent || '').trim()
          if (b.offsetParent && (t === '信任此设备' || t === '仅本次登录' || t === '信任' ||
              t === '下一步' || t === '确认' || t === '关闭' ||
              t === 'Trust this device' || t === 'Login this time only' || t === 'Trust' || t === 'Next')) {
            b.click(); return t
          }
        }
        return null
      })
      if (clicked) { console.log('Clicked:', clicked); await sleep(2000) } else break
    }
    await sleep(8000)
  }

  const finalUrl = vpnPage.url()
  console.log('Post-MFA URL:', finalUrl.substring(0, 120))
  console.log('Title:', await vpnPage.title())

  // ====== VPN PORTAL ======
  if (finalUrl.includes('i.hitwh.edu.cn')) {
    console.log('\n=== VPN PORTAL ===')
    await sleep(3000)
    await vpnPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
    await sleep(2000)

    const bodyText = await vpnPage.evaluate(() => document.body.innerText)
    console.log('Page text:')
    console.log(bodyText.substring(0, 3000))

    console.log('\n--- Links ---')
    const links = await vpnPage.evaluate(() => {
      return Array.from(document.querySelectorAll('a'))
        .filter(a => a.offsetParent !== null && a.textContent.trim())
        .map(a => ({ text: a.textContent.trim().replace(/\s+/g,' ').substring(0, 50), href: (a.href||'').substring(0, 100) }))
    })
    for (const l of links) {
      if (l.text.length > 1) console.log(`  [${l.text.substring(0,40)}] -> ${l.href.substring(0,60)}`)
    }
  } else if (finalUrl.includes('authserver') || finalUrl.includes('ids.hit.edu.cn')) {
    const body = await vpnPage.evaluate(() => document.body.innerText.substring(0, 600))
    console.log('Still on auth page:', body)
  } else {
    const body = await vpnPage.evaluate(() => document.body.innerText.substring(0, 800))
    console.log('Other page:', body)
  }

  await browser.close()
  console.log('\nDONE')
})().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
