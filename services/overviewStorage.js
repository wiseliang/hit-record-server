const pool = require("../config/database"),
  model = require("../models/tasksV12"),
  crypto = require("crypto");
const written = new Map();
async function save(id, data) {
  const parts = [];
  if (data.kind === "worklog" && data.weekCheckedAt) {
    const weeks = new Set(Object.keys(data.weekCheckedAt).map(Number));
    if (
      (data.records || []).some(
        (r) => !Number.isInteger(r.week) || !weeks.has(r.week),
      )
    )
      throw new Error(
        "工作日志记录缺少有效所属周次，已停止保存快照，不能按零次处理",
      );
  }
  if (data.kind === "academic")
    for (const info of data.weeks || [])
      parts.push({ week: info.week, payload: info });
  if (data.kind === "worklog" && data.weekCheckedAt)
    for (const [week, checkedAt] of Object.entries(data.weekCheckedAt))
      parts.push({
        week: Number(week),
        payload: {
          readCompletedAt: checkedAt,
          days: (data.days || []).filter((d) => d.week === Number(week)),
          records: (data.records || []).filter((r) => r.week === Number(week)),
        },
      });
  for (const part of parts) {
    const signature = JSON.stringify(part.payload),
      key = id + ":" + part.week;
    const hash = crypto.createHash("sha256").update(signature).digest("hex");
    if (written.get(key) === hash) continue;
    await pool.query(
      "INSERT INTO overview_partitions(snapshot_id,week,payload) VALUES (?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload)",
      [id, part.week, signature],
    );
    written.set(key, hash);
  }
  while (written.size > 500) written.delete(written.keys().next().value);
  const metadata = { ...data, partitioned: true };
  delete metadata.weeks;
  delete metadata.days;
  delete metadata.records;
  await pool.query("UPDATE overview_snapshots SET payload=? WHERE id=?", [
    JSON.stringify(metadata),
    id,
  ]);
}
async function hydrate(id, data) {
  if (!data.partitioned) return data;
  const [parts] = await pool.query(
    "SELECT week,payload FROM overview_partitions WHERE snapshot_id=? ORDER BY week",
    [id],
  );
  if (data.kind === "academic")
    return { ...data, weeks: parts.map((r) => model.parse(r.payload)) };
  const bodies = parts.map((r) => model.parse(r.payload));
  return {
    ...data,
    days: bodies.flatMap((x) => x.days || []),
    records: bodies.flatMap((x) => x.records || []),
  };
}
module.exports = { save, hydrate };
