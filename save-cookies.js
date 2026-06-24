/**
 * 手动登录一次，保存 cookies 到文件
 * 在 Windows 上运行: node save-cookies.js
 * 登录成功后 cookies 会保存到 xuegong_cookies.json
 * 把这个文件上传到服务器 /root/server/xuegong_cookies.json
 */
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const OUT = path.join(__dirname, 'xuegong_cookies.json')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('Opening browser...')
  const browser = await chromium.launch({ headless: false })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  console.log('Opening xuegong login page...')
  await page.goto('https://xuegong.hitwh.edu.cn/login?jg=x&url=x', { waitUntil: 'networkidle', timeout: 30000 })

  console.log('\n========================================')
  console.log('  请在浏览器中手动完成登录（解决验证码）')
  console.log('  登录成功后回到这个终端按 Enter')
  console.log('========================================\n')

  // 每 5 秒检查是否已登录
  let loggedIn = false
  while (!loggedIn) {
    await sleep(5000)
    try {
      loggedIn = await page.evaluate(() => {
        const body = document.body.innerText
        return !body.includes('统一身份认证') && !body.includes('用户登录')
          && document.querySelector('.gdoa-menu-title') !== null
      })
      if (loggedIn) {
        console.log('✅ 检测到已登录！')
      }
    } catch (_) {}
  }

  // 保存 cookies
  const cookies = await ctx.cookies()
  fs.writeFileSync(OUT, JSON.stringify(cookies, null, 2))
  console.log(`\n✅ Cookies 已保存到: ${OUT}`)
  console.log(`   文件大小: ${fs.statSync(OUT).size} bytes`)
  console.log(`\n请将这个文件上传到服务器:`)
  console.log(`   scp xuegong_cookies.json root@wiseliang.cloud:/root/server/`)

  await sleep(2000)
  await browser.close()
}

main()
