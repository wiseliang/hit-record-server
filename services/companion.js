const logger = require('../utils/logger')
const { getWeekStart } = require('../utils/week')

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
      const btns = Array.from(links).filter(a => a.offsetParent !== null && a.textContent.includes('编辑/查看'))
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
    const dt = opts.recordedAt ? validateRecordDateTime(week, opts.recordedAt) : randomDateTime(week)
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
      return { result: 'error', reason: '保存结果待回查：记录列表不可见，请勿重复提交' }
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
  if (!Number.isInteger(week) || week < 1) throw new Error('无效周次')
  const day = 86400000
  const start = new Date(getWeekStart()+'T00:00:00+08:00').getTime()+(week-1)*7*day
  const end = Math.min(Date.now(), start+7*day-1)
  if (end < start) throw new Error('不能录入未来周次')
  const date = new Date(start+Math.floor(Math.random()*(end-start+1)))
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'
  })
  const p = Object.fromEntries(formatter.formatToParts(date).map(x=>[x.type,x.value]))
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}:${p.second}`
}

function validateRecordDateTime(week, value) {
  const match = /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!match) throw new Error('录入时间格式无效')
  const [, y, m, d, h, min, sec='00'] = match
  const iso = `${y}-${m}-${d}T${h}:${min}:${sec}+08:00`
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime()) || +h>23 || +min>59 || +sec>59 || new Date(`${y}-${m}-${d}T00:00:00Z`).toISOString().slice(0,10)!==`${y}-${m}-${d}`) throw new Error('录入时间无效')
  const { getWeekStart } = require('../utils/week')
  const start = new Date(getWeekStart()+'T00:00:00+08:00').getTime()+(week-1)*7*86400000
  if (date.getTime()<start || date.getTime()>=start+7*86400000) throw new Error('录入时间与所选周次不一致')
  if (date.getTime()>Date.now()) throw new Error('不能录入未来时间')
  return `${y}/${m}/${d} ${h}:${min}:${sec}`
}

module.exports = { recordCompanion, closeDialog, randomDateTime, validateRecordDateTime }
