const { AppError } = require("../utils/errors");
const { validateRecordDateTime } = require("./companion");
const { closeAllPopups } = require("./navigator");
const settings = {
  talk: {
    tab: "th",
    grid: "xq_th_grid",
    date: "xsth_thsj",
    note: "xsth_bz",
    endpoint: "submit_Yxsthjl",
  },
  companion: {
    tab: "pb",
    grid: "xq_pb_grid",
    date: "pbjl_cysj",
    note: "pbjl_bz",
    endpoint: "submit_Pbjl",
  },
};
async function openStudent(page, studentId, type) {
  const url = new URL(page.url());
  if (
    url.hostname !== "xuegong.hitwh.edu.cn" ||
    /authserver|login|\/cas/i.test(url.pathname)
  )
    throw new AppError(
      401,
      "SCHOOL_AUTH_REQUIRED",
      "学校会话已过期，请重新验证后重试未保存项",
    );
  const cfg = settings[type];
  if (!cfg) throw new AppError(400, "INVALID_RECORD_TYPE", "请选择谈话或陪伴");
  await closeAllPopups(page);
  const found = await page.evaluate((id) => {
    const a = Array.from(document.querySelectorAll("a")).find(
      (a) =>
        a.offsetParent !== null &&
        a.textContent.includes("编辑/查看") &&
        a.closest("tr")?.querySelector("td")?.textContent.trim() === id,
    );
    if (!a) return false;
    a.click();
    return true;
  }, studentId);
  if (!found) return { missing: true, records: [] };
  await page
    .locator("li#" + cfg.tab + ":visible")
    .waitFor({ state: "visible", timeout: 10000 });
  await page.evaluate((tab) => {
    const el = document.querySelector("li#" + tab);
    if (!el) throw Error("记录分类未加载");
    const widget =
      typeof $ === "function" ? $("#tabstrip").data("kendoTabStrip") : null;
    if (widget && typeof widget.select === "function") widget.select(el);
    else (el.querySelector(".k-link") || el).click();
  }, cfg.tab);
  await page.waitForFunction(
    (tab) =>
      Array.from(document.querySelectorAll('div[id="' + tab + '"]')).some(
        (panel) =>
          panel.offsetParent !== null &&
          getComputedStyle(panel).visibility !== "hidden" &&
          Array.from(panel.querySelectorAll("button")).some(
            (b) => b.offsetParent !== null && b.textContent.includes("新增"),
          ),
      ),
    cfg.tab,
    { timeout: 10000 },
  );
  await page.waitForFunction(
    (id) => typeof $ !== "undefined" && !!$("#" + id).data("kendoGrid"),
    cfg.grid,
    { timeout: 10000 },
  );
  const records = await readGrid(page, cfg.grid);
  return { records, cfg };
}
async function readGrid(page, gridId) {
  return page.evaluate(async (id) => {
    const grid = $("#" + id).data("kendoGrid");
    if (!grid) throw Error("记录列表不可用");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("记录读取超时")), 20000);
      const done = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      const request = grid.dataSource.read();
      if (request && typeof request.then === "function")
        request.then(done(resolve), done(reject));
      else done(resolve)();
    });
    const data = grid.dataSource.data();
    const records = data.toJSON ? data.toJSON() : Array.from(data);
    if (!Array.isArray(records)) throw Error("记录响应无效");
    if (
      grid.dataSource.options.serverPaging &&
      grid.dataSource.total() > records.length
    )
      throw Error("记录有分页，需要人工核对后再录入");
    return records;
  }, gridId);
}
function recordId(record) {
  return String(record.id || record.ID || record.uuid || "");
}
function matches(record, operation) {
  const payload = operation.payload || operation;
  const content = String(payload.content || "").trim();
  const noteMatches =
    String(record.bz ?? record.note ?? record.content ?? "").trim() === content;
  const time = payload.recordedAt.replace(/\//g, "-").slice(0, 16);
  const actualTime =
    record.thsj ?? record.cysj ?? record.recordedAt ?? record.time;
  return (
    String(actualTime || "")
      .replaceAll("/", "-")
      .replace("T", " ")
      .slice(0, 16) === time && noteMatches
  );
}
async function selectDropdown(page, id, text) {
  const result = await page.evaluate(
    ({ id, text }) => {
      const w = $("#" + id).data("kendoDropDownList");
      if (!w) return false;
      const field = w.options.dataTextField || "text",
        data = Array.from(w.dataSource.data());
      const index = data.findIndex(
        (x) => String(x[field] || x.text || x.dmmc || "").trim() === text,
      );
      if (index < 0) return false;
      w.select(index);
      w.trigger("change");
      return w.text() === text;
    },
    { id, text },
  );
  if (!result)
    throw new AppError(
      400,
      "INVALID_FORM_OPTION",
      "学校表单中没有选项：" + text,
    );
}
async function inspectStudent(page, studentId, type) {
  const result = await openStudent(page, studentId, type);
  await closeAllPopups(page);
  return result;
}
async function saveOperation(page, operation, beforeSave = async () => {}) {
  const p = operation.payload,
    cfg = settings[operation.type];
  let saveAttempted = false;
  const date = validateRecordDateTime(operation.week, p.recordedAt);
  try {
    if (operation.type === "talk")
      require("./conversationMethod").validate(p.method);
    const opened = await openStudent(page, operation.studentId, operation.type);
    if (opened.missing)
      return { status: "not_applicable", reason: "该学生不在本周名单中" };
    const duplicate = opened.records.find((r) => matches(r, p));
    if (duplicate)
      return {
        status: "skipped",
        reason: "相同时间和内容已存在",
        receipt: {
          schoolRecordId: recordId(duplicate),
          verified: true,
          duplicate: true,
        },
      };
    if (p.mode === "missing" && p.ruleVersion !== 2 && opened.records.length)
      return {
        status: "skipped",
        reason: "本周已有所选类型的记录，不重复补写",
      };
    const oldIds = new Set(opened.records.map(recordId));
    const added = await page.evaluate((tab) => {
      const panel = Array.from(document.querySelectorAll("#" + tab)).find(
        (el) => el.tagName === "DIV" && el.offsetParent !== null,
      );
      const button =
        panel &&
        Array.from(panel.querySelectorAll("button")).find(
          (b) => b.offsetParent !== null && b.textContent.includes("新增"),
        );
      if (!button) return false;
      button.click();
      return true;
    }, cfg.tab);
    if (!added)
      throw new AppError(502, "FORM_NOT_READY", "未找到当前记录类型的新增按钮");
    await page
      .locator("#" + cfg.note)
      .waitFor({ state: "visible", timeout: 10000 });
    const fields = await page.evaluate(
      ({ dateId, date, noteId, content, duration }) => {
        const input = document.getElementById(dateId),
          note = document.getElementById(noteId);
        if (!input || !note) throw Error("学校录入表单字段未就绪");
        const picker = $(input).data("kendoDateTimePicker");
        if (!picker) throw Error("学校时间控件未就绪");
        picker.value(date);
        picker.trigger("change");
        note.value = content;
        note.dispatchEvent(new Event("input", { bubbles: true }));
        note.dispatchEvent(new Event("change", { bubbles: true }));
        if (duration !== undefined) {
          const d = document.getElementById("xsth_thsc");
          if (!d) throw Error("谈话时长控件未就绪");
          d.value = String(duration);
          d.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return true;
      },
      {
        dateId: cfg.date,
        date,
        noteId: cfg.note,
        content: p.content,
        ...(operation.type === "talk" ? { duration: p.durationMinutes } : {}),
      },
    );
    if (!fields) throw Error("表单填写失败");
    if (operation.type === "talk") {
      await selectDropdown(page, "xsth_thfs", p.method);
      await selectDropdown(page, "xsth_thcj", p.scene);
    } else await selectDropdown(page, "pbjl_pblx", p.pbType);
    if (operation.openid) {
      const live = await require("./schoolOptions").capture(operation.openid, {
        page,
        connectionId: operation.connectionId,
      });
      if (
        live &&
        p.formOptions?.version &&
        live.version !== p.formOptions.version
      )
        throw new AppError(
          409,
          "SCHOOL_OPTIONS_CHANGED",
          "学校表单选项已变化，请重新生成预览，未提交",
        );
    }
    const gate = await beforeSave();
    if (gate?.status === "skipped") return gate;
    const button = page
      .locator(".k-window:visible")
      .filter({ has: page.locator("#" + cfg.note) })
      .getByRole("button", { name: /保存/ })
      .last();
    if ((await button.count()) !== 1)
      throw new AppError(502, "FORM_NOT_READY", "保存按钮不唯一，未提交");
    const response = page
      .waitForResponse(
        (r) =>
          r.url().includes("/" + cfg.endpoint) &&
          r.request().method() === "POST",
        { timeout: 20000 },
      )
      .catch(() => null);
    saveAttempted = true;
    await button.click();
    const reply = await response;
    let rejected = false;
    if (reply) {
      try {
        rejected = (await reply.json()).isSuccess === false;
      } catch {}
    }
    const after = { records: await readGrid(page, cfg.grid) };
    const candidates = after.records.filter(
      (r) => !oldIds.has(recordId(r)) && matches(r, p),
    );
    if (candidates.length !== 1)
      return {
        status: rejected ? "failed" : "unconfirmed",
        reason: rejected
          ? "学校明确拒绝保存，请核对后重试"
          : "已点击保存，但未取得唯一匹配的学校收据，请先回查，不会自动重试",
      };
    return {
      status: "succeeded",
      receipt: {
        schoolRecordId: recordId(candidates[0]),
        studentId: operation.studentId,
        week: operation.week,
        type: operation.type,
        recordedAt: p.recordedAt,
        content: p.content,
        verified: true,
        verifiedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    if (error.code === "PAUSE_EXPIRED") throw error;
    if (error.code === "TASK_CANCELLED")
      return { status: "cancelled", reason: "提交前已取消，未点击保存" };
    return {
      status: saveAttempted ? "unconfirmed" : "failed",
      reason: error.message,
    };
  } finally {
    await closeAllPopups(page).catch(() => {});
  }
}
module.exports = { inspectStudent, saveOperation, matches, recordId, readGrid };
