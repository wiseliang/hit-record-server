const { getWeekStart } = require("../utils/week");
function validateRecordDateTime(week, value) {
  if (!Number.isInteger(week) || week < 1) throw Error("周次无效");
  if (typeof value !== "string") throw Error("请填写实际发生时间");
  const match =
    /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
      value,
    );
  if (!match) throw Error("时间格式请使用 YYYY-MM-DD HH:mm");
  const [, y, m, d, h, min, sec = "00"] = match,
    stamp = new Date(`${y}-${m}-${d}T${h}:${min}:${sec}+08:00`).getTime();
  if (
    !Number.isFinite(stamp) ||
    +h > 23 ||
    +min > 59 ||
    +sec > 59 ||
    new Date(`${y}-${m}-${d}T00:00:00Z`).toISOString().slice(0, 10) !==
      `${y}-${m}-${d}`
  )
    throw Error("活动时间无效");
  const start =
    new Date(getWeekStart() + "T00:00:00+08:00").getTime() +
    (week - 1) * 7 * 86400000;
  if (stamp < start || stamp >= start + 7 * 86400000)
    throw Error("活动时间不在所选周次内");
  if (stamp > Date.now()) throw Error("活动时间不能晚于现在");
  return `${y}/${m}/${d} ${h}:${min}:${sec}`;
}
async function recordCompanion(page, index, week, opts = {}) {
  if (!opts.studentId || !opts.recordedAt)
    return { result: "error", reason: "请先按学号和实际时间生成录入预览" };
  const result = await require("./recordDriver").saveOperation(page, {
    studentId: opts.studentId,
    week,
    type: "companion",
    payload: opts,
  });
  return {
    ...result,
    result:
      result.status === "succeeded"
        ? "success"
        : result.status === "skipped"
          ? "skipped"
          : "error",
  };
}
module.exports = { validateRecordDateTime, recordCompanion };
