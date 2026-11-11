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
      ? summary.academic(data)
      : summary.worklog(data, target, now);
  let until = now + 5 * 60000;
  if (data.kind === "worklog")
    for (const r of data.records) {
      const end = schedule.stamp(r.thsj) + Number(r.thsc) * schedule.MIN;
      if (end > now) until = Math.min(until, end);
    }
  if (key) {
    cache.set(key, { until, value });
    while (cache.size > 24) cache.delete(cache.keys().next().value);
  }
  return value;
}
module.exports = { compile };
