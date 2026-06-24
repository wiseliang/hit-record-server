const logger = require('../utils/logger')
const { getBaseDate } = require('../utils/week')
const { closeDialog, randomDateTime } = require('./companion')

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 录入谈话（支持可配置参数）
 * @param {object} opts - { scene: '走访寝室'|'走访课堂', content: string }
 */
async function recordTalk(page, index, week, opts = {}) {
  const scene = opts.scene || '走访寝室'
  const content = opts.content || (scene === '走访寝室' ? '查寝' : '查课')
  const force = opts.force || false

  try {
    const clicked = await page.evaluate(({ idx }) => {
      const links = document.querySelectorAll('a')
      const btns = Array.from(links).filter(a => a.textContent.includes('编辑/查看'))
      if (idx < btns.length) {
        btns[idx].scrollIntoView({ block: 'center' })
        btns[idx].click()
        return true
      }
      return false
    }, { idx: index })

    if (!clicked) return { result: 'error', reason: '编辑/查看按钮未找到' }
    await sleep(2000)

    // 谈话tab
    await page.evaluate(() => {
      const th = document.querySelector('li#th')
      if (th) th.click()
    })
    await sleep(1000)

    // 记录当前 grid 行数（新增前，force 模式也需记录用于保存验证）
    const beforeCount = await page.evaluate(() => {
      const grid = document.querySelector('#xq_th_grid')
      if (!grid) return -1
      return grid.querySelectorAll('tbody tr').length
    })

    // 去重（force 模式跳过）
    if (!force && beforeCount > 0) {
      await closeDialog(page)
      return { result: 'skipped', reason: `已有${beforeCount}条谈话记录` }
    }

    // 新增
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button')
      for (const b of btns) {
        if (b.textContent.includes('新增')) { b.scrollIntoView({ block: 'center' }); b.click(); return }
      }
    })
    await sleep(2000)

    // 填写时间
    const dt = randomDateTime(week)
    // 使用 Kendo DateTimePicker API 设置时间（如果可用），否则直接用 value
    await page.evaluate(({ dtStr }) => {
      const inp = document.getElementById('xsth_thsj')
      if (!inp) return
      // 尝试 Kendo API
      try {
        if (typeof $ !== 'undefined') {
          const widget = $(inp).data('kendoDateTimePicker')
          if (widget) { widget.value(dtStr); return }
        }
      } catch (_) {}
      // Fallback: 直接设置 value
      inp.value = dtStr
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.dispatchEvent(new Event('change', { bubbles: true }))
    }, { dtStr: dt })
    await sleep(300)

    // 选择谈话场景
    await page.evaluate(() => {
      const dd = document.querySelector('[aria-owns="xsth_thcj_listbox"]')
      if (dd) dd.click()
    })
    await sleep(500)
    await page.evaluate(({ sceneName }) => {
      const items = document.querySelectorAll('.k-list-item, .k-item, li')
      for (const item of items) {
        if (item.textContent.trim() === sceneName && item.offsetParent !== null) { item.click(); return }
      }
    }, { sceneName: scene })
    await sleep(300)

    // 工作内容
    await page.evaluate(({ text }) => {
      const ta = document.getElementById('xsth_bz')
      if (ta) {
        // 尝试 Kendo API
        try {
          if (typeof $ !== 'undefined') {
            const widget = $(ta).data('kendoEditor') || $(ta).data('kendoTextArea')
            if (widget) { widget.value(text); return }
          }
        } catch (_) {}
        // Fallback
        ta.value = text
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }, { text: content })
    await sleep(300)

    // 保存 — 找到弹窗内的保存按钮
    let saveClicked = await page.evaluate(() => {
      // 优先找弹窗内的保存按钮
      const dialogs = document.querySelectorAll('.k-window, .k-dialog, [role="dialog"], .k-edit-form-container')
      for (const dlg of dialogs) {
        if (dlg.offsetParent === null) continue
        const btns = dlg.querySelectorAll('button')
        for (const b of btns) {
          if (b.textContent.includes('保存') && b.offsetParent !== null) { b.click(); return true }
        }
      }
      // 兜底：全局查找
      const btns = document.querySelectorAll('button')
      for (const b of btns) {
        if (b.textContent.includes('保存') && b.offsetParent !== null) { b.click(); return true }
      }
      return false
    })
    if (!saveClicked) {
      await closeDialog(page)
      return { result: 'error', reason: '未找到保存按钮' }
    }

    // 等待保存结果 — 检查 grid 行数是否增加
    await sleep(2000)
    const afterCount = await page.evaluate(() => {
      const grid = document.querySelector('#xq_th_grid')
      if (!grid) return -1
      return grid.querySelectorAll('tbody tr').length
    })

    await closeDialog(page)

    if (afterCount === -1) {
      // 无法确认 — 弹窗可能已关闭，保守认为成功
      logger.info('Save: grid not found, assuming success')
      return { result: 'success' }
    }
    if (afterCount > beforeCount) {
      logger.info(`Save confirmed: grid ${beforeCount} → ${afterCount}`)
      return { result: 'success' }
    }
    return { result: 'error', reason: `保存后 grid 行数未增加 (${beforeCount}→${afterCount})` }

  } catch (e) {
    try { await closeDialog(page) } catch (_) {}
    return { result: 'error', reason: e.message?.substring(0, 100) || '未知错误' }
  }
}

module.exports = { recordTalk }
