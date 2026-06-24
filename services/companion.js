const logger = require('../utils/logger')
const { getBaseDate } = require('../utils/week')

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 录入陪伴（支持可配置参数）
 * @param {object} opts - { pbType: '共同上课'|'共同进餐'|'共上自习'|'共同运动', content: string }
 */
async function recordCompanion(page, index, week, opts = {}) {
  const pbType = opts.pbType || '共同上课'
  const content = opts.content || (pbType === '共同上课' ? '查课' : '')
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
    await sleep(1500)

    // 陪伴tab
    await page.evaluate(() => {
      const pb = document.querySelector('li#pb')
      if (pb) pb.click()
    })
    await sleep(1000)

    // 记录当前 grid 行数（新增前，force 模式也需记录用于保存验证）
    const beforeCount = await page.evaluate(() => {
      const grid = document.querySelector('#xq_pb_grid')
      if (!grid) return -1
      return grid.querySelectorAll('tbody tr').length
    })

    // 去重（force 模式下跳过）
    if (!force && beforeCount > 0) {
      await closeDialog(page)
      return { result: 'skipped', reason: `已有${beforeCount}条陪伴记录` }
    }

    // 新增（DIV#pb 面板内）
    const added = await page.evaluate(() => {
      const allPb = document.querySelectorAll('#pb')
      for (const el of allPb) {
        if (el.tagName === 'DIV') {
          const btn = el.querySelector('button')
          if (btn) { btn.click(); return true }
        }
      }
      return false
    })

    if (!added) { await closeDialog(page); return { result: 'error', reason: '新增按钮未找到' } }
    await sleep(1500)

    // 填写时间 - 使用 Kendo API
    const dt = randomDateTime(week)
    await page.evaluate(({ dtStr }) => {
      const inp = document.getElementById('pbjl_cysj')
      if (!inp) return
      try {
        if (typeof $ !== 'undefined') {
          const widget = $(inp).data('kendoDateTimePicker')
          if (widget) { widget.value(dtStr); return }
        }
      } catch (_) {}
      inp.value = dtStr
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.dispatchEvent(new Event('change', { bubbles: true }))
    }, { dtStr: dt })
    await sleep(300)

    // 选择陪伴类型
    await page.evaluate(() => {
      const dd = document.querySelector('[aria-owns="pbjl_pblx_listbox"]')
      if (dd) dd.click()
    })
    await sleep(300)
    await page.evaluate(({ type }) => {
      const items = document.querySelectorAll('.k-list-item, .k-item, li')
      for (const item of items) {
        if (item.textContent.trim() === type && item.offsetParent !== null) { item.click(); return }
      }
    }, { type: pbType })
    await sleep(300)

    // 工作内容
    if (content) {
      await page.evaluate(({ text }) => {
        const ta = document.getElementById('pbjl_bz')
        if (!ta) return
        try {
          if (typeof $ !== 'undefined') {
            const widget = $(ta).data('kendoEditor') || $(ta).data('kendoTextArea')
            if (widget) { widget.value(text); return }
          }
        } catch (_) {}
        ta.value = text
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.dispatchEvent(new Event('change', { bubbles: true }))
      }, { text: content })
      await sleep(300)
    }

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
      // 兜底：全局查找（限定在弹窗 scope）
      const btns = document.querySelectorAll('#editPbjlwindow button')
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
      const grid = document.querySelector('#xq_pb_grid')
      if (!grid) return -1
      return grid.querySelectorAll('tbody tr').length
    })

    await closeDialog(page)

    if (afterCount === -1) {
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

async function closeDialog(page) {
  try {
    await page.evaluate(() => {
      const closes = document.querySelectorAll('.k-i-close')
      for (const c of closes) { if (c.offsetParent !== null) { c.click(); break } }
    })
    await sleep(1000)
  } catch (_) {}
}

function randomDateTime(week) {
  const WEEK1 = new Date(2026, 2, 9)
  const now = new Date()
  const base = new Date(WEEK1)
  base.setDate(base.getDate() + (week - 1) * 7)

  // 随机周几，但不超过今天
  const maxOffset = Math.min(6, Math.floor((now - base) / (24 * 60 * 60 * 1000)))
  const offset = maxOffset > 0 ? Math.floor(Math.random() * (maxOffset + 1)) : 0
  const d = new Date(base)
  d.setDate(d.getDate() + offset)

  // 小时不超过当前时间
  const isToday = d.toDateString() === now.toDateString()
  const maxH = isToday ? now.getHours() : 23
  const morning = Math.random() > 0.5
  let h = morning ? (8 + Math.floor(Math.random() * 4)) : (14 + Math.floor(Math.random() * 4))
  if (h > maxH) h = Math.max(8, maxH - 1)

  const m = isToday && h === now.getHours() ? Math.floor(Math.random() * now.getMinutes()) : Math.floor(Math.random() * 60)
  const s = isToday && h === now.getHours() && m === now.getMinutes() ? Math.floor(Math.random() * now.getSeconds()) : Math.floor(Math.random() * 60)

  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
}

module.exports = { recordCompanion, closeDialog, randomDateTime }
