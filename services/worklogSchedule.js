const { AppError } = require("../utils/errors");
const DAY = 86400000,
  MIN = 60000;
const fail = (message, code = "INVALID_WORKLOG_SCHEDULE") => {
  throw new AppError(400, code, message);
};
function stamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value)
  )
    return NaN;
  return Date.parse(
    value.replaceAll("/", "-").replace(" ", "T") +
      (value.length === 16 ? ":00" : "") +
      "+08:00",
  );
}
function dateOf(time) {
  return new Date(time + 8 * 3600000).toISOString().slice(0, 10);
}
function format(time) {
  return new Date(time + 8 * 3600000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}
function minute(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) fail("工作时段请填写 HH:mm");
  const [h, m] = value.split(":").map(Number);
  if (h > 23 || m > 59) fail("工作时段无效");
  return h * 60 + m;
}
function normalize(body, calendar, now = Date.now()) {
  const fromDate = body.fromDate || calendar.startDate,
    toDate = body.toDate || dateOf(now);
  const date = (v) => {
    if (
      typeof v !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
      !Number.isFinite(Date.parse(v + "T00:00:00+08:00")) ||
      dateOf(Date.parse(v + "T00:00:00+08:00")) !== v
    )
      fail("日期格式无效");
    return v;
  };
  date(fromDate);
  date(toDate);
  if (
    fromDate < calendar.startDate ||
    toDate < fromDate ||
    toDate > dateOf(now)
  )
    fail("只能选择本学期开始至今天的已过去日期，不能提前录入");
  const targetCount = body.targetCount ?? 1,
    durationMinutes = body.durationMinutes ?? 10;
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 10)
    fail("每人目标次数应为 1–10 次");
  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 1 ||
    durationMinutes > 180
  )
    fail("实际谈话时长应为 1–180 分钟");
  const shifts = body.shifts || [
    ["09:00", "12:00"],
    ["14:00", "17:00"],
  ];
  if (
    !Array.isArray(shifts) ||
    !shifts.length ||
    shifts.length > 2 ||
    shifts.some((s) => !Array.isArray(s) || s.length !== 2)
  )
    fail("请选择最多两个白天工作时段");
  const ranges = shifts
    .map(([a, b]) => [minute(a), minute(b)])
    .sort((a, b) => a[0] - b[0]);
  if (
    ranges.some(
      ([a, b]) => a < 8 * 60 || b > 18 * 60 || b - a < durationMinutes,
    ) ||
    ranges.some((r, i) => i && r[0] < ranges[i - 1][1])
  )
    fail("工作时段应在 08:00–18:00 内、不重叠且容纳实际时长");
  const excludeDates = body.excludeDates || [];
  if (!Array.isArray(excludeDates) || excludeDates.length > 200)
    fail("排除日期格式错误");
  excludeDates.forEach(date);
  if (
    (body.content!==undefined && typeof body.content!=="string") ||
    (typeof body.content==="string" && body.content.length>250)
  )
    fail("请填写实际谈话内容，不超过 250 字");
  if (!["面对面", "电话", "网络"].includes(body.method || "面对面"))
    fail("请选择学校支持的谈话方式");
  if (
    !Array.isArray(body.studentIds) ||
    !body.studentIds.length ||
    body.studentIds.length > 1500 ||
    body.studentIds.some(
      (id) => typeof id !== "string" || !/^\d{8,16}$/.test(id),
    ) ||
    new Set(body.studentIds).size !== body.studentIds.length
  )
    fail("请选择不重复的有效学号");
  return {
    recordType: "worklog-talk",
    studentIds: body.studentIds,
    targetCount,
    durationMinutes,
    skipRecorded: body.skipRecorded !== false,
    fromDate,
    toDate,
    shifts,
    ranges,
    excludeDates,
    method: body.method || "面对面",
    content: (body.content||'').trim(),
    calendarStartDate: calendar.startDate,
  };
}
function lowerBound(list, value) {
  let low = 0,
    high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (list[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}
function densityOK(time, times, sorted = false) {
  const local = sorted
    ? times.slice(
        lowerBound(times, time - 10 * MIN),
        lowerBound(times, time + 10 * MIN + 1),
      )
    : times.filter((t) => Math.abs(t - time) <= 10 * MIN);
  const neighbors = local.concat(time).sort((a, b) => a - b);
  for (let i = 2; i < neighbors.length; i++)
    if (neighbors[i] - neighbors[i - 2] <= 10 * MIN) return false;
  return true;
}
function inWindow(value, request, day, now = Date.now()) {
  const time = stamp(value);
  if (
    !Number.isFinite(time) ||
    format(time).slice(0, 16) !== value.replaceAll("/", "-").slice(0, 16)
  )
    fail("谈话时间无效");
  if (time % MIN !== 0) fail("学校按分钟保存，请将秒设为 00");
  const date = dateOf(time),
    weekday = new Date(date + "T00:00:00Z").getUTCDay(),
    minutes = ((time + 8 * 3600000) / MIN) % (24 * 60),
    end = time + request.durationMinutes * MIN;
  if (time > now || end > now)
    fail("谈话尚未结束，不能提前录入", "FUTURE_ACTIVITY");
  if (
    date < request.fromDate ||
    date > request.toDate ||
    weekday === 0 ||
    weekday === 6 ||
    request.excludeDates.includes(date)
  )
    fail("时间必须位于所选已过去的周一至周五，且不在排除日期内");
  if (!day || !day.editable || day.date !== date)
    fail("该日期的工作日志不可编辑", "WORKLOG_LOCKED");
  if (
    !request.ranges.some(
      ([a, b]) => minutes >= a && minutes + request.durationMinutes <= b,
    )
  )
    fail("谈话开始至结束必须完整位于白天工作时段内");
  return time;
}
function build(snapshot, request, now = Date.now()) {
  const byId = new Map(snapshot.students.map((s) => [s.studentId, s])),
    dayMap = new Map(snapshot.days.map((d) => [d.date, d])),
    times = snapshot.records.map((r) => stamp(r.thsj)).sort((a, b) => a - b);
  if (times.some((t) => !Number.isFinite(t)))
    fail("已有谈话时间无法解析，不能可靠检查录入密度", "SCHOOL_DATA_INVALID");
  const studentTimes = new Map();
  for (const r of snapshot.records) {
    if (!studentTimes.has(r.xh)) studentTimes.set(r.xh, new Set());
    studentTimes.get(r.xh).add(stamp(r.thsj));
  }
  const weekLoads = new Map(),
    dayLoads = new Map();
  for (const r of snapshot.records) {
    const date = dateOf(stamp(r.thsj)),
      day = dayMap.get(date);
    if (day) {
      weekLoads.set(day.week, (weekLoads.get(day.week) || 0) + 1);
      dayLoads.set(date, (dayLoads.get(date) || 0) + 1);
    }
  }
  const candidates = [],
    eligibleDays = new Map();
  for (const day of snapshot.days) {
    const date = day.date,
      weekday = new Date(date + "T00:00:00Z").getUTCDay();
    if (
      !day.editable ||
      date < request.fromDate ||
      date > request.toDate ||
      weekday === 0 ||
      weekday === 6 ||
      request.excludeDates.includes(date)
    )
      continue;
    const midnight = Date.parse(date + "T00:00:00+08:00");
    let count = 0;
    for (const [start, end] of request.ranges)
      for (
        let m = start;
        m + request.durationMinutes <= end;
        m += Math.max(5, request.durationMinutes)
      ) {
        const t = midnight + m * MIN;
        if (t + request.durationMinutes * MIN <= now) {
          candidates.push({ time: t, day });
          count++;
        }
      }
    if (count)
      eligibleDays.set(day.week, (eligibleDays.get(day.week) || 0) + 1);
  }
  const operations = [],
    todo = [];
  for (const id of [...request.studentIds].sort()) {
    const student = byId.get(id);
    if (!student)
      fail(
        "名单已变化，请重新读取；不会录入所带名单之外的学生",
        "STUDENT_NOT_OWNED",
      );
    const count = student.semesterCount;
    if (request.skipRecorded && count >= request.targetCount) {
      const first = snapshot.records.find((r) => r.xh === id),
        day = dayMap.get(first?.thsj?.slice(0, 10));
      operations.push({
        studentId: id,
        studentName: student.name,
        week: day?.week || snapshot.calendar.week,
        type: "worklog-talk",
        occurrence: 1,
        status: "skipped",
        reason: `本学期工作日志已谈话 ${count} 次，达到目标 ${request.targetCount} 次`,
        payload: { recordedAt: first?.thsj || null },
      });
      continue;
    }
    const missing = request.skipRecorded
      ? request.targetCount - count
      : request.targetCount;
    for (let n = 1; n <= missing; n++) {
      if (operations.length + todo.length >= 1500)
        fail("一次最多 1500 条谈话，请缩小范围");
      const op = {
        studentId: id,
        studentName: student.name,
        week: snapshot.calendar.week,
        type: "worklog-talk",
        occurrence: n,
        status: "planned",
        payload: {
          content: request.content,
          durationMinutes: request.durationMinutes,
          method: request.method,
          targetCount: request.targetCount,
          skipRecorded: request.skipRecorded,
          ranges: request.ranges,
          fromDate: request.fromDate,
          toDate: request.toDate,
          excludeDates: request.excludeDates,
          baselineSemesterCount: count,
          baselineSchoolCount: student.schoolCount,
        },
      };
      if (!student.hasContact)
        operations.push({
          ...op,
          status: "not_applicable",
          reason:
            "学校名单缺少联系方式，请先在学校系统补全，未生成虚构联系方式",
        });
      else todo.push(op);
    }
  }
  const min = Date.parse(request.fromDate + "T00:00:00+08:00"),
    max = Math.min(Date.parse(request.toDate + "T23:59:59+08:00"), now);
  for (let i = 0; i < todo.length; i++) {
    const op = todo[i],
      ideal = min + ((max - min) * (i + 0.5)) / todo.length;
    let best = null,
      bestScore;
    for (const slot of candidates) {
      if (
        studentTimes.get(op.studentId)?.has(slot.time) ||
        !densityOK(slot.time, times, true)
      )
        continue;
      const score = [
        (weekLoads.get(slot.day.week) || 0) /
          (eligibleDays.get(slot.day.week) || 1),
        dayLoads.get(slot.day.date) || 0,
        Math.abs(slot.time - ideal),
      ];
      if (
        !best ||
        score[0] < bestScore[0] ||
        (score[0] === bestScore[0] &&
          (score[1] < bestScore[1] ||
            (score[1] === bestScore[1] && score[2] < bestScore[2])))
      ) {
        best = slot;
        bestScore = score;
      }
    }
    if (!best) {
      operations.push({
        ...op,
        status: "not_applicable",
        reason:
          "已过去的可编辑工作时段容量不足，未安排未来时间；请缩小范围或核对学校日志状态",
      });
      continue;
    }
    op.week = best.day.week;
    op.payload = {
      ...op.payload,
      recordedAt: format(best.time),
      date: best.day.date,
      gzrzid: best.day.gzrzid,
    };
    operations.push(op);
    if (!studentTimes.has(op.studentId))
      studentTimes.set(op.studentId, new Set());
    studentTimes.get(op.studentId).add(best.time);
    times.splice(lowerBound(times, best.time), 0, best.time);
    weekLoads.set(best.day.week, (weekLoads.get(best.day.week) || 0) + 1);
    dayLoads.set(best.day.date, (dayLoads.get(best.day.date) || 0) + 1);
  }
  operations.sort(
    (a, b) =>
      (a.payload.recordedAt || "").localeCompare(b.payload.recordedAt || "") ||
      a.studentId.localeCompare(b.studentId) ||
      a.occurrence - b.occurrence,
  );
  return {
    operations,
    summary: Object.fromEntries(
      ["planned", "skipped", "not_applicable", "unconfirmed"].map((s) => [
        s,
        operations.filter((o) => o.status === s).length,
      ]),
    ),
    distribution: [...new Set(snapshot.days.map((d) => d.week))]
      .sort((a, b) => a - b)
      .map((week) => ({
        week,
        existing: snapshot.records.filter(
          (r) => dayMap.get(r.thsj.slice(0, 10))?.week === week,
        ).length,
        planned: operations.filter(
          (o) => o.status === "planned" && o.week === week,
        ).length,
      })),
    unscheduled: operations.filter((o) => o.status === "not_applicable").length,
  };
}
module.exports = {
  stamp,
  dateOf,
  format,
  normalize,
  densityOK,
  inWindow,
  build,
  DAY,
  MIN,
};
