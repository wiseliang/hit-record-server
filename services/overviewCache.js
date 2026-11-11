const summary = require("./overviewSummary"),
  schedule = require("./worklogSchedule");
const cache = new Map();
function compile(data, options = {}) {
  const target = Number(options.targetCount || 1),
    now = Date.now(),
    key =
      data.id &&
      [data.id, data.readCompletedAt, data.calendar.week, target].join(":");
  const hit = key && cache.get(key);
  if (hit && hit.until > now) return hit.value;
  const value =
    data.kind === "academic"
      ? summary.academic(data, now)
      : summary.worklog(data, target, now);
  let until = now + 5 * 60000;
  const timedRecords =
    data.kind === "academic"
      ? data.weeks.flatMap((w) =>
          (w.students || []).flatMap((s) => s.records || []),
        )
      : data.records;
  for (const r of timedRecords) {
    const validity = require("./recordValidity").inspect(r, now);
    const end =
      validity.time +
      (r.type === "talk" || r.thsj
        ? Number(r.thsc ?? r.duration) * schedule.MIN
        : 0);
    if (end > now) until = Math.min(until, end);
  }
  if (key) {
    cache.set(key, { until, value });
    while (cache.size > 24) cache.delete(cache.keys().next().value);
  }
  return value;
}
module.exports = { compile };
