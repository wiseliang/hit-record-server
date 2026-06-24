/**
 * 独立测试：成绩查询页面数据提取
 * 用法: node test-extraction.js <工号> <密码>
 */
const { chromium } = require('playwright')
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const uid = process.argv[2]
  const pwd = process.argv[3]
  if (!uid || !pwd) { console.log('Usage: node test-extraction.js <工号> <密码>'); process.exit(1) }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-extensions','--disable-sync','--no-zygote','--single-process','--disable-features=TranslateUI','--max-old-space-size=128','--disable-component-extensions-with-background-pages']
  })
  const context = await browser.newContext()
  const page = await context.newPage()

  // ====== 登录到成绩查询页面 ======
  console.log('=== LOGIN ===')
  await page.goto('https://ivpn.hitwh.edu.cn/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(4000)
  console.log('1. SSO URL:', page.url().substring(0, 80))

  // SSO login
  await page.evaluate(() => { const cn = document.querySelector('.cn_btn'); if (cn) cn.click() })
  await sleep(500)
  await page.evaluate(() => { const a = document.getElementById('userNameLogin_a'); if (a) a.click() })
  await sleep(1000)
  await page.evaluate(({u,p}) => {
    for (const i of document.querySelectorAll('#username')) { if (i.offsetParent) { i.value = u; i.dispatchEvent(new Event('input',{bubbles:true})); break } }
    for (const i of document.querySelectorAll('#password')) { if (i.offsetParent && i.type==='password') { i.value = p; i.dispatchEvent(new Event('input',{bubbles:true})); break } }
  }, {u:uid, p:pwd})
  await sleep(200)
  await page.evaluate(() => {
    const p = document.getElementById('password'), s = document.getElementById('pwdEncryptSalt')
    if (p && s && s.value && window.encryptPassword) { document.getElementById('saltPassword').value = window.encryptPassword(p.value, s.value); p.disabled = true }
  })
  await page.evaluate(() => { const b = document.getElementById('login_submit'); if (b) b.click() })
  console.log('2. Login submitted')
  await sleep(8000)

  // MFA
  if (page.url().includes('reAuth')) {
    console.log('3. MFA page, getting code...')
    await page.evaluate(() => { const b = document.getElementById('getDynamicCode'); if (b) b.click() })
    await sleep(2000)
    console.log('   Code sent! Check HIT APP and enter code:')
    const readline = require('readline')
    const rl = readline.createInterface({input:process.stdin,output:process.stdout})
    const code = await new Promise(r => rl.question('Code: ', r))
    rl.close()
    await page.evaluate(c => { const i = document.getElementById('dynamicCode'); if (i) { i.value = c; i.dispatchEvent(new Event('input',{bubbles:true})) } }, code)
    await sleep(300)
    await page.evaluate(() => { const b = document.getElementById('reAuthSubmitBtn'); if (b) b.click() })
    console.log('   Code submitted')
    await sleep(5000)
    for (let i=0;i<3;i++) {
      const t = await page.evaluate(() => { for (const b of document.querySelectorAll('button')) { if (['信任此设备','仅本次登录','信任'].includes(b.textContent.trim()) && b.offsetParent) { b.click(); return b.textContent.trim() } } return null })
      if (t) { console.log('   Trust:', t); await sleep(2000) } else break
    }
    await sleep(8000)
  }

  console.log('4. VPN URL:', page.url().substring(0, 80))

  // Wait for portal resources
  console.log('5. Waiting for portal...')
  for (let i=0;i<15;i++) { await sleep(2000); if (await page.evaluate(() => document.body.innerText.includes('新教务')||document.body.innerText.includes('综合教务'))) { console.log('   Loaded'); break } console.log('   ...'+(i+1)*2+'s') }

  // Click 新教务平台
  console.log('6. Find & click 新教务平台...')
  const coords = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if ((el.textContent.trim()==='新教务系统'||el.textContent.trim()==='新教务平台') && el.children.length<=3 && el.offsetParent) {
        const r = el.getBoundingClientRect(); if (r.width>0) return {x:r.left+r.width/2,y:r.top+r.height/2}
      }
    }
    return null
  })
  if (coords) { console.log(`   Clicking at (${coords.x},${coords.y})`); await page.mouse.click(coords.x, coords.y) }
  await sleep(5000)

  // Wait for platform
  console.log('7. Platform loading...')
  for (let i=0;i<15;i++) { await sleep(2000); const u = page.url(); if (!u.includes('authserver')) { console.log('   URL:',u.substring(0,80)); break } }

  // EAMS role switch
  await sleep(5000)
  console.log('8. EAMS page loaded, switching role...')
  const roleText = await page.evaluate(() => document.body?.innerText?.substring(0,500)||'')
  console.log('   Body:',roleText.substring(0,200))
  const role = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const t = el.textContent.trim()
      if ((t.includes('班主任')||t.includes('辅导员')||t.includes('教师')) && t.includes('视图') && el.offsetParent) { el.click(); return t }
    }
    return null
  })
  if (role) { console.log('   Role clicked:', role); await sleep(5000) }

  // Navigate to 成绩管理 → 班主任导员成绩查询
  console.log('9. Navigate to 班主任导员成绩查询...')
  await page.evaluate(() => { for (const el of document.querySelectorAll('*')) { if (el.textContent.trim()==='成绩管理' && el.offsetParent) { el.click(); return } } })
  await sleep(2000)
  try {
    await page.locator('text=班主任导员成绩查询').first().click({ timeout: 5000 })
    console.log('   Clicked 班主任导员成绩查询')
  } catch(e) {
    console.log('   Locator failed, trying text search...')
    await page.evaluate(() => { for (const el of document.querySelectorAll('*')) { if ((el.textContent||'').trim().includes('班主任导员成绩查询') && el.offsetParent) { el.click(); return } } })
  }
  await sleep(5000)

  console.log('10. Query page URL:', page.url().substring(0, 100))
  console.log('    Body:', (await page.evaluate(() => document.body?.innerText?.substring(0,1000)||'')).substring(0,500))

  // ====== 纯数据提取 ======
  console.log('\n=== DATA EXTRACTION ===')

  // Dump ALL tables
  const tables = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('table')).map((t, i) => {
      const headers = Array.from(t.querySelectorAll('th')).map(h => h.textContent.trim())
      const rows = Array.from(t.querySelectorAll('tr')).filter(r => r.querySelectorAll('td').length > 0)
      return { idx: i, headers, rowCount: rows.length, sampleRows: rows.slice(0, 5).map(r => Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim().substring(0, 20))) }
    })
  })
  console.log('Tables:', JSON.stringify(tables, null, 2))

  // Dump all visible elements with short text
  const texts = await page.evaluate(() => {
    const seen = new Set()
    return Array.from(document.querySelectorAll('*'))
      .filter(el => { const t = el.textContent.trim(); return t.length>=2&&t.length<=20&&el.children.length===0&&el.offsetParent&&!seen.has(t)&&seen.add(t) })
      .map(el => el.textContent.trim()).slice(0, 100)
  })
  console.log('\nVisible texts:', JSON.stringify(texts))

  // Try body innerText parsing
  const bodyText = await page.evaluate(() => document.body.innerText)
  console.log('\n=== FULL BODY ===')
  console.log(bodyText.substring(0, 2000))

  await browser.close()
  console.log('\nDONE')
})().catch(e => console.error('FAIL:', e.message))
