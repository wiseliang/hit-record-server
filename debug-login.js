/**
 * Linux 服务器端诊断脚本
 * 运行: node debug-login.js > /root/hit-record/debug.log 2>&1
 * 这个脚本会截屏每一步，输出页面DOM信息
 */
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const OUT = '/root/hit-record/debug'
try { fs.mkdirSync(OUT, { recursive: true }) } catch (_) {}

const sleep = ms => new Promise(r => setTimeout(r, ms))
let step = 0

function log(msg, data) {
  const line = `[${String(++step).padStart(2,'0')}] ${msg}`
  console.log(line)
  if (data) console.log(JSON.stringify(data, null, 2))
  console.log('')
}

async function snap(page, name) {
  try { await page.screenshot({ path: path.join(OUT, `${String(step).padStart(2,'0')}-${name}.png`), fullPage: true }) } catch (_) {}
}

async function dumpPage(page) {
  return await page.evaluate(() => {
    const getVisible = (els) => Array.from(els).filter(e => e.offsetParent !== null)
    return {
      url: location.href.substring(0, 120),
      title: document.title,
      bodyText: document.body.innerText.substring(0, 500),
      inputs: Array.from(document.querySelectorAll('input')).map(i => ({
        id: i.id, type: i.type, name: i.name,
        placeholder: i.placeholder, visible: !!i.offsetParent
      })),
      buttons: getVisible(document.querySelectorAll('button')).map(b => ({
        text: (b.textContent || '').trim().substring(0, 40),
        id: b.id, class: b.className.substring(0, 40)
      })),
      links: getVisible(document.querySelectorAll('a')).filter(a => a.textContent.trim()).slice(0, 5).map(a => a.textContent.trim().substring(0, 30)),
      hasEncryptPassword: typeof window.encryptPassword === 'function',
      hasJQuery: typeof $ !== 'undefined',
      hasKendo: typeof $ !== 'undefined' && typeof $.fn !== 'undefined' && typeof $.fn.kendoDropDownList !== 'undefined'
    }
  })
}

async function main() {
  console.log('=== Linux Server Debug Test ===')
  console.log('Output dir:', OUT)
  console.log('')

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  try {
    // ===== STEP 1: Login page =====
    log('Opening xuegong login page')
    await page.goto('https://xuegong.hitwh.edu.cn/login?jg=x&url=x', { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(2000)
    const s1 = await dumpPage(page)
    await snap(page, 'login-page')
    log('Login page state', { url: s1.url, hasSsoBtn: s1.buttons.some(b => b.text.includes('统一身份')), totalButtons: s1.buttons.length })

    // ===== STEP 2: Click SSO =====
    log('Clicking SSO button')
    const ssoBtn = await page.$('#xg_login_tysfrz_btn')
    if (!ssoBtn) { log('ERROR: SSO button not found!', { buttons: s1.buttons }); return }
    await ssoBtn.click()
    await sleep(4000)
    const s2 = await dumpPage(page)
    await snap(page, 'sso-page')
    log('SSO page state', {
      url: s2.url,
      hasUsername: s2.inputs.some(i => i.id === 'username'),
      hasPassword: s2.inputs.some(i => i.id === 'password'),
      hasSalt: s2.inputs.some(i => i.id === 'pwdEncryptSalt'),
      hasEncrypt: s2.hasEncryptPassword,
      allInputs: s2.inputs.map(i => `${i.id}:${i.type}:${i.visible ? 'vis' : 'hid'}`)
    })

    // ===== STEP 3: Fill credentials =====
    log('Filling credentials')
    try {
      await page.fill('#username', '20226032')
      await page.fill('#password', 'W1seliang')
      log('Credentials filled')
    } catch (e) {
      log('ERROR filling credentials: ' + e.message, { inputs: s2.inputs })
      return
    }

    // ===== STEP 4: Encrypt password =====
    log('Encrypting password')
    const encInfo = await page.evaluate(() => {
      const pwd = document.getElementById('password')
      const salt = document.getElementById('pwdEncryptSalt')
      const saltPwd = document.getElementById('saltPassword')
      if (!pwd) return { error: 'no #password' }
      if (!salt) return { error: 'no #pwdEncryptSalt' }
      if (!saltPwd) return { error: 'no #saltPassword' }
      if (!salt.value) return { error: 'salt is empty' }
      if (typeof window.encryptPassword !== 'function') return { error: 'encryptPassword not a function', typeof: typeof window.encryptPassword }
      try {
        const enc = window.encryptPassword(pwd.value, salt.value)
        saltPwd.value = enc
        pwd.disabled = true
        return { success: true, encLen: enc.length, saltLen: salt.value.length }
      } catch (e) {
        return { error: 'encryptPassword threw: ' + e.message }
      }
    })
    log('Encrypt result', encInfo)
    await snap(page, 'after-encrypt')

    // ===== STEP 5: Click login =====
    log('Clicking login button')
    const loginBtnInfo = await page.evaluate(() => {
      const selectors = ['#login_submit', '#login', 'button[name="submit"]', '.login-btn']
      for (const sel of selectors) {
        const el = document.querySelector(sel)
        if (el && el.offsetParent !== null) {
          el.click()
          return { clicked: sel }
        }
      }
      // fallback
      const form = document.querySelector('form')
      if (form) { form.submit(); return { clicked: 'form submit' } }
      return { clicked: null }
    })
    log('Login button', loginBtnInfo)

    // ===== STEP 6: Wait for redirect =====
    log('Waiting for post-login redirect...')
    try { await page.waitForURL(u => u.includes('reAuth') || u.includes('multifactor') || u.includes('xuegong'), { timeout: 15000 }) } catch (_) {}
    await sleep(3000)
    const s3 = await dumpPage(page)
    await snap(page, 'after-login')
    log('After login', {
      url: s3.url,
      isMfa: s3.url.includes('reAuth') || s3.url.includes('multifactor'),
      isXuegong: s3.url.includes('xuegong'),
      bodySnippet: s3.bodyText.substring(0, 300),
      visibleButtons: s3.buttons.map(b => b.text),
      visibleInputs: s3.inputs.filter(i => i.visible).map(i => `${i.id}:${i.placeholder || ''}`)
    })

    // ===== STEP 7: Handle MFA =====
    if (s3.url.includes('reAuth') || s3.url.includes('multifactor')) {
      log('=== MFA DETECTED ===')

      // Check for "获取验证码" button
      const getCodeBtn = await page.evaluate(() => {
        const btns = document.querySelectorAll('button')
        for (const b of btns) {
          if ((b.textContent || '').includes('获取') && b.offsetParent !== null) {
            return { found: true, text: b.textContent.trim(), id: b.id, class: b.className }
          }
        }
        return { found: false }
      })
      log('Get-code button', getCodeBtn)

      // Find code input
      const codeInputInfo = await page.evaluate(() => {
        const inputs = ['#dynamicCode', '#code', '[name="code"]', 'input[type="text"]:not([id="username"])']
        for (const sel of inputs) {
          const el = document.querySelector(sel)
          if (el && el.offsetParent !== null) {
            return { selector: sel, id: el.id, name: el.name, placeholder: el.placeholder }
          }
        }
        return null
      })
      log('Code input info', codeInputInfo)

      if (getCodeBtn.found) {
        log('Clicking "获取验证码"')
        await page.evaluate(() => {
          const btns = document.querySelectorAll('button')
          for (const b of btns) {
            if ((b.textContent || '').includes('获取') && b.offsetParent !== null) { b.click(); return }
          }
        })
        await sleep(1500)
        await snap(page, 'after-get-code')
        log('✅ Code request sent. Check HIT APP.')
        log('NOTE: Code NOT submitted in this debug script. Run with code: node debug-login.js <CODE>')
      } else {
        log('❌ "获取验证码" button NOT FOUND in visible buttons')
      }
    } else {
      log('No MFA required (already logged in or auto-login)')
    }

    console.log('\n=== DEBUG COMPLETE ===')
    console.log('Screenshots saved to:', OUT)
    console.log('Run: ls -la', OUT)

    await sleep(5000)
  } catch (e) {
    console.error('FATAL ERROR:', e.message)
    console.error(e.stack)
  } finally {
    await browser.close()
  }
}

main()
