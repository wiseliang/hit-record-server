const { setSemester, getWeekInfo } = require("../utils/week");
function array(value) {
  return Array.isArray(value) ? value : value?.module || value?.data || [];
}
function deriveSemester(current, years, now = new Date()) {
  const row = array(current)[0];
  const week = Number(row?.zdm || row?.zcdm || row?.zc);
  if (!Number.isInteger(week) || week < 1 || week > 60)
    throw new Error("学校返回的当前周次无效");
  const year = array(years).find(
    (x) => String(x.dmz) === String(row.nddm),
  )?.dmmc;
  const semester = { "01": "春季", "02": "秋季", "03": "夏季" }[
    String(row.xqdm).padStart(2, "0")
  ];
  if (!year || !semester) throw new Error("无法识别学校返回的学年或学期");
  const academicYear = year.replace(/[—–－-]/g, "—");
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const date = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  date.setUTCDate(
    date.getUTCDate() - ((date.getUTCDay() + 6) % 7) - (week - 1) * 7,
  );
  return {
    startDate: date.toISOString().slice(0, 10),
    academicYear,
    semester,
    source: "school_week_api",
    checkedAt: now.toISOString(),
    schoolWeek: week,
    schoolYearId: String(row.nddm),
    schoolSemesterId: String(row.xqdm),
  };
}
async function syncSchoolCalendar(page) {
  const origin = "https://xuegong.hitwh.edu.cn";
  const [current, years] = await Promise.all([
    page.request.post(origin + "/zhxy-xgzs/xg_common/getNdXqZM"),
    page.request.post(origin + "/zhxy-xgzs/xg_common/getndlist"),
  ]);
  if (!current.ok() || !years.ok())
    throw new Error("读取学校学期失败，请重新登录");
  const snapshot = deriveSemester(await current.json(), await years.json());
  setSemester(snapshot);
  return { ...getWeekInfo(), verified: true };
}
module.exports = { syncSchoolCalendar, deriveSemester };
