const { AppError } = require("../utils/errors"),
  schedule = require("./worklogSchedule");
const PREFIX = "https://xuegong.hitwh.edu.cn/zhxy-xgzs/";
async function json(page, path, info) {
  const response = await page.request.post(PREFIX + path, {
    ...(info === undefined ? {} : { form: { info: JSON.stringify(info) } }),
    timeout: 20000,
  });
  if (!response.ok())
    throw new AppError(
      502,
      "SCHOOL_READ_FAILED",
      "学校记录读取失败，请稍后重试",
    );
  let body;
  try {
    body = await response.json();
  } catch {
    throw new AppError(
      401,
      "SCHOOL_AUTH_REQUIRED",
      "学校未返回有效数据，请重新验证登录",
    );
  }
  if (body && Object.hasOwn(body, "isSuccess") && body.isSuccess !== true)
    throw new AppError(
      502,
      "SCHOOL_READ_FAILED",
      body.msg || "学校拒绝读取记录",
    );
  return body;
}
async function pages(page, path, info = {}) {
  const rows = [];
  let total = Infinity;
  for (let p = 1; rows.length < total; p++) {
    const result = await json(page, path, {
        ...info,
        page: p,
        pageSize: 500,
        take: 500,
        skip: (p - 1) * 500,
      }),
      module = result.module;
    if (
      !module ||
      !Array.isArray(module.data) ||
      !Number.isInteger(Number(module.total)) ||
      Number(module.total) < 0 ||
      Number(module.total) > 15000
    )
      throw new AppError(
        502,
        "SCHOOL_DATA_INVALID",
        "学校分页记录不完整，不能可靠核对",
      );
    total = Number(module.total);
    if (!module.data.length && rows.length < total)
      throw new AppError(
        502,
        "SCHOOL_DATA_INVALID",
        "学校名单分页缺失，请重新读取",
      );
    rows.push(...module.data);
    if (p > 30)
      throw new AppError(
        502,
        "SCHOOL_DATA_INVALID",
        "学校记录过多，请联系维护者",
      );
  }
  if (rows.length !== total)
    throw new AppError(
      502,
      "SCHOOL_DATA_CHANGED",
      "读取期间记录总数发生变化，请重新读取",
    );
  return rows;
}
const params = (calendar, week) => ({
  nddm: calendar.schoolYearId,
  xqdm: calendar.schoolSemesterId,
  zcdm: String(week),
});
async function weekInfo(page, calendar, week) {
  const p = params(calendar, week),
    state = await json(page, "xg_fdygzrz/rzgl/getRzqk", p),
    logs = await json(page, "xg_fdygzrz/rzgl/getGzrzList", p);
  if (!Array.isArray(logs.module))
    throw new AppError(502, "SCHOOL_DATA_INVALID", "学校工作日志日期列表无效");
  const talk = logs.module.find((r) => String(r.bs) === "0"),
    days = [];
  if (!talk)
    return {
      week,
      status: state.module?.shzt,
      days,
      warning: "该周尚无谈话日志，未安排写入",
    };
  for (let i = 1; i <= 7; i++) {
    const cell = String(talk["xq" + i] || ""),
      raw = cell.slice(0, 8),
      date = raw.slice(0, 4) + "-" + raw.slice(4, 6) + "-" + raw.slice(6),
      count = Number(cell.slice(8)),
      expected = schedule.dateOf(
        Date.parse(calendar.startDate + "T00:00:00+08:00") +
          ((week - 1) * 7 + i - 1) * schedule.DAY,
      );
    if (
      !/^\d{8}\d+$/.test(cell) ||
      date !== expected ||
      !Number.isInteger(count) ||
      count < 0 ||
      !talk.gzrzid
    )
      throw new AppError(
        409,
        "CALENDAR_CHANGED",
        "学校工作日志日期与已核验学期不一致，已停止安排",
      );
    const editable =
      ["0", "-2"].includes(String(state.module?.shzt)) &&
      state.module?.gzrzid === talk.gzrzid;
    days.push({
      date,
      week,
      gzrzid: talk.gzrzid,
      editable,
      schoolStatus: String(state.module?.shzt ?? ""),
      count,
    });
  }
  return { week, status: state.module?.shzt, days };
}
async function dayRecords(page, day) {
  return pages(page, "xg_fdygzrz/rzgl/getList", {
    gzrzid: day.gzrzid,
    rq: day.date.replaceAll("-", ""),
    bs: "0",
  });
}
async function readSnapshot(
  page,
  calendar,
  {
    onProgress = async () => {},
    cancelled = () => false,
    now = Date.now(),
  } = {},
) {
  const own = await json(page, "xg_fdygzrz/rzgl/getXsList"),
    selector = await pages(page, "xg_fdygzrz/rzgl/getXsmdList", {
      xmxh: "",
      bs: "",
    });
  if (!Array.isArray(own.module))
    throw new AppError(502, "SCHOOL_DATA_INVALID", "学校所带学生名单无效");
  const selected = new Map(selector.map((s) => [String(s.xh), s])),
    seenStudents = new Set(),
    students = own.module.map((s) => {
      const id = String(s.xh),
        native = selected.get(id),
        schoolCount = Number(native?.thcs);
      if (
        !/^\d{8,16}$/.test(id) ||
        seenStudents.has(id) ||
        !native ||
        !Number.isInteger(schoolCount) ||
        schoolCount < 0
      )
        throw new AppError(
          502,
          "SCHOOL_DATA_INVALID",
          "所带名单或学校谈话次数不完整，不能按零次猜测",
        );
      seenStudents.add(id);
      return {
        studentId: id,
        name: String(s.xm || id),
        major: String(s.zymc || ""),
        schoolCount,
        semesterCount: 0,
        futureCount: 0,
        hasContact: !!String(native.lxfs || s.lxfs || "").trim(),
      };
    });
  const weeks = await json(page, "xg_common/getzslist", {
    nddm: calendar.schoolYearId,
    xqdm: calendar.schoolSemesterId,
  });
  if (!Array.isArray(weeks) || !weeks.length)
    throw new AppError(502, "SCHOOL_DATA_INVALID", "学校学期周次列表无效");
  const weekIds = [...new Set(weeks.map((w) => Number(w.dmz)))].sort(
    (a, b) => a - b,
  );
  if (
    weekIds.some((w) => !Number.isInteger(w) || w < 1 || w > 60) ||
    !weekIds.includes(calendar.week)
  )
    throw new AppError(409, "CALENDAR_CHANGED", "学校当前周次与周列表不一致");
  const days = [],
    records = [],
    seenRecords = new Set();
  for (const week of weekIds) {
    if (cancelled())
      throw new AppError(409, "SCAN_CANCELLED", "读取已取消，未写入学校记录");
    const info = await weekInfo(page, calendar, week);
    days.push(...info.days);
    for (const day of info.days.filter((d) => d.count > 0)) {
      const rows = await dayRecords(page, day);
      if (rows.length !== day.count)
        throw new AppError(
          409,
          "SCHOOL_DATA_CHANGED",
          "读取时谈话数量发生变化，请刷新名单和次数",
        );
      for (const r of rows) {
        const id = String(r.id || ""),
          time = schedule.stamp(r.thsj);
        if (
          !id ||
          !Number.isFinite(time) ||
          schedule.dateOf(time) !== day.date ||
          !Number.isFinite(Number(r.thsc))
        )
          throw new AppError(
            502,
            "SCHOOL_DATA_INVALID",
            "学校已有谈话记录缺少可靠标识或时间",
          );
        if (seenRecords.has(id)) continue;
        seenRecords.add(id);
        records.push({
          id,
          xh: String(r.xh || ""),
          thsj: schedule.format(time),
          thsc: Number(r.thsc),
          thfs: String(r.thfs),
          bz: String(r.bz || ""),
          thcj: r.thcj ?? null,
          week,
        });
      }
    }
    await onProgress({
      processed: weekIds.indexOf(week) + 1,
      total: weekIds.length,
    });
  }
  const counts = new Map(students.map((s) => [s.studentId, s]));
  for (const r of records) {
    const s = counts.get(r.xh);
    if (s) {
      if (schedule.stamp(r.thsj) + r.thsc * schedule.MIN <= now)
        s.semesterCount++;
      else s.futureCount++;
    }
  }
  return {
    calendar,
    students,
    days,
    records,
    checkedAt: new Date(now).toISOString(),
    totalWeeks: weekIds.length,
    source: "school_worklog_and_native_student_selector",
    futureRecords: records.filter(
      (r) => schedule.stamp(r.thsj) + r.thsc * schedule.MIN > now,
    ).length,
  };
}
module.exports = { json, pages, params, weekInfo, dayRecords, readSnapshot };
