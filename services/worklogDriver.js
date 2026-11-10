const school = require("./worklogSchool"),
  schedule = require("./worklogSchedule"),
  { AppError } = require("../utils/errors"),
  { closeAllPopups } = require("./navigator");
const same = (record, operation) =>
  record.xh === operation.studentId &&
  String(record.thsj).replaceAll("/", "-").slice(0, 16) ===
    operation.payload.recordedAt.slice(0, 16) &&
  String(record.bz || "").trim() === operation.payload.content.trim() &&
  Number(record.thsc) === operation.payload.durationMinutes &&
  String(record.thfs) ===
    { 面对面: "1", 电话: "2", 网络: "3" }[operation.payload.method];
async function navigateWeek(page, calendar, week, expectedId) {
  await closeAllPopups(page);
  await page.evaluate(
    ({ calendar, week }) => {
      const tab = Array.from(document.querySelectorAll("li,a,span")).find(
        (el) =>
          el.offsetParent !== null && el.textContent.trim() === "工作日志管理",
      );
      if (!tab) throw Error("工作日志管理入口未加载");
      tab.click();
      const year = $("#gzrz_nd").data("kendoDropDownList"),
        term = $("#gzrz_xq").data("kendoDropDownList");
      if (!year || !term) throw Error("学校学期控件未就绪");
      if (
        year.value() !== calendar.schoolYearId ||
        term.value() !== calendar.schoolSemesterId
      ) {
        year.value(calendar.schoolYearId);
        term.value(calendar.schoolSemesterId);
        getZc();
      }
      const w = $("#gzrz_zc").data("kendoDropDownList");
      if (
        !Array.from(w.dataSource.data()).some(
          (r) => String(r.dmz) === String(week),
        )
      )
        throw Error("学校没有所选周次");
      w.value(String(week));
      w.trigger("change");
    },
    { calendar, week },
  );
  await page.waitForFunction(
    ({ week, id }) =>
      $("#gzrz_zc").data("kendoDropDownList").value() === String(week) &&
      $("#shzt_one").text() === id &&
      Array.from(document.querySelectorAll("#rzgl a")).some((a) =>
        a.getAttribute("onclick")?.includes(id),
      ),
    { week, id: expectedId },
    { timeout: 15000 },
  );
  const verified = await page.evaluate(
    ({ calendar, week }) =>
      $("#gzrz_nd").data("kendoDropDownList").value() ===
        calendar.schoolYearId &&
      $("#gzrz_xq").data("kendoDropDownList").value() ===
        calendar.schoolSemesterId &&
      $("#gzrz_zc").data("kendoDropDownList").value() === String(week),
    { calendar, week },
  );
  if (!verified)
    throw new AppError(
      409,
      "CALENDAR_CHANGED",
      "学校工作日志学期或周次不一致，未录入",
    );
}
async function selectStudent(page, id) {
  await page.locator("#editXsthwindow #xsth_xm").click();
  await page
    .locator("#xsyhwindow #xmxh")
    .waitFor({ state: "visible", timeout: 10000 });
  const response = page.waitForResponse(
    (r) =>
      r.url().includes("/getXsmdList") &&
      (() => {
        try {
          return (
            JSON.parse(
              new URLSearchParams(r.request().postData() || "").get("info"),
            ).xmxh === id
          );
        } catch {
          return false;
        }
      })(),
    { timeout: 15000 },
  );
  await page.locator("#xsyhwindow #xmxh").fill(id);
  await page.evaluate(() => search_ry());
  await response;
  await page.waitForFunction(
    (id) => {
      const grid = $("#xsyh_grid").data("kendoGrid");
      return (
        grid && Array.from(grid.dataSource.data()).some((s) => s.xh === id)
      );
    },
    id,
    { timeout: 10000 },
  );
  const student = await page.evaluate((id) => {
    const grid = $("#xsyh_grid").data("kendoGrid"),
      items = Array.from(grid.dataSource.data()).filter((s) => s.xh === id);
    if (items.length !== 1) throw Error("学校选择器中的学号不唯一");
    const item = items[0],
      row = Array.from(document.querySelectorAll("#xsyh_grid tbody tr")).find(
        (tr) => tr.querySelector("td")?.textContent.trim() === id,
      );
    if (!row) throw Error("未找到精确学号对应行");
    const button = Array.from(row.querySelectorAll("a")).find(
      (a) => a.textContent.trim() === "选中",
    );
    if (!button) throw Error("未找到学校学生选择按钮");
    const result = {
      studentId: item.xh,
      name: item.xm,
      schoolCount: Number(item.thcs),
      hasContact: !!String(item.lxfs || "").trim(),
    };
    button.click();
    return result;
  }, id);
  const selected = await page.evaluate(() => ({
    id: $("#editXsthwindow #xsth_xh").val(),
    hasContact: !!$("#editXsthwindow #xsth_lxfs").val().trim(),
  }));
  if (selected.id !== id || !selected.hasContact)
    throw new AppError(
      400,
      "STUDENT_FORM_INVALID",
      "学校未正确选中学生或缺少联系方式，未提交",
    );
  return student;
}
async function currentCheck(page, operation, state) {
  const p = operation.payload,
    own = state.students.find((s) => s.studentId === operation.studentId);
  if (!own)
    throw new AppError(
      409,
      "STUDENT_NOT_OWNED",
      "学生已不在当前所带名单，未提交",
    );
  const week = await school.weekInfo(page, state.calendar, operation.week),
    day = week.days.find((d) => d.date === p.date);
  schedule.inWindow(p.recordedAt, p, day);
  if (day.gzrzid !== p.gzrzid)
    throw new AppError(
      409,
      "WORKLOG_CHANGED",
      "学校日志编号已变化，请重新生成预览",
    );
  const rows = await school.dayRecords(page, day),
    matches = rows.filter((r) => same(r, operation));
  if (matches.length)
    return {
      skip: {
        status: "skipped",
        reason: "相同学生、时间和内容已存在，不重复提交",
        receipt: {
          schoolRecordId: String(matches[0].id),
          verified: true,
          duplicate: true,
        },
      },
    };
  const completed = state.records.filter(
    (r) =>
      r.xh === operation.studentId &&
      schedule.stamp(r.thsj) + Number(r.thsc) * schedule.MIN <= Date.now(),
  ).length;
  if (p.skipRecorded && completed >= p.targetCount)
    return {
      skip: {
        status: "skipped",
        reason: `本学期已完成 ${completed} 次，达到目标，不重复录入`,
      },
    };
  const time = schedule.stamp(p.recordedAt),
    times = rows.map((r) => schedule.stamp(r.thsj));
  if (times.some((t) => !Number.isFinite(t)))
    throw new AppError(
      409,
      "SCHOOL_DATA_INVALID",
      "已有谈话时间无法核对，未提交",
    );
  if (!schedule.densityOK(time, times))
    throw new AppError(
      409,
      "DENSITY_LIMIT",
      "已有记录发生变化，滚动 10 分钟内不能超过 2 条谈话",
    );
  return { day, rows };
}
async function saveOperation(
  page,
  operation,
  beforeSave = async () => {},
  state,
) {
  let attempted = false;
  try {
    if (!state) throw Error("缺少工作日志执行快照");
    let check = await currentCheck(page, operation, state);
    if (check.skip) return check.skip;
    const p = operation.payload;
    await navigateWeek(page, state.calendar, operation.week, p.gzrzid);
    const clicked = await page.evaluate(
      ({ date, id }) => {
        const raw = date.replaceAll("-", ""),
          a = Array.from(document.querySelectorAll("#rzgl a")).find(
            (el) =>
              el.offsetParent !== null &&
              el
                .getAttribute("onclick")
                ?.replace(/\s/g, "")
                .includes(`editGzrz('${raw}','0','${id}')`),
          );
        if (!a) return false;
        a.click();
        return true;
      },
      { date: p.date, id: p.gzrzid },
    );
    if (!clicked)
      throw new AppError(
        409,
        "WORKLOG_LOCKED",
        "该日期没有可编辑的学生谈话入口，未提交",
      );
    await page
      .locator("#editXsthwindow #xsth_xm")
      .waitFor({ state: "visible", timeout: 10000 });
    const selected = await selectStudent(page, operation.studentId);
    if (
      selected.schoolCount !==
        state.students.find((s) => s.studentId === operation.studentId)
          .schoolCount ||
      Date.now() - Date.parse(state.checkedAt) > 60000
    ) {
      const fresh = await school.readSnapshot(page, state.calendar);
      Object.assign(state, fresh);
      check = await currentCheck(page, operation, state);
      if (check.skip) return check.skip;
    }
    await page.evaluate((p) => {
      const root = $("#editXsthwindow"),
        picker = root.find("#xsth_thsj").data("kendoTimePicker"),
        method = root.find("#xsth_thfs").data("kendoDropDownList");
      if (!picker || !method) throw Error("学校谈话表单控件未就绪");
      picker.value(p.recordedAt.slice(11, 16));
      picker.trigger("change");
      method.value({ 面对面: "1", 电话: "2", 网络: "3" }[p.method]);
      method.trigger("change");
      if (method.text() !== p.method || root.find("#xsth_id").val())
        throw Error("学校谈话方式或新增状态异常，未提交");
    }, p);
    await page
      .locator("#editXsthwindow #xsth_thsc")
      .fill(String(p.durationMinutes));
    await page.locator("#editXsthwindow #xsth_bz").fill(p.content);
    await beforeSave();
    // Recheck elapsed time, editing rights, duplicates and rolling density after a pause.
    const latestRows = await school.pages(page, "xg_fdygzrz/rzgl/getXsmdList", {
        xmxh: operation.studentId,
        bs: "",
      }),
      latest = latestRows.find((r) => r.xh === operation.studentId);
    if (!latest)
      throw new AppError(409, "STUDENT_NOT_OWNED", "学校名单已变化，未提交");
    if (
      Number(latest.thcs) !==
        state.students.find((s) => s.studentId === operation.studentId)
          ?.schoolCount ||
      Date.now() - Date.parse(state.checkedAt) > 60000
    )
      Object.assign(state, await school.readSnapshot(page, state.calendar));
    check = await currentCheck(page, operation, state);
    if (check.skip) return check.skip;
    const fields = await page.evaluate(() => ({
      id: $("#editXsthwindow #xsth_xh").val(),
      date: $("#xsth_rq").val(),
      log: $("#xsth_gzrzid").val(),
      time: $("#editXsthwindow #xsth_thsj").val(),
    }));
    if (
      fields.id !== operation.studentId ||
      fields.date !== p.date.replaceAll("-", "") ||
      fields.log !== p.gzrzid ||
      fields.time !== p.recordedAt.slice(11, 16)
    )
      throw new AppError(
        409,
        "FORM_CHANGED",
        "学校表单的人员或时间已变化，未提交",
      );
    const oldIds = new Set(check.rows.map((r) => String(r.id))),
      response = page
        .waitForResponse(
          (r) =>
            r.url().includes("/editXsth") && r.request().method() === "POST",
          { timeout: 20000 },
        )
        .catch(() => null);
    attempted = true;
    await page
      .locator('#editXsthwindow button[onclick="xsth_save()"] ')
      .click();
    const reply = await response;
    let rejected = false;
    if (reply) {
      try {
        rejected = (await reply.json()).isSuccess === false;
      } catch {}
    }
    const after = await school.dayRecords(page, check.day),
      found = after.filter(
        (r) => !oldIds.has(String(r.id)) && same(r, operation),
      );
    if (found.length !== 1)
      return {
        status: rejected ? "failed" : "unconfirmed",
        reason: rejected
          ? "学校明确拒绝保存，请检查表单后重试"
          : "保存已发出但未取得唯一学校回执，请先回查，不会自动重试",
      };
    const record = found[0];
    state.records.push({
      id: String(record.id),
      xh: operation.studentId,
      thsj: p.recordedAt,
      thsc: p.durationMinutes,
      thfs: String(record.thfs),
      bz: p.content,
      week: operation.week,
    });
    // Refresh the native count after writing; never assume its statistical scope.
    const student = state.students.find(
      (s) => s.studentId === operation.studentId,
    );
    try {
      const selectedRows = await school.pages(
          page,
          "xg_fdygzrz/rzgl/getXsmdList",
          { xmxh: operation.studentId, bs: "" },
        ),
        official = selectedRows.find((r) => r.xh === operation.studentId);
      student.schoolCount = official ? Number(official.thcs) : undefined;
    } catch {
      student.schoolCount = undefined;
    }
    return {
      status: "succeeded",
      receipt: {
        schoolRecordId: String(record.id),
        scope: "工作日志管理/学生谈话",
        studentId: operation.studentId,
        recordedAt: p.recordedAt,
        content: p.content,
        durationMinutes: p.durationMinutes,
        method: p.method,
        verified: true,
        verifiedAt: new Date().toISOString(),
        schoolCount: student.schoolCount,
      },
    };
  } catch (e) {
    if (e.code === "TASK_CANCELLED")
      return { status: "cancelled", reason: "提交前取消，未保存" };
    return { status: attempted ? "unconfirmed" : "failed", reason: e.message };
  } finally {
    await closeAllPopups(page).catch(() => {});
  }
}
module.exports = {
  saveOperation,
  navigateWeek,
  selectStudent,
  currentCheck,
  same,
};
