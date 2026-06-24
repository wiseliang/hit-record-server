/**
 * 成绩查询调试脚本 - 逐步导航并截图诊断
 * 用于初次探索 hitwh.edu.cn → VPN → 新教务平台 → 成绩查询 的页面结构
 *
 * 用法:
 *   node debug-grade-query.js [工号] [密码]
 *   或省略参数则从环境变量/命令行交互读取
 */

const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const readline = require('readline')

// 不指定路径，Playwright 自动检测自带 Chromium
const SCREENSHOT_DIR = path.join(__dirname, '..', 'debug_screenshots')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer) }))
}

async function screenshot(page, name, fullPage = false) {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const filename = `${Date.now()}_${name}.png`
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename), fullPage })
  console.log(`  📸 截图: ${filename}`)
  return filename
}

async function dumpPageState(page, stepName) {
  try {
    const state = await page.evaluate(() => ({
      url: location.href.substring(0, 200),
      title: document.title,
      bodyText: document.body ? document.body.innerText.substring(0, 800) : '(no body)',
      visibleButtons: Array.from(document.querySelectorAll('button, a.btn, input[type="submit"], input[type="button"]'))
        .filter(el => {
          const style = window.getComputedStyle(el)
          return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null
        })
        .map(el => ({
          tag: el.tagName,
          text: (el.textContent || el.value || '').trim().substring(0, 60),
          id: el.id || '',
          class: (el.className || '').substring(0, 60),
          href: el.href ? el.href.substring(0, 100) : ''
        }))
        .slice(0, 30),
      visibleLinks: Array.from(document.querySelectorAll('a'))
        .filter(el => el.offsetParent !== null)
        .map(el => ({
          text: el.textContent.trim().substring(0, 60),
          href: el.href ? el.href.substring(0, 120) : ''
        }))
        .slice(0, 20),
      allSelects: Array.from(document.querySelectorAll('select'))
        .map(el => ({
          id: el.id || '', name: el.name || '',
          options: Array.from(el.options).slice(0, 10).map(o => o.textContent.trim())
        })),
      iframes: Array.from(document.querySelectorAll('iframe')).map(f => ({
          src: f.src?.substring(0, 100), id: f.id, name: f.name
        })),
      framesCount: window.frames ? window.frames.length : 0
    }))
    console.log(`\n📄 [${stepName}] 页面状态:`)
    console.log(`   URL: ${state.url}`)
    console.log(`   Title: ${state.title}`)
    console.log(`   Body (前200字): ${state.bodyText.substring(0, 200)}`)
    console.log(`   可见按钮: ${JSON.stringify(state.visibleButtons.slice(0, 10), null, 2)}`)
    console.log(`   可见链接: ${JSON.stringify(state.visibleLinks.slice(0, 10), null, 2)}`)
    if (state.allSelects.length > 0) {
      console.log(`   下拉框: ${JSON.stringify(state.allSelects, null, 2)}`)
    }
    if (state.iframes.length > 0) {
      console.log(`   iframes: ${JSON.stringify(state.iframes, null, 2)}`)
    }
    return state
  } catch (e) {
    console.log(`  ⚠️ dumpPageState 失败: ${e.message}`)
    return null
  }
}

async function tryClick(page, selectors, label) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel)
      if (el) {
        const visible = await el.isVisible().catch(() => false)
        if (visible) {
          await el.click()
          console.log(`  ✅ 点击 ${label}: ${sel}`)
          await sleep(2000)
          return true
        }
      }
    } catch (_) {}
  }
  console.log(`  ⚠️ 未找到可点击元素: ${label}`)
  return false
}

async function tryClickText(page, texts, label) {
  for (const text of texts) {
    try {
      const el = await page.getByText(text, { exact: false }).first()
      if (el) {
        await el.click({ timeout: 3000 })
        console.log(`  ✅ 点击文本 ${label}: "${text}"`)
        await sleep(2000)
        return true
      }
    } catch (_) {}
  }
  console.log(`  ⚠️ 未找到文本: ${label}`)
  return false
}

async function main() {
  let studentId = process.argv[2]
  let password = process.argv[3]

  if (!studentId) studentId = await ask('工号: ')
  if (!password) password = await ask('密码: ')

  console.log('🚀 启动 Chromium...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-extensions','--disable-sync','--no-zygote','--single-process','--disable-features=TranslateUI','--max-old-space-size=128','--disable-component-extensions-with-background-pages']
  })
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-gpu', '--disable-dev-shm-usage'
    ]
  })

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1
  })
  const page = await context.newPage()

  try {
    // ===== Step 1: 打开 hitwh 主页 =====
    console.log('\n📍 Step 1: 打开 hitwh.edu.cn')
    await page.goto('https://www.hitwh.edu.cn/', { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(3000)
    await screenshot(page, '01_hitwh_home', true)
    await dumpPageState(page, 'Step1_hitwh首页')

    // ===== Step 2: 点击"数据库VPN" =====
    console.log('\n📍 Step 2: 查找并点击"数据库VPN"')
    const vpnClicked = await tryClickText(page, ['数据库VPN', 'VPN', '数据库', '快速导航'], 'VPN入口')
    if (!vpnClicked) {
      // 尝试更宽泛的搜索
      console.log('  尝试查找导航中的所有链接...')
      await page.evaluate(() => {
        const links = document.querySelectorAll('a')
        for (const a of links) {
          const text = a.textContent.trim()
          if (text.includes('VPN') || text.includes('数据库')) {
            a.click(); return true
          }
        }
        return false
      })
    }
    await sleep(5000)
    await screenshot(page, '02_after_vpn_click', true)
    await dumpPageState(page, 'Step2_VPN点击后')

    // ===== Step 3: SSO 登录 =====
    console.log('\n📍 Step 3: SSO 统一身份认证登录')
    const currentUrl = page.url()
    if (currentUrl.includes('ids.hit.edu.cn') || currentUrl.includes('authserver')) {
      console.log('  检测到 SSO 登录页面')

      // 填账号密码
      try {
        const usernameInput = await page.$('#username')
        if (usernameInput) {
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
          console.log('  凭证已填写')

          // 检查是否有图片验证码
          const captcha = await page.evaluate(() => {
            const cap = document.getElementById('captcha')
            return !!(cap && cap.offsetParent !== null)
          })
          if (captcha) {
            console.log('  ⚠️ 需要图片验证码!')
            await screenshot(page, '03_captcha_needed')
            const captchaText = await ask('请输入图片验证码: ')
            await page.fill('#captcha', captchaText)
            await sleep(300)
          }

          // 点击登录
          await page.evaluate(() => {
            const btn = document.querySelector('#login_submit')
            if (btn) { btn.click(); return }
            const form = document.querySelector('.loginFromClass') || document.querySelector('form')
            if (form) form.submit()
          })
          console.log('  已提交登录')
        }
      } catch (e) {
        console.log(`  ⚠️ 填写凭证出错: ${e.message}`)
      }
    }

    // 等待跳转
    await sleep(5000)
    await screenshot(page, '04_after_sso', true)
    const afterSsoUrl = page.url()
    await dumpPageState(page, 'Step3_SSO登录后')

    // ===== Step 4: 检查 MFA =====
    const isMfa = afterSsoUrl.includes('reAuth') || afterSsoUrl.includes('multifactor') ||
      await page.evaluate(() => {
        return !!(document.querySelector('#dynamicCode') || document.querySelector('#code') || document.querySelector('[name="code"]'))
      })

    if (isMfa) {
      console.log('\n📍 Step 4: MFA 验证码')
      // 点击获取验证码
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button')
        for (const b of btns) {
          const t = (b.textContent || '').trim()
          if (t.includes('Obtain') || t.includes('获取') || t.includes('Send')) {
            b.click(); return
          }
        }
      })
      await sleep(2000)
      await screenshot(page, '05_mfa_page')

      const code = await ask('请输入 HIT APP 验证码: ')
      const codeInput = await page.$('#dynamicCode') || await page.$('#code') || await page.$('[name="code"]')
      if (codeInput) {
        await codeInput.fill(code)
        await sleep(300)
        // 点击登录
        await page.evaluate(() => {
          const btns = document.querySelectorAll('button')
          for (const b of btns) {
            const t = (b.textContent || '').trim()
            if (t === '登录' || t === 'Sign in') { b.click(); return }
          }
        })
        await sleep(3000)
        // 信任弹窗
        await page.evaluate(() => {
          const btns = document.querySelectorAll('button')
          for (const b of btns) {
            const t = (b.textContent || '').trim()
            if (t === '信任此设备' || t === '仅本次登录' || t === '信任' ||
                t === 'Trust this device' || t === 'Login this time only' || t === 'Trust') {
              b.click(); return
            }
          }
        })
        await sleep(3000)
      }
    }

    await screenshot(page, '06_after_mfa', true)
    const afterMfaUrl = page.url()
    await dumpPageState(page, 'Step4_MFA后')

    // ===== Step 5: VPN 门户 - 查找"新教务平台" =====
    console.log('\n📍 Step 5: VPN门户 - 查找"新教务平台"')
    await screenshot(page, '07_vpn_portal', true)

    const jwClicked = await tryClickText(page, ['新教务平台', '新教务', '教务平台', '教务系统', '教务管理', '本科教学'], '新教务平台')
    if (!jwClicked) {
      console.log('  尝试点击应用中心热门区域...')
      await page.evaluate(() => {
        const all = document.querySelectorAll('a, div, span, li')
        for (const el of all) {
          const text = el.textContent.trim()
          if (text.includes('教务')) { el.click(); return true }
        }
        return false
      })
    }
    await sleep(5000)
    await screenshot(page, '08_after_jw_click', true)
    await dumpPageState(page, 'Step5_新教务平台点击后')

    // ===== Step 6: 新教务平台 SSO 再登录（可能自动） =====
    console.log('\n📍 Step 6: 新教务平台认证')
    const afterJwUrl = page.url()
    if (afterJwUrl.includes('ids.hit.edu.cn') || afterJwUrl.includes('authserver')) {
      console.log('  需要二次 SSO 认证（可能自动跳转）...')
      // 等待自动跳转
      await page.waitForURL(url => !url.includes('ids.hit.edu.cn') && !url.includes('authserver'), { timeout: 15000 }).catch(() => {})
      await sleep(3000)
    }
    await screenshot(page, '09_new_platform', true)
    await dumpPageState(page, 'Step6_新教务平台')

    // ===== Step 7: 导航到成绩查询 =====
    console.log('\n📍 Step 7: 导航到成绩管理 → 班主任导员成绩查询')
    // 先找成绩管理
    await tryClickText(page, ['成绩管理', '成绩'], '成绩管理')
    await sleep(2000)
    await screenshot(page, '10_grade_mgmt', true)

    // 再找班主任导员成绩查询
    await tryClickText(page, ['班主任导员成绩查询', '导员成绩查询', '成绩查询', '班主任'], '班主任导员成绩查询')
    await sleep(3000)
    await screenshot(page, '11_grade_query_page', true)
    await dumpPageState(page, 'Step7_成绩查询页面')

    // ===== Step 8: 填写查询条件并查询 =====
    console.log('\n📍 Step 8: 填写查询条件')
    await screenshot(page, '12_query_form', true)

    // 尝试选择年级
    const state = await dumpPageState(page, 'Step8_查询表单')
    if (state && state.allSelects.length > 0) {
      console.log('  找到下拉框，尝试设置筛选条件...')
      // 尝试设置各下拉框的值
      for (const sel of state.allSelects) {
        const selId = sel.id || sel.name
        // 年级
        if (sel.options.some(o => o.includes('2022')) && (selId.includes('year') || selId.includes('nj') || selId.includes('年级') || sel.id.includes('nj'))) {
          await page.selectOption(`#${sel.id}`, '2022').catch(() => {})
          console.log(`  尝试选择2022年级: #${sel.id}`)
        }
        // 院系
        if (sel.options.some(o => o.includes('信息')) && (selId.includes('school') || selId.includes('yx') || selId.includes('院系') || sel.id.includes('yx'))) {
          await page.selectOption(`#${sel.id}`, { label: '信息科学与工程学院' }).catch(() => {})
          console.log(`  尝试选择院系: #${sel.id}`)
        }
        // 专业
        if (sel.options.some(o => o.includes('自动化')) && (selId.includes('major') || selId.includes('zy') || selId.includes('专业') || sel.id.includes('zy'))) {
          await page.selectOption(`#${sel.id}`, { label: '自动化' }).catch(() => {})
          console.log(`  尝试选择专业: #${sel.id}`)
        }
      }
    }

    // 点击查询按钮
    console.log('  点击查询按钮...')
    await tryClickText(page, ['查询', '查 询', '搜索', '提交'], '查询按钮')
    await sleep(4000)
    await screenshot(page, '13_query_result', true)
    await dumpPageState(page, 'Step8_查询结果')

    // ===== Step 9: 点击"按班级查询"并提取数据 =====
    console.log('\n📍 Step 9: 按班级查询并提取学生数据')
    const byClassClicked = await tryClickText(page, ['按班级查询', '班级查询', '按班级'], '按班级查询')
    if (!byClassClicked) {
      console.log('  尝试查找其他分组查询按钮...')
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button, a')
        for (const b of btns) {
          if (b.textContent.includes('班级') || b.textContent.includes('分组')) {
            b.click(); return true
          }
        }
      })
    }
    await sleep(3000)
    await screenshot(page, '14_class_result', true)

    // 提取表格数据
    console.log('\n📍 尝试提取表格数据...')
    const tableData = await page.evaluate(() => {
      const tables = document.querySelectorAll('table')
      const result = []
      for (const table of tables) {
        const rows = table.querySelectorAll('tr')
        const headers = []
        const dataRows = []
        for (const row of rows) {
          const cells = row.querySelectorAll('th, td')
          const cellTexts = Array.from(cells).map(c => c.textContent.trim())
          if (row.querySelector('th')) {
            headers.push(cellTexts)
          } else if (cellTexts.length > 2) {
            dataRows.push(cellTexts)
          }
        }
        result.push({ headerCount: headers.length, rowCount: dataRows.length, headers: headers[0] || [], sampleRows: dataRows.slice(0, 5) })
      }
      return result
    })
    console.log('  表格数据:', JSON.stringify(tableData, null, 2))

    // ===== Step 10: 尝试点击第一个学生的查看按钮 =====
    if (tableData.length > 0 && tableData[0].rowCount > 0) {
      console.log('\n📍 Step 10: 尝试提取第一个学生的课程详情')
      // 查找放大镜图标或查看链接
      const detailClicked = await page.evaluate(() => {
        const selectors = [
          'a[title*="查看"]', 'img[alt*="查看"]', '.fa-search', '.icon-search',
          'a.view-link', 'a.detail-link', 'img[src*="search"]', 'img[src*="magnifier"]',
          'span.glyphicon-search', 'i.fa-search', 'button[title*="查看"]',
          'a:has(img[alt*="查看"])'
        ]
        // 泛型搜索：找表格第一行中的小图标链接
        const table = document.querySelector('table')
        if (table) {
          const firstRow = table.querySelector('tbody tr, tr')
          if (firstRow) {
            const links = firstRow.querySelectorAll('a')
            for (const a of links) {
              const text = a.textContent.trim()
              const hasIcon = a.querySelector('img, i, span.glyphicon')
              // 小文本或带图标的链接可能就是查看按钮
              if ((text.length <= 4 && text.length > 0) || hasIcon) {
                a.click(); return { type: 'short_link', text }
              }
            }
            // 尝试最后一个链接（通常查看在最右边）
            if (links.length > 0) {
              const lastLink = links[links.length - 1]
              lastLink.click()
              return { type: 'last_link', text: lastLink.textContent.trim() }
            }
          }
        }
        return null
      })
      console.log(`  详情点击结果: ${JSON.stringify(detailClicked)}`)
      await sleep(3000)
      await screenshot(page, '15_student_detail', true)
      await dumpPageState(page, 'Step10_学生课程详情')

      // 提取课程表格
      const courseData = await page.evaluate(() => {
        const tables = document.querySelectorAll('table')
        const result = []
        for (const table of tables) {
          const rows = table.querySelectorAll('tr')
          const dataRows = []
          for (const row of rows) {
            const cells = row.querySelectorAll('td')
            if (cells.length >= 4) {
              dataRows.push(Array.from(cells).map(c => c.textContent.trim()))
            }
          }
          if (dataRows.length > 0) result.push({ rowCount: dataRows.length, sample: dataRows.slice(0, 3) })
        }
        return result
      })
      console.log('  课程数据:', JSON.stringify(courseData, null, 2))

      // 返回
      console.log('  点击返回...')
      await tryClickText(page, ['返回', '关闭', '取消', 'Back', 'Close'], '返回按钮')
      await sleep(2000)
      await screenshot(page, '16_after_back', true)
    }

    console.log('\n✅ 调试完成! 截图保存在: ' + SCREENSHOT_DIR)
    console.log('请检查截图和日志以确定实际的选择器，然后更新 gradeQuery.js')

  } catch (e) {
    console.error('❌ 调试失败:', e.message)
    await screenshot(page, '99_error', true)
  } finally {
    await browser.close()
    console.log('浏览器已关闭')
  }
}

main()
