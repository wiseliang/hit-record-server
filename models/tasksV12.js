const pool = require("../config/database"),
  crypto = require("crypto");
const { AppError } = require("../utils/errors");
const ACTIVE = [
  "queued",
  "running",
  "awaiting_input",
  "pause_requested",
  "paused",
  "cancel_requested",
];
const TERMINAL = [
  "completed",
  "partial_failed",
  "failed",
  "cancelled",
  "interrupted",
];
function parse(v, fallback = {}) {
  if (v == null) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  }
  return v;
}
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v;
}
const hash = (v) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
async function active(openid) {
  const [rows] = await pool.query(
    "SELECT task_uuid,status FROM tasks WHERE openid=? AND status IN (?) ORDER BY created_at DESC LIMIT 1",
    [openid, ACTIVE],
  );
  return rows[0] || null;
}
async function recoverOrphans() {
  await pool.query("UPDATE tasks SET status=IF(success_count>0,'partial_failed','failed') WHERE status='completed' AND error_count>0");
  await pool.query(
    "UPDATE task_operations SET status='unconfirmed',reason='服务中断时保存可能已发出，请先回查' WHERE status='in_progress'",
  );
  await pool.query(
    "UPDATE tasks SET status='interrupted',failure_reason='服务已重启，执行已中断；已保存收据保留，请先核对结果',completed_at=UTC_TIMESTAMP(),paused=0 WHERE status IN (?)",
    [[...ACTIVE, "pending", "awaiting_code"]],
  );
  await pool.query(
    "UPDATE task_plans SET payload=JSON_SET(payload,'$.state','interrupted','$.error','服务重启，请重新检查') WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.state'))='scanning'",
  );
  await pool.query("UPDATE task_user_locks SET task_uuid=NULL");
}
async function createFromPlan(openid, planId, requestId) {
  const c = await pool.getConnection();
  try {
    await c.query("INSERT IGNORE INTO task_user_locks(openid) VALUES (?)", [
      openid,
    ]);
    await c.beginTransaction();
    const [locks] = await c.query(
      "SELECT task_uuid FROM task_user_locks WHERE openid=? FOR UPDATE",
      [openid],
    );
    const [again] = await c.query(
      "SELECT task_uuid,request_hash FROM tasks WHERE openid=? AND request_id=? FOR UPDATE",
      [openid, requestId],
    );
    if (again.length) {
      if (again[0].request_hash !== hash({ planId }))
        throw new AppError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "请求编号已用于其他内容",
        );
      await c.commit();
      return { taskUuid: again[0].task_uuid, existing: true };
    }
    if (locks[0].task_uuid) {
      const [existing] = await c.query(
        "SELECT status FROM tasks WHERE task_uuid=?",
        [locks[0].task_uuid],
      );
      if (existing.length && ACTIVE.includes(existing[0].status))
        throw new AppError(
          409,
          "TASK_ACTIVE",
          "当前还有任务，请先查看或结束它",
          { taskUuid: locks[0].task_uuid },
        );
    }
    const [plans] = await c.query(
      "SELECT * FROM task_plans WHERE id=? AND openid=? AND expires_at>UTC_TIMESTAMP() FOR UPDATE",
      [planId, openid],
    );
    if (!plans.length)
      throw new AppError(409, "PLAN_EXPIRED", "预览已过期，请重新检查");
    const plan = parse(plans[0].payload);
    if (plan.state !== "ready")
      throw new AppError(409, "PLAN_NOT_READY", "请先完成预览");
    if (plans[0].used_by) {
      await c.commit();
      return { taskUuid: plans[0].used_by, existing: true };
    }
    if (plan.operations.some((op) => op.status === "unconfirmed"))
      throw new AppError(
        409,
        "SCAN_INCOMPLETE",
        "有记录未能检查，请先重新检查这些项",
      );
    const uuid = crypto.randomUUID(),
      options = { ...plan.request, planId, calendar: plan.calendar };
    await c.query(
      "INSERT INTO tasks(task_uuid,openid,type,week,options,status,total,request_id,request_hash,retry_of) VALUES (?,?,?,?,?,'queued',?,?,?,?)",
      [
        uuid,
        openid,
        plan.request.recordType,
        plan.request.weeks[0],
        JSON.stringify(options),
        plan.operations.length,
        requestId,
        hash({ planId }),
        plan.request.retryOf || null,
      ],
    );
    for (const op of plan.operations)
      await c.query(
        "INSERT INTO task_operations(id,task_uuid,student_id,student_name,week,type,status,payload,reason) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          crypto.randomUUID(),
          uuid,
          op.studentId,
          op.studentName,
          op.week,
          op.type,
          op.status,
          JSON.stringify(op.payload),
          op.reason || null,
        ],
      );
    await c.query("UPDATE task_user_locks SET task_uuid=? WHERE openid=?", [
      uuid,
      openid,
    ]);
    await c.query("UPDATE task_plans SET used_by=? WHERE id=?", [uuid, planId]);
    await c.commit();
    return { taskUuid: uuid, existing: false };
  } catch (e) {
    await c.rollback();
    if (e.code === "ER_DUP_ENTRY") {
      const [rows] = await pool.query(
        "SELECT task_uuid FROM tasks WHERE openid=? AND request_id=?",
        [openid, requestId],
      );
      if (rows.length) return { taskUuid: rows[0].task_uuid, existing: true };
    }
    throw e;
  } finally {
    c.release();
  }
}
async function rawTask(uuid, openid) {
  const [rows] = await pool.query(
    "SELECT * FROM tasks WHERE task_uuid=? AND openid=?",
    [uuid, openid],
  );
  if (!rows.length) throw new AppError(404, "TASK_NOT_FOUND", "未找到这项任务");
  return rows[0];
}
async function operations(uuid) {
  const [rows] = await pool.query(
    "SELECT * FROM task_operations WHERE task_uuid=? ORDER BY week,student_id,id",
    [uuid],
  );
  return rows.map((o) => ({
    ...o,
    payload: parse(o.payload),
    receipt: parse(o.receipt, null),
  }));
}
async function getTask(uuid, openid) {
  const t = await rawTask(uuid, openid),
    opts = parse(t.options),
    ops = await operations(uuid);
  if (!ops.length) {
    const legacy = parse(t.errors, []);
    return {
      taskUuid: uuid,
      status: t.status,
      type: t.type,
      calendar: opts.calendar,
      weeks: opts.weeks || [t.week],
      progress: {
        processed: t.processed,
        success: t.success_count,
        skipped: t.skipped_count,
        error: t.error_count,
        unconfirmed: 0,
      },
      total: t.total,
      details: legacy.details || [],
      errors: Array.isArray(legacy) ? legacy : legacy.errorList || [],
      failureReason: t.failure_reason,
      createdAt: t.created_at,
      startedAt: t.started_at,
      completedAt: t.completed_at,
      legacy: true,
    };
  }
  const count = (s) => ops.filter((o) => s.includes(o.status)).length;
  return {
    taskUuid: uuid,
    status: t.status,
    type: t.type,
    calendar: opts.calendar,
    weeks: opts.weeks,
    week: t.week,
    total: ops.length,
    progress: {
      processed: count([
        "succeeded",
        "skipped",
        "failed",
        "unconfirmed",
        "not_applicable",
        "cancelled",
      ]),
      success: count(["succeeded"]),
      skipped: count(["skipped", "not_applicable"]),
      error: count(["failed"]),
      unconfirmed: count(["unconfirmed"]),
    },
    details: ops.map((o) => ({
      id: o.id,
      studentId: o.student_id,
      name: o.student_name,
      week: o.week,
      type: o.type,
      status: o.status,
      reason: o.reason,
      receipt: o.receipt,
      recordedAt: o.payload.recordedAt,
    })),
    errors: ops
      .filter((o) => ["failed", "unconfirmed"].includes(o.status))
      .map((o) => ({
        operationId: o.id,
        studentId: o.student_id,
        name: o.student_name,
        week: o.week,
        reason: o.reason,
      })),
    failureReason: t.failure_reason,
    retryOf: t.retry_of,
    createdAt: t.created_at,
    startedAt: t.started_at,
    completedAt: t.completed_at,
    paused: t.status === "paused",
  };
}
async function setOperation(id, status, receipt = null, reason = null) {
  await pool.query(
    "UPDATE task_operations SET status=?,receipt=?,reason=? WHERE id=?",
    [status, receipt ? JSON.stringify(receipt) : null, reason, id],
  );
}
async function releaseLock(openid, uuid) {
  await pool.query(
    "UPDATE task_user_locks SET task_uuid=NULL WHERE openid=? AND task_uuid=?",
    [openid, uuid],
  );
}
module.exports = {
  ACTIVE,
  TERMINAL,
  parse,
  hash,
  canonical,
  active,
  recoverOrphans,
  createFromPlan,
  rawTask,
  operations,
  getTask,
  setOperation,
  releaseLock,
};
