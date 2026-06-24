const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const sleep = ms => new Promise(r => setTimeout(r, ms))

const SIGNAL_DIR = path.join(__dirname, '..')
const READY_FILE = path.join(SIGNAL_DIR, 'mfa_ready.txt')
const CODE_FILE = path.join(SIGNAL_DIR, 'mfa_code.txt')

const CODE = process.argv[2] || ''

// Clean up old files
try { fs.unlinkSync(READY_FILE) } catch (_) {}
try { fs.unlinkSync(CODE_FILE) } catch (_) {}

async function waitForCode() {
  console.log('⏳ Waiting for verification code...')
  console.log('   (I will write the code to mfa_code.txt when you provide it)')

  // Signal ready
  fs.writeFileSync(READY_FILE, Date.now().toString())

  // Poll for code file
  while (true) {
    try {
      const code = fs.readFileSync(CODE_FILE, 'utf8').trim()
      if (code && code.length >= 4) {
        fs.unlinkSync(CODE_FILE)
        return code
      }
    } catch (_) {}
    await sleep(1000)
  }
}

async function main() {
  console.log('Starting browser...')
  const browser = await chromium.launch({ headless: false })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  async function handleTrustDialog() {
    const r = await page.evaluate(() => {
      const btns = document.querySelectorAll('button')
      for (const b of btns) {
        const t = (b.textContent || '').trim()
        if (b.offsetParent !== null && (t === '信任此设备' || t === '仅本次登录' || t === '信任')) {
          b.click(); return t
        }
      }
      return null
    })
    if (r) console.log('   Handled:', r)
    return r
  }

  try {
    console.log('[1] Open login page')
    await page.goto('https://xuegong.hitwh.edu.cn/login?jg=x&url=x', { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(2000)

    console.log('[2] Click SSO')
    await page.click('#xg_login_tysfrz_btn')
    await sleep(3000)

    console.log('[3] Fill credentials + encrypt')
    await page.fill('#username', '20226032')
    await page.fill('#password', 'W1seliang')
    await page.evaluate(() => {
      const pwd = document.getElementById('password')
      const salt = document.getElementById('pwdEncryptSalt')
      if (pwd && salt && salt.value && window.encryptPassword) {
        document.getElementById('saltPassword').value = window.encryptPassword(pwd.value, salt.value)
        pwd.disabled = true
      }
    })

    console.log('[4] Click login')
    await page.click('#login_submit')
    try { await page.waitForURL(u => u.includes('reAuth') || u.includes('multifactor') || u.includes('xuegong'), { timeout: 15000 }) } catch (_) {}
    await sleep(2000)
    console.log('   URL:', page.url().substring(0, 100))

    if (page.url().includes('reAuth') || page.url().includes('multifactor')) {
      let code = CODE

      if (!code) {
        // Interactive mode: click get code, wait for user
        console.log('[5] MFA required - clicking "获取验证码"')
        await page.evaluate(() => {
          const btns = document.querySelectorAll('button')
          for (const b of btns) {
            if ((b.textContent || '').trim() === '获取验证码' && b.offsetParent !== null) { b.click(); return }
          }
        })
        await sleep(1500)
        console.log('   ✅ 验证码已发送！请查看 HIT APP\n')
        code = await waitForCode()
        console.log('   Got code:', code)
      } else {
        // Batch mode: use provided code, don't re-click get code
        console.log('[5] MFA required - using provided code (skip re-get)\n')
      }

      console.log('[6] Filling code...')
      await page.fill('#dynamicCode', code)
      await sleep(300)

      const val = await page.$eval('#dynamicCode', el => el.value)
      console.log('   Filled value:', val)

      console.log('[7] Click 登录 on MFA page')
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button')
        for (const b of btns) {
          if ((b.textContent || '').trim() === '登录' && b.offsetParent !== null) { b.click(); return }
        }
      })
      await sleep(3000)

      // Handle trust dialog
      console.log('[8] Checking trust dialog...')
      await handleTrustDialog()
      await sleep(1500)
      await handleTrustDialog()
      await sleep(1500)
      await handleTrustDialog()
      await sleep(1000)

      // Wait for redirect to xuegong
      console.log('[9] Waiting for xuegong redirect...')
      try { await page.waitForURL(u => u.includes('xuegong'), { timeout: 20000 }) } catch (_) {}
      await sleep(3000)
      console.log('   URL:', page.url().substring(0, 100))

      // Final trust dialog
      await handleTrustDialog()
      await sleep(1000)
    }

    // Verify on xuegong
    const onXuegong = page.url().includes('xuegong') && !page.url().includes('login?')
    if (!onXuegong) {
      console.log('\n❌ Not on xuegong. URL:', page.url().substring(0, 100))
      const errText = await page.evaluate(() => {
        const body = document.body.innerText
        if (body.includes('验证码错误')) return '验证码错误'
        if (body.includes('过期')) return '验证码已过期'
        if (body.includes('错误')) return body.substring(body.indexOf('错误'), body.indexOf('错误') + 50)
        return body.substring(0, 200)
      })
      console.log('   Page text:', errText)
      console.log('\nBrowser stays open for debugging...')
      await sleep(120000)
      return
    }

    console.log('\n🎉 On xuegong!')

    // === NAVIGATE TO WORK LOG ===
    console.log('[10] Navigate to work log...')
    const pagesBefore = ctx.pages().length

    for (const menu of ['学工队伍建设', '辅导员日志管理']) {
      console.log('   ', menu)
      await page.evaluate((text) => {
        for (const el of document.querySelectorAll('.gdoa-menu-title, .gdoa-item-title')) {
          if (el.textContent.includes(text)) { el.click(); return }
        }
      }, menu)
      await sleep(1000)
    }

    console.log('    日志填写（辅）')
    const before = ctx.pages().length
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('.gdoa-item-one')) {
        if (el.textContent.includes('日志填写（辅）')) { el.click(); return }
      }
    })
    await sleep(4000)

    const allPages = ctx.pages()
    const workPage = allPages.length > before ? allPages[allPages.length - 1] : page
    if (allPages.length > before) {
      try { await workPage.waitForLoadState('domcontentloaded', { timeout: 10000 }) } catch (_) {}
      console.log('   New tab opened')
    }
    console.log('   URL:', (await workPage.url()).substring(0, 100))
    console.log('   Title:', await workPage.title())

    // === CHECK TABS ===
    const info = await workPage.evaluate(() => ({
      tabs: Array.from(document.querySelectorAll('.k-tabstrip-items .k-item')).map(t => t.textContent.trim()),
      hasGarz: !!document.getElementById('garz_zc')
    }))
    console.log('   Tabs:', info.tabs)
    console.log('   Has garz_zc:', info.hasGarz)

    if (info.tabs.includes('学情日志')) {
      console.log('[11] Switch to 学情日志...')
      await workPage.evaluate(() => {
        const tabs = document.querySelectorAll('.k-tabstrip-items .k-item')
        for (const t of tabs) {
          if (t.textContent.trim() === '学情日志' && !t.classList.contains('k-state-active')) { t.click(); return }
        }
      })
      await sleep(3000)

      const after = await workPage.evaluate(() => {
        const inp = document.getElementById('garz_zc')
        let weekText = null, weekData = []
        if (inp) {
          try {
            const w = $(inp).data('kendoDropDownList')
            weekText = w.text()
            weekData = w.dataSource.data().map(d => d.dmmc)
          } catch (_) {}
        }
        return {
          hasGarz: !!inp,
          weekText,
          availableWeeks: weekData.slice(0, 5),
          studentCount: Array.from(document.querySelectorAll('a')).filter(a => a.textContent.includes('编辑/查看')).length
        }
      })
      console.log('   Result:', JSON.stringify(after, null, 2))

      if (after.hasGarz) {
        console.log('\n🎉🎉🎉 ALL CHECKS PASSED!')
        console.log('   Week:', after.weekText)
        console.log('   Students:', after.studentCount)
      }
    } else {
      console.log('\n⚠️ No 学情日志 tab found')
    }

    console.log('\n✅ Test complete. Browser stays open 60s...')
    await sleep(60000)

  } catch (e) {
    console.error('💥 Error:', e.message)
    await sleep(120000)
  } finally {
    try { fs.unlinkSync(READY_FILE) } catch (_) {}
    try { fs.unlinkSync(CODE_FILE) } catch (_) {}
    await browser.close()
  }
}

main()
