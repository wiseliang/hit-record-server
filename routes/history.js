const router = require("express").Router(),
  pool = require("../config/database"),
  { parse, ACTIVE } = require("../models/tasksV12");
router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1),
      pageSize = Math.max(1, Math.min(50, Number(req.query.pageSize) || 20)),
      search = String(req.query.search || "").trim(),
      status = String(req.query.status || "");
    const params = [req.openid],
      clauses = ["openid=?"];
    if (status === "active") {
      clauses.push("status IN (?)");
      params.push(ACTIVE);
    } else if (status) {
      clauses.push("status=?");
      params.push(status);
    }
    if (search) {
      clauses.push("(task_uuid LIKE ? OR CAST(options AS CHAR) LIKE ?)");
      params.push("%" + search + "%", "%" + search + "%");
    }
    const where = clauses.join(" AND "),
      [count] = await pool.query(
        "SELECT COUNT(*) AS total FROM tasks WHERE " + where,
        params,
      );
    const [rows] = await pool.query(
      "SELECT * FROM tasks WHERE " +
        where +
        " ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
      [...params, pageSize, (page - 1) * pageSize],
    );
    res.json({
      page,
      pageSize,
      total: count[0].total,
      hasMore: page * pageSize < count[0].total,
      items: rows.map((t) => {
        const opts = parse(t.options);
        return {
          taskUuid: t.task_uuid,
          type: t.type,
          status: t.status,
          calendar: opts.calendar,
          weeks: opts.weeks || [t.week],
          createdAt: t.created_at,
          currentStudent: t.current_student,
          failureReason: t.failure_reason,
        };
      }),
    });
  } catch (e) {
    next(e);
  }
});
module.exports = router;
