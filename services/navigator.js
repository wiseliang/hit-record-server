const logger = require('../utils/logger')
const { getAcademicTerm } = require('../utils/week')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function closeAllPopups(page) {
  try {
    await page.evaluate(() => {
      // 关闭 Kendo 弹窗
      document.querySelectorAll('.k-i-close').forEach(c => c.click())
      // 点击"确定"按钮关闭提示弹窗
      const btns = document.querySelectorAll('button')
      for (const b of btns) {
        if ((b.textContent || '').trim() === '确定' && b.offsetParent !== null) { b.click(); return }
      }
    })
  } catch (_) {}
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('.k-window')).some(el => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden'), undefined, { timeout: 10000 })
}

async function switchToXueqing(page) {
  // 守卫：检查是否在 SSO 登录页（session 过期）
  const currentUrl = page.url()
  if (currentUrl.includes('ids.hit.edu.cn') || currentUrl.includes('authserver')) {
    logger.error('switchToXueqing: page is on authserver, session expired. URL: ' + currentUrl.substring(0, 100))
    throw new Error('SESSION_EXPIRED')
  }

  // 检查页面状态
  const info = await page.evaluate(() => ({
    url: location.href.substring(0, 100),
    bodySnippet: document.body.innerText.substring(0, 200),
    garzExists: !!document.getElementById('garz_zc'),
    // 查找所有可能的 tab 元素
    allLinks: Array.from(document.querySelectorAll('a, li, .k-item, [role="tab"]'))
      .map(el => ({ text: el.textContent.trim().substring(0, 30), tag: el.tagName, class: el.className?.substring(0, 30) }))
      .filter(x => x.text.length <= 10 && x.text.length > 0)
      .slice(0, 10)
  }))
  logger.info('Page state:', {url:info.url,weekWidgetPresent:info.garzExists})

  // 如果 garz_zc 已存在且 Kendo widget 已初始化，说明已在学情日志 tab
  if (info.garzExists) {
    // 验证 Kendo widget 确实可用（garz_zc 可能在隐藏的 tab 中也存在）
    const widgetReady = await page.evaluate(() => {
      if (typeof $ === 'undefined') return false
      try {
        const w = $('#garz_zc').data('kendoDropDownList')
        return !!(w && w.wrapper.is(':visible') && w.dataSource && w.dataSource.data() && w.dataSource.data().length > 0)
      } catch (_) { return false }
    }).catch(() => false)

    if (widgetReady) {
      logger.info('Already on 学情日志 tab (widget ready)')
      return
    }
    logger.info('garz_zc exists but Kendo widget not ready, will try clicking 学情日志 tab')
  }

  // 用多种方式点击"学情日志" tab
  let clicked = false

  // 方式1: 通用文字匹配
  try {
    clicked = await page.evaluate(() => {
      const selectors = ['a', 'li', 'span', 'div', '.k-item', '[role="tab"]']
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.textContent.trim() === '学情日志' && el.offsetParent !== null) {
            el.click(); return true
          }
        }
      }
      // 包含匹配
      for (const el of document.querySelectorAll('a, li, span, div')) {
        if (el.textContent.includes('学情日志') && el.offsetParent !== null) {
          el.click(); return true
        }
      }
      return false
    })
  } catch (_) {}

  if (!clicked) {
    // 方式2: Playwright 点击
    try { await page.click('text=学情日志', { timeout: 5000 }); clicked = true } catch (_) {}
  }

  logger.info('学情日志 tab clicked: ' + clicked)
  await sleep(2000)

  // 等待 garz_zc 出现
  for (let i = 0; i < 10; i++) {
    const exists = await page.evaluate(() => typeof $ !== 'undefined' && !!$('#garz_zc').data('kendoDropDownList')?.wrapper.is(':visible'))
    if (exists) { logger.info('garz_zc appeared'); return }
    await sleep(1000)
  }

  // 失败诊断
  const diag = await page.evaluate(() => ({
    url: location.href.substring(0, 100),
    inputs: Array.from(document.querySelectorAll('input')).map(i => i.id).filter(Boolean),
    body: document.body.innerText.substring(0, 300)
  }))
  logger.error('garz_zc not found', {url:diag.url,inputs:diag.inputs})
  throw new Error(`页面未加载学情日志周次选择器。当前URL: ${diag.url}，inputs: ${diag.inputs.join(',')}`)
}

/**
 * 确保学年度和学期已选择，否则周次下拉框无数据
 * 必须在 switchToXueqing 之后、selectWeek 之前调用
 */
async function ensureAcademicFilters(page, weekNumber) {
  // Week numbers restart every semester; derive the term from its configured
  // first Monday, never from a threshold such as week <= 26.
  const { academicYear, semester } = getAcademicTerm()

  logger.info(`ensureAcademicFilters: week=${weekNumber}, year=${academicYear}, semester=${semester}`)

  // 等待 jQuery
  for (let i = 0; i < 10; i++) {
    const ready = await page.evaluate(() => typeof $ !== 'undefined').catch(() => false)
    if (ready) break
    await sleep(2000)
  }

  // 查找页面上所有 Kendo DropDownList，根据 label 匹配学年度/学期
  const filters = await page.evaluate(() => {
    if (typeof $ === 'undefined') return { error: 'jQuery未加载' }

    const result = { academicYearId: null, semesterId: null, allDropdowns: [] }

    // 遍历所有被 Kendo-化的 input
    const inputs = document.querySelectorAll('input')
    for (const inp of inputs) {
      if (!inp.id) continue
      let widget = null
      try { widget = $(inp).data('kendoDropDownList') } catch (_) { continue }
      if (!widget) continue

      // 找 label：看父级 LI 或前一个 span 的文本
      let label = ''
      const parentLi = inp.closest('li')
      if (parentLi) {
        // 取 LI 中第一个非空文本（去掉 input 本身的值和 button 文本）
        const texts = []
        for (const child of parentLi.childNodes) {
          if (child.nodeType === 3) { // Text node
            const t = child.textContent.trim()
            if (t && t.length <= 10) texts.push(t)
          } else if (child.nodeType === 1 && child.tagName !== 'INPUT' && child.tagName !== 'BUTTON' && child.tagName !== 'SPAN') {
            const t = child.textContent.trim()
            if (t && t.length <= 10) texts.push(t)
          }
        }
        // Also check spans
        const spans = parentLi.querySelectorAll('span')
        for (const s of spans) {
          const t = s.textContent.trim()
          if (t && t.length <= 10 && !t.includes('k-')) texts.unshift(t)
        }
        label = texts[0] || ''
      }

      const data = { id: inp.id, label, hasData: false, dataLen: 0, firstItems: [] }
      try {
        const d = widget.dataSource.data()
        if (d && d.length > 0 && typeof d.slice === 'function') {
          data.hasData = true
          data.dataLen = d.length
          data.firstItems = d.slice(0, 3).map(x => (x && (x.dmmc || x.text || x.name)) || '')
        }
      } catch (_) {}

      result.allDropdowns.push(data)

      if (label.includes('学年度') || label.includes('学年') || inp.id.includes('xnd')) {
        result.academicYearId = inp.id
      } else if (label.includes('学期') || inp.id.includes('xq')) {
        result.semesterId = inp.id
      }
    }

    if ($('#garz_nd').data('kendoDropDownList')) result.academicYearId = 'garz_nd'
    if ($('#garz_xq').data('kendoDropDownList')) result.semesterId = 'garz_xq'
    return result
  })

  if (filters.error) {
    throw new Error('学期筛选器未就绪：' + filters.error)
  }

  logger.info('Found dropdowns: ' + JSON.stringify(filters.allDropdowns.map(d => d.id + ':' + d.label + '(' + d.dataLen + ')')))
  logger.info(`Academic year input: ${filters.academicYearId}, Semester input: ${filters.semesterId}`)

  // 选择学年度
  if (filters.academicYearId) {
    const selectedYear = await page.evaluate(({ inputId, target }) => {
      const widget = $('#' + inputId).data('kendoDropDownList')
      if (!widget) return
      widget.open()
      const data = widget.dataSource.data()
      if (!data || !data.length) return
      for (let i = 0; i < data.length; i++) {
        const val = (data[i] && (data[i].dmmc || data[i].text || data[i].name)) || ''
        if (val === target) { widget.select(i); widget.trigger('change'); return true }
      }
    }, { inputId: filters.academicYearId, target: academicYear })
    if (!selectedYear) throw new Error('网页中未找到学年度：' + academicYear)
    await sleep(500)
    logger.info(`Academic year set to: ${academicYear}`)
  } else {
    throw new Error('学年度下拉框未找到，已停止查询')
  }

  // 选择学期
  if (filters.semesterId) {
    const selectedSemester = await page.evaluate(({ inputId, target }) => {
      const widget = $('#' + inputId).data('kendoDropDownList')
      if (!widget) return
      widget.open()
      const data = widget.dataSource.data()
      if (!data || !data.length) return
      for (let i = 0; i < data.length; i++) {
        const val = (data[i] && (data[i].dmmc || data[i].text || data[i].name)) || ''
        if (val.includes(target)) { widget.select(i); widget.trigger('change'); return true }
      }
    }, { inputId: filters.semesterId, target: semester })
    if (!selectedSemester) throw new Error('网页中未找到学期：' + semester)
    await sleep(500)
    logger.info(`Semester set to: ${semester}`)
  } else {
    throw new Error('学期下拉框未找到，已停止查询')
  }

  // 等待周次下拉框数据刷新
  await sleep(1000)
}

async function selectWeek(page, weekNumber) {
  const target = `第${weekNumber}周`

  // 等待 jQuery 和 Kendo 就绪
  for (let i = 0; i < 10; i++) {
    const ready = await page.evaluate(() => {
      return typeof $ !== 'undefined' && typeof $.fn !== 'undefined'
    }).catch(() => false)
    if (ready) break
    logger.warn(`jQuery not ready, waiting... (${i + 1}/10)`)
    await sleep(2000)
  }

  // 重试机制：Kendo 下拉框数据可能异步加载
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await page.evaluate(({ week, targetLabel }) => {
        // 再次检查 jQuery
        if (typeof $ === 'undefined') return { error: 'jQuery未加载', dataLen: 0 }

        const input = document.getElementById('garz_zc')
        if (!input) return { error: '周次下拉框未找到', dataLen: 0 }

        let widget
        try { widget = $(input).data('kendoDropDownList') } catch (_) {}
        if (!widget) return { error: 'Kendo widget 未找到', dataLen: 0 }

        // 如果没打开，先打开
        try {
          if (!widget.popup || !widget.popup.visible()) {
            widget.open()
          }
        } catch (_) {}

        const data = widget.dataSource.data()
        if (!data || data.length === 0) return { error: '下拉框数据为空', dataLen: 0 }

        for (let i = 0; i < data.length; i++) {
          if (data[i].dmmc === targetLabel) {
            widget.select(i)
            widget.trigger('change')
            return { success: true, index: i, total: data.length }
          }
        }
        return { error: `未找到"${targetLabel}"`, dataLen: data.length, samples: data.slice(0, 3).map(d => d.dmmc) }
      }, { week: weekNumber, targetLabel: target })

      if (result.success) {
        await sleep(500)
        return
      }

      logger.warn(`selectWeek attempt ${attempt + 1}: ${result.error}, dataLen=${result.dataLen}${result.samples ? ', samples=' + JSON.stringify(result.samples) : ''}`)
    } catch (e) {
      logger.warn(`selectWeek attempt ${attempt + 1} error: ${e.message}`)
    }

    if (attempt < 4) await sleep(1500)
  }

  throw new Error(`无法选择第${weekNumber}周，下拉框数据可能未加载`)
}

async function clickQuery(page) {
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button')
    for (const b of btns) { if (b.offsetParent !== null && b.textContent.replace(/\s/g, '') === '查询') { b.click(); return } }
  })
  await sleep(2000)
}

async function getStudentCount(page) {
  return await page.evaluate(() => {
    const links = document.querySelectorAll('a')
    let cnt = 0
    for (const a of links) { if (a.offsetParent !== null && a.textContent.includes('编辑/查看')) cnt++ }
    return cnt
  })
}

async function navigateAndQuery(page, weekNumber) {
  logger.info(`Navigating to week ${weekNumber}...`)
  await closeAllPopups(page)
  await switchToXueqing(page)
  await ensureAcademicFilters(page, weekNumber)
  await selectWeek(page, weekNumber)
  await clickQuery(page)
  await closeAllPopups(page)

  const count = await getStudentCount(page)
  // Empty or small rosters are valid; widget readiness and filters are checked above.
  logger.info(`Confirmed: week ${weekNumber}, ${count} students`)
  return count
}

/**
 * 获取学生列表（含姓名和录入状态）
 * 需在已登录且已导航到工作日志的页面上调用
 */
async function getStudentList(page, week) {
  logger.info(`Fetching student list for week ${week}...`)
  await closeAllPopups(page)
  await switchToXueqing(page)
  await ensureAcademicFilters(page, week)
  await selectWeek(page, week)
  await clickQuery(page)
  await closeAllPopups(page)

  const students = await page.evaluate(() => {
    const result = []
    const links = document.querySelectorAll('a')
    const editLinks = Array.from(links).filter(a => a.offsetParent !== null && a.textContent.includes('编辑/查看'))

    for (let i = 0; i < editLinks.length; i++) {
      const link = editLinks[i]
      // 学生姓名通常在链接前的td中
      const row = link.closest('tr')
      let name = ''
      if (row) {
        const cells = row.querySelectorAll('td')
        // 通常姓名在第2-3列
        for (const cell of cells) {
          const text = cell.textContent.trim()
          // 跳过纯数字（学号）、编辑/查看链接、空值
          if (!text || text.includes('编辑') || text.includes('查看')) continue
          if (/^\d+$/.test(text)) continue
          // 优先中文姓名（2-4字），排除状态文字
          if (/^[一-龥]{2,4}$/.test(text) &&
              !text.includes('完成') && !text.includes('差') && !text.includes('提交')) { name = text; break }
        }
        // 如果没找到中文名，取第一个非数字文本
        if (!name) {
          for (const cell of cells) {
            const text = cell.textContent.trim()
            if (text && text.length <= 10 && !text.includes('编辑') && !text.includes('查看') && !/^\d+$/.test(text)) {
              name = text; break
            }
          }
        }
      }
      if (!name) name = `学生${i + 1}`
      result.push({ index: i, name, studentId: row?.querySelector('td')?.textContent.trim() || '' })
    }
    return result
  })

  logger.info(`Got ${students.length} students for week ${week}`)
  return students
}

/**
 * 从当前页面提取学生姓名（页面需已在查询结果状态）
 * 返回 [{ index: 0, name: '张三' }, ...]
 */
async function extractStudentNames(page) {
  return await page.evaluate(() => {
    const result = []
    const links = document.querySelectorAll('a')
    const editLinks = Array.from(links).filter(a => a.offsetParent !== null && a.textContent.includes('编辑/查看'))

    for (let i = 0; i < editLinks.length; i++) {
      const link = editLinks[i]
      const row = link.closest('tr')
      let name = ''
      if (row) {
        const cells = row.querySelectorAll('td')
        for (const cell of cells) {
          const text = cell.textContent.trim()
          if (!text || text.includes('编辑') || text.includes('查看')) continue
          if (/^\d+$/.test(text)) continue
          if (/^[一-龥]{2,4}$/.test(text) &&
              !text.includes('完成') && !text.includes('差') && !text.includes('提交')) { name = text; break }
        }
        if (!name) {
          for (const cell of cells) {
            const text = cell.textContent.trim()
            if (text && text.length <= 10 && !text.includes('编辑') && !text.includes('查看') && !/^\d+$/.test(text)) {
              name = text; break
            }
          }
        }
      }
      if (!name) name = `学生${i + 1}`
      result.push({ index: i, name, studentId: row?.querySelector('td')?.textContent.trim() || '' })
    }
    return result
  })
}

/**
 * 获取学生在某周次的录入状态
 * 需点击编辑/查看来获取
 */
async function getStudentStatus(page, studentIndex) {
  try {
    // 点击编辑/查看
    const clicked = await page.evaluate(({ idx }) => {
      const links = document.querySelectorAll('a')
      const btns = Array.from(links).filter(a => a.offsetParent !== null && a.textContent.includes('编辑/查看'))
      if (idx < btns.length) { btns[idx].click(); return true }
      return false
    }, { idx: studentIndex })
    if (!clicked) return { hasCompanion: false, hasTalk: false }

    await sleep(2000)

    const status = await page.evaluate(() => {
      const pbGrid = document.querySelector('#xq_pb_grid')
      const thGrid = document.querySelector('#xq_th_grid')
      return {
        hasCompanion: pbGrid ? pbGrid.querySelectorAll('tbody tr').length > 0 : false,
        hasTalk: thGrid ? thGrid.querySelectorAll('tbody tr').length > 0 : false
      }
    })

    // 关闭弹窗
    try {
      await page.evaluate(() => {
        const closes = document.querySelectorAll('.k-i-close')
        for (const c of closes) { if (c.offsetParent !== null) { c.click(); break } }
      })
      await sleep(1000)
    } catch (_) {}

    return status
  } catch (_) {
    try {
      await page.evaluate(() => {
        const closes = document.querySelectorAll('.k-i-close')
        for (const c of closes) { if (c.offsetParent !== null) { c.click(); break } }
      })
    } catch (_) {}
    return { hasCompanion: false, hasTalk: false }
  }
}

/**
 * 扫描一周的所有学生，获取补录需求
 * 返回 [{name, needCount}] - needCount 为还需补录的次数
 */
async function getCompletionStatus(page, week) {
  logger.info(`Scanning week ${week} for completion status...`)
  await closeAllPopups(page)
  await switchToXueqing(page)
  await ensureAcademicFilters(page, week)
  await selectWeek(page, week)
  await clickQuery(page)
  await closeAllPopups(page)

  const students = await page.evaluate(() => {
    const result = []
    const links = document.querySelectorAll('a')
    const editLinks = Array.from(links).filter(a => a.offsetParent !== null && a.textContent.includes('编辑/查看'))

    for (let i = 0; i < editLinks.length; i++) {
      const link = editLinks[i]
      const row = link.closest('tr')
      let name = ''
      let needCount = 0

      if (row) {
        const cells = row.querySelectorAll('td')
        for (const cell of cells) {
          const text = cell.textContent.trim()
          // 检查差x次
          const match = text.match(/差(\d+)次/)
          if (match) {
            needCount = parseInt(match[1])
          }
          // 中文姓名（排除状态文字：已完成、差x次、未提交 等）
          if (/^[一-龥]{2,4}$/.test(text) &&
              !text.includes('编辑') && !text.includes('查看') &&
              !text.includes('完成') && !text.includes('差') && !text.includes('提交')) {
            name = text
          }
        }
      }
      if (!name) name = `学生${i + 1}`
      result.push({ index: i, name, needCount, studentId: row?.querySelector('td')?.textContent.trim() || '' })
    }
    return result
  })

  const incomplete = students.filter(s => s.needCount > 0)
  logger.info(`Week ${week}: ${incomplete.length}/${students.length} students need recording`)
  return students
}

module.exports = {
  navigateAndQuery, closeAllPopups, switchToXueqing, ensureAcademicFilters, selectWeek,
  clickQuery, getStudentCount, getStudentList, extractStudentNames, getStudentStatus,
  getCompletionStatus
}
