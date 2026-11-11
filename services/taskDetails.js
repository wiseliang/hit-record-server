const pool = require("../config/database"),
  model = require("../models/tasksV12");
async function page(uuid, openid, options = {}) {
  await model.rawTask(uuid, openid);
  const index = Math.max(1, Math.trunc(Number(options.page) || 1)),
    size = Math.min(
      50,
      Math.max(1, Math.trunc(Number(options.pageSize) || 30)),
    );
  const clauses = ["task_uuid=?"],
    params = [uuid];
  if (options.issues === "1") {
    clauses.push(
      "status IN ('failed','unconfirmed','planned','cancelled','not_applicable')",
    );
  }
  if (options.query) {
    clauses.push("(student_id LIKE ? OR student_name LIKE ?)");
    params.push(
      "%" + String(options.query).trim() + "%",
      "%" + String(options.query).trim() + "%",
    );
  }
  const where = clauses.join(" AND "),
    [counts] = await pool.query(
      "SELECT COUNT(*) AS total FROM task_operations WHERE " + where,
      params,
    );
  const [rows] = await pool.query(
    "SELECT id,student_id,student_name,week,type,status,payload,reason,receipt,occurrence FROM task_operations WHERE " +
      where +
      " ORDER BY week,student_id,id LIMIT ? OFFSET ?",
    [...params, size, (index - 1) * size],
  );
  return {
    page: index,
    total: Number(counts[0].total),
    hasMore: index * size < Number(counts[0].total),
    items: rows.map((o) => {
      const p = model.parse(o.payload);
      return {
        id: o.id,
        studentId: o.student_id,
        name: o.student_name,
        week: o.week,
        type: o.type,
        status: o.status,
        reason: o.reason,
        receipt: model.parse(o.receipt, null),
        recordedAt: p.recordedAt,
        occurrence: o.occurrence,
        goal: p.academicGoal,
        scene: p.scene,
        pbType: p.pbType,
      };
    }),
  };
}
module.exports = { page };
