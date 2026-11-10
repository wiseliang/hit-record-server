const pool = require("../config/database"),
  model = require("../models/tasksV12"),
  logger = require("../utils/logger");
const { AppError } = require("../utils/errors"),
  { withSemester } = require("../utils/week");
const { pendingLogins } = require("./login"),
  browser = require("./browser"),
  nav = require("./navigator"),
  driver = require("./recordDriver");
const queue = [],
  live = new Map();
let stopping = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cancelled = () => new AppError(409, "TASK_CANCELLED", "任务已请求停止");
async function state(uuid) {
  const [rows] = await pool.query(
    "SELECT status FROM tasks WHERE task_uuid=?",
    [uuid],
  );
  return rows[0]?.status;
}
async function checkpoint(uuid) {
  let s = await state(uuid);
  if (s === "pause_requested") {
    await pool.query(
      "UPDATE tasks SET status='paused',paused=1 WHERE task_uuid=? AND status='pause_requested'",
      [uuid],
    );
    s = await state(uuid);
  }
  while (s === "paused") {
    await sleep(800);
    s = await state(uuid);
  }
  if (s === "cancel_requested" || !model.ACTIVE.includes(s)) throw cancelled();
}
function enqueue(uuid, openid, session) {
  if (queue.some((x) => x.uuid === uuid) || live.has(uuid)) return;
  queue.push({ uuid, openid, session });
  pendingLogins.delete(openid);
  void pump();
}
async function pump() {
  if (stopping) return;
  while (live.size < 2 && queue.length) {
    const item = queue.shift();
    live.set(item.uuid, item);
    void execute(item)
      .catch((e) => logger.error(e.message, { task: item.uuid }))
      .finally(() => {
        live.delete(item.uuid);
        void pump();
      });
  }
}
async function finish(uuid, status, reason = null) {
  await pool.query(
    "UPDATE tasks SET status=?,failure_reason=?,paused=0,completed_at=UTC_TIMESTAMP() WHERE task_uuid=? AND status IN (?)",
    [status, reason, uuid, model.ACTIVE],
  );
}
async function execute(item) {
  const { uuid, openid, session } = item;
  let heartbeat;
  try {
    const task = await model.rawTask(uuid, openid),
      options = model.parse(task.options);
    await pool.query(
      "UPDATE tasks SET status='running',started_at=UTC_TIMESTAMP(),heartbeat_at=UTC_TIMESTAMP() WHERE task_uuid=? AND status='queued'",
      [uuid],
    );
    heartbeat = setInterval(
      () =>
        pool
          .query(
            "UPDATE tasks SET heartbeat_at=UTC_TIMESTAMP() WHERE task_uuid=?",
            [uuid],
          )
          .catch(() => {}),
      10000,
    );
    heartbeat.unref();
    await withSemester(options.calendar, async () => {
      const ops = await model.operations(uuid);
      let worklogState = null;
      if (task.type === "worklog-talk" || options.scope === "academic") {
        const current = await require("./academicCalendar").syncSchoolCalendar(
          session.page,
        );
        if (current.startDate !== options.calendar.startDate)
          throw new AppError(
            409,
            "CALENDAR_CHANGED",
            "学校学期已变化，请重新读取名单，未录入",
          );
        if(task.type === "worklog-talk") worklogState = await require("./worklogSchool").readSnapshot(
          session.page,
          current,
        );
      }
      let loadedWeek = null;
      for (const row of ops) {
        if (row.status !== "planned") continue;
        await checkpoint(uuid);
        session._lastUsed = Date.now();
        if (task.type !== "worklog-talk" && loadedWeek !== row.week) {
          await nav.navigateAndQuery(session.page, row.week);
          loadedWeek = row.week;
        }
        await checkpoint(uuid);
        await model.setOperation(row.id, "in_progress");
        const operation = {
          id: row.id,
          studentId: row.student_id,
          studentName: row.student_name,
          week: row.week,
          type: row.type,
          payload: row.payload,
        };
        if(options.scope === "academic") {
          const check=await require("./academicGuard").check(session.page,options.calendar,operation);
          if(check.skip){await model.setOperation(row.id,"skipped",null,"本周已有对应记录，自动跳过");continue;}
        }
        const result =
          row.type === "worklog-talk"
            ? await require("./worklogDriver").saveOperation(
                session.page,
                operation,
                () => checkpoint(uuid),
                worklogState,
              )
            : await driver.saveOperation(session.page, operation, async () => {
                await checkpoint(uuid);
                if(options.scope === "academic") {
                  const fresh=await require("./academicGuard").check(session.page,options.calendar,operation);
                  if(fresh.skip)throw new AppError(409,"RECORD_CHANGED","该学生已有记录，已停止本项，请重新预览");
                }
              });
        await model.setOperation(
          row.id,
          result.status,
          result.receipt || null,
          result.reason || null,
        );
        await pool.query(
          "UPDATE tasks SET current_student=? WHERE task_uuid=?",
          [`第${row.week}周 · ${row.student_name}`, uuid],
        );
        if (result.status === "cancelled") throw cancelled();
      }
    });
    const final = await model.getTask(uuid, openid),
      control = await state(uuid);
    if (control === "cancel_requested")
      await finish(uuid, "cancelled", "已在安全边界停止；已保存记录保留");
    else if (
      (task.type === "worklog-talk" || options.scope === "academic") &&
      final.details.some((o) => o.status === "not_applicable")
    )
      await finish(
        uuid,
        final.progress.success ? "partial_failed" : "failed",
        "部分人员因工作时段容量或联系方式不足未安排，请核对结果；没有提前录入未来时间",
      );
    else if (final.progress.error || final.progress.unconfirmed)
      await finish(
        uuid,
        final.progress.success ? "partial_failed" : "failed",
        final.progress.unconfirmed ? "有保存结果待回查，不会自动重试" : null,
      );
    else await finish(uuid, "completed");
  } catch (e) {
    if (e.code === "TASK_CANCELLED") {
      await pool.query(
        "UPDATE task_operations SET status='cancelled',reason='用户终止，尚未执行' WHERE task_uuid=? AND status='planned'",
        [uuid],
      );
      await finish(uuid, "cancelled", "已停止，已保存记录保留");
    } else {
      await pool
        .query(
          "UPDATE task_operations SET status='unconfirmed',reason='执行被中断，保存结果需回查' WHERE task_uuid=? AND status='in_progress'",
          [uuid],
        )
        .catch(() => {});
      await finish(
        uuid,
        "interrupted",
        e.message === "SESSION_EXPIRED"
          ? "学校会话已过期，已停止后续录入；请重新验证后仅重试未保存项"
          : e.message,
      ).catch(() => {});
    }
  } finally {
    clearInterval(heartbeat);
    await model.releaseLock(openid, uuid).catch(() => {});
    if (session.page && !session.page.isClosed() && !stopping) {
      session.step = "ready";
      pendingLogins.set(openid, session);
      await require('./schoolSession').persist(openid,session).catch(()=>{});
    } else await browser.releaseContext(session.slot).catch(() => {});
  }
}
async function control(uuid, openid, action) {
  const task = await model.rawTask(uuid, openid);
  const transitions = {
    pause: { from: ["running"], to: "pause_requested" },
    resume: { from: ["paused"], to: "running" },
    cancel: {
      from: [
        "queued",
        "running",
        "paused",
        "pause_requested",
        "awaiting_input",
      ],
      to: "cancel_requested",
    },
  };
  const transition = transitions[action];
  if (!transition) throw new AppError(400, "INVALID_ACTION", "任务操作无效");
  if (!transition.from.includes(task.status))
    throw new AppError(409, "INVALID_TASK_STATE", "当前任务状态不支持这项操作");
  if (action !== "cancel" && !live.has(uuid)) {
    await finish(uuid, "interrupted", "执行器已中断，请查看收据后重试失败项");
    await model.releaseLock(openid, uuid);
    throw new AppError(
      409,
      "WORKER_INTERRUPTED",
      "执行器已中断，不能直接继续；请先查看结果",
    );
  }
  const [changed] = await pool.query(
    "UPDATE tasks SET status=?,paused=? WHERE task_uuid=? AND openid=? AND status IN (?)",
    [
      transition.to,
      action === "resume" ? 0 : task.paused,
      uuid,
      openid,
      transition.from,
    ],
  );
  if (!changed.affectedRows)
    throw new AppError(409, "TASK_STATE_CHANGED", "任务状态已变化，请刷新");
  const queued = queue.findIndex((x) => x.uuid === uuid);
  if (action === "cancel" && queued >= 0) {
    const [entry] = queue.splice(queued, 1);
    await finish(uuid, "cancelled", "排队期间已取消，未执行录入");
    await pool.query(
      "UPDATE task_operations SET status='cancelled',reason='排队期间取消' WHERE task_uuid=? AND status='planned'",
      [uuid],
    );
    await model.releaseLock(openid, uuid);
    pendingLogins.set(openid, entry.session);
  }
  if (action === "cancel" && queued < 0 && !live.has(uuid)) {
    await pool.query(
      "UPDATE task_operations SET status='unconfirmed',reason='执行器已中断，可能已提交，请回查' WHERE task_uuid=? AND status='in_progress'",
      [uuid],
    );
    await pool.query(
      "UPDATE task_operations SET status='cancelled',reason='未执行，已取消' WHERE task_uuid=? AND status='planned'",
      [uuid],
    );
    await finish(uuid, "cancelled", "已停止后续录入；请核对已保存及待回查项");
    await model.releaseLock(openid, uuid);
  }
  return { status: await state(uuid) };
}
async function verify(uuid, openid) {
  const task = await model.rawTask(uuid, openid);
  if (model.ACTIVE.includes(task.status))
    throw new AppError(409, "TASK_ACTIVE", "请等待当前任务结束再回查");
  const session = await require('./schoolSession').getSession(openid);
  await require("./schoolSession").requireSchoolSession(session);
  const options = model.parse(task.options);
  if (session.calendar?.startDate !== options.calendar.startDate)
    throw new AppError(
      409,
      "CALENDAR_CHANGED",
      "任务属于另一学期，请在学校系统人工核对",
    );
  if (session.busyPlan)
    throw new AppError(409, "SCAN_ACTIVE", "当前正在检查名单，请稍候");
  session.busyPlan = "verify-" + uuid;
  try {
    await withSemester(options.calendar, async () => {
      for (const row of (await model.operations(uuid)).filter(
        (o) => o.status === "unconfirmed",
      )) {
        if (row.type === "worklog-talk") {
          const day = { date: row.payload.date, gzrzid: row.payload.gzrzid },
            records = await require("./worklogSchool").dayRecords(
              session.page,
              day,
            ),
            found = records.filter((r) =>
              require("./worklogDriver").same(r, {
                studentId: row.student_id,
                payload: row.payload,
              }),
            );
          if (found.length === 1)
            await model.setOperation(
              row.id,
              "succeeded",
              {
                schoolRecordId: String(found[0].id),
                scope: "工作日志管理/学生谈话",
                verified: true,
                verifiedAt: new Date().toISOString(),
                recordedAt: row.payload.recordedAt,
              },
              "只读回查确认学校已保存",
            );
          else
            await model.setOperation(
              row.id,
              "unconfirmed",
              null,
              found.length
                ? "多条记录匹配，需在学校人工核对"
                : "未取得唯一回执，不会自动重试",
            );
          continue;
        }
        await nav.navigateAndQuery(session.page, row.week);
        const info = await driver.inspectStudent(
          session.page,
          row.student_id,
          row.type,
        );
        const found = info.records.filter((r) =>
          driver.matches(r, row.payload),
        );
        if (found.length === 1)
          await model.setOperation(
            row.id,
            "succeeded",
            {
              schoolRecordId: driver.recordId(found[0]),
              verified: true,
              verifiedAt: new Date().toISOString(),
              studentId: row.student_id,
              week: row.week,
              type: row.type,
              recordedAt: row.payload.recordedAt,
            },
            "回查确认学校已保存",
          );
        else
          await model.setOperation(
            row.id,
            "unconfirmed",
            null,
            found.length > 1
              ? "发现多条匹配，请人工核对，不会自动重复提交"
              : "暂未查到唯一收据，请到学校系统核对；不会自动重新提交",
          );
      }
    });
    const result = await model.getTask(uuid, openid);
    if (
      result.progress.processed === result.total &&
      !result.progress.error &&
      !result.progress.unconfirmed
    )
      await pool.query(
        "UPDATE tasks SET status='completed',failure_reason=NULL WHERE task_uuid=? AND status IN ('partial_failed','failed','interrupted')",
        [uuid],
      );
    return model.getTask(uuid, openid);
  } finally {
    session.busyPlan = null;
  }
}
async function stop() {
  stopping = true;
  for (const id of live.keys())
    await pool.query(
      "UPDATE tasks SET status='cancel_requested' WHERE task_uuid=? AND status IN (?)",
      [id, model.ACTIVE],
    );
  await model.recoverOrphans();
}
async function reapOrphans() {
  const [rows] = await pool.query(
    "SELECT task_uuid,openid FROM tasks WHERE status IN (?) AND created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 2 MINUTE)",
    [model.ACTIVE],
  );
  for (const row of rows) {
    if (
      live.has(row.task_uuid) ||
      queue.some((item) => item.uuid === row.task_uuid)
    )
      continue;
    await pool.query(
      "UPDATE task_operations SET status='unconfirmed',reason='执行器丢失，保存结果需回查' WHERE task_uuid=? AND status='in_progress'",
      [row.task_uuid],
    );
    await finish(
      row.task_uuid,
      "interrupted",
      "执行器已中断，请先查看已有收据",
    );
    await model.releaseLock(row.openid, row.task_uuid);
  }
}
module.exports = {
  reapOrphans,
  enqueue,
  control,
  verify,
  live,
  queue,
  checkpoint,
  stop,
  finish,
  pump,
};
