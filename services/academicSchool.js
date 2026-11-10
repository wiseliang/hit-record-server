const school = require("./worklogSchool"),
  { AppError } = require("../utils/errors");
async function roster(page, calendar, week) {
  const p = school.params(calendar, week),
    state = await school.json(page, "xg_fdygzrz/rzgl/getRzqk", p),
    logId = state.module?.gzrzid;
  if (!logId)
    throw new AppError(
      409,
      "ACADEMIC_WEEK_UNAVAILABLE",
      "该周学情日志尚未建立，请在学校系统核对",
    );
  const rows = [];
  let total = null;
  for (let index = 0; index < 30; index++) {
    const body = await school.json(page, "xg_fdygzrz/rzgl/getXqrzXsList", {
        take: 500,
        skip: index * 500,
        gzrzid: logId,
        nddm: calendar.schoolYearId,
        xqdm: calendar.schoolSemesterId,
        zdm: String(week),
        xhxm: "",
      }),
      m = body.module;
    if (!Array.isArray(m?.data))
      throw new AppError(
        502,
        "ACADEMIC_ROSTER_INVALID",
        "学校学情名册返回无效，不会改用工作日志名单",
      );
    if (m.total !== undefined && m.total !== null && m.total !== "") {
      total = Number(m.total);
      if (!Number.isInteger(total) || total < 0 || total > 15000)
        throw new AppError(
          502,
          "ACADEMIC_ROSTER_INVALID",
          "学校学情分页总数无效",
        );
    }
    rows.push(...m.data);
    if (
      (total !== null && rows.length >= total) ||
      (total === null && m.data.length < 500)
    )
      break;
    if (!m.data.length)
      throw new AppError(
        502,
        "ACADEMIC_ROSTER_INVALID",
        "学校学情名册分页不完整",
      );
  }
  if (total !== null && rows.length !== total)
    throw new AppError(
      409,
      "ACADEMIC_ROSTER_CHANGED",
      "读取期间学情名单发生变化，请重新读取",
    );
  const seen = new Set(),
    students = rows.map((s) => {
      const id = String(s.xh || s.xqxh || "");
      if (!/^\d{8,16}$/.test(id) || seen.has(id))
        throw new AppError(
          502,
          "ACADEMIC_ROSTER_INVALID",
          "学情名单缺少唯一学号",
        );
      seen.add(id);
      return {
        studentId: id,
        name: String(s.xm || s.name || id),
        scope: "academic",
        week,
      };
    });
  return {
    week,
    gzrzid: logId,
    editable: ["0", "-2"].includes(String(state.module.shzt)),
    students,
    source: "school_academic_week_roster",
  };
}
async function records(page, info, id, type) {
  const endpoint = type === "talk" ? "getYxsthjl" : "getPbjl",
    rows = [];
  for (let index = 0; index < 30; index++) {
    const body = await school.json(page, "xg_fdygzrz/rzgl/" + endpoint, {
        take: 500,
        skip: index * 500,
        id: info.gzrzid,
        xh: id,
      }),
      raw = body.module;
    const list = Array.isArray(raw) ? raw : raw?.data;
    if (!Array.isArray(list))
      throw new AppError(
        502,
        "ACADEMIC_RECORDS_INVALID",
        "学情已有记录读取失败，不能按空记录补写",
      );
    rows.push(...list);
    if (list.length < 500) break;
  }
  const seen = new Set();
  return rows.filter((r) => {
    const key = String(r.id || "");
    if (!key)
      throw new AppError(
        502,
        "ACADEMIC_RECORDS_INVALID",
        "学情记录缺少唯一编号",
      );
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
module.exports = { roster, records };
