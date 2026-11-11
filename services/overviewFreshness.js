const pool = require("../config/database"),
  model = require("../models/tasksV12");
function canReuse(
  info,
  week,
  calendar,
  dirty = [],
  full = false,
  now = Date.now(),
) {
  return (
    !full &&
    week !== calendar.week &&
    !dirty.includes(week) &&
    !info?.error &&
    Number.isFinite(Date.parse(info?.readCompletedAt)) &&
    now - Date.parse(info.readCompletedAt) < 6 * 3600000
  );
}
async function markTask(uuid, openid) {
  const task = await model.rawTask(uuid, openid),
    opts = model.parse(task.options),
    ops = await model.operations(uuid);
  const affected = [
    ...new Set(
      ops
        .filter((o) => ["succeeded", "unconfirmed"].includes(o.status))
        .map((o) => o.week),
    ),
  ];
  if (!affected.length) return;
  const kind = task.type === "worklog-talk" ? "worklog" : "academic";
  const [rows] = await pool.query(
    "SELECT id,payload FROM overview_snapshots WHERE openid=? AND kind=?",
    [openid, kind],
  );
  for (const row of rows) {
    const data = model.parse(row.payload);
    if (data.calendar?.startDate !== opts.calendar?.startDate) continue;
    data.dirtyWeeks = [...new Set([...(data.dirtyWeeks || []), ...affected])];
    data.changedAt = new Date().toISOString();
    await pool.query("UPDATE overview_snapshots SET payload=? WHERE id=?", [
      JSON.stringify(data),
      row.id,
    ]);
  }
}
module.exports = { canReuse, markTask };
