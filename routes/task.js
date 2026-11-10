const router = require("express").Router(),
  model = require("../models/tasksV12"),
  planner = require("../services/planner"),
  runner = require("../services/taskRunner");
const { AppError } = require("../utils/errors"),
  { pendingLogins } = require("../services/login");
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
router.get(
  "/active",
  wrap(async (req, res) => {
    const task = await model.active(req.openid);
    res.json({
      task: task ? await model.getTask(task.task_uuid, req.openid) : null,
    });
  }),
);
router.post(
  "/preview",
  wrap(async (req, res) =>
    res.status(202).json(await planner.start(req.openid, req.body)),
  ),
);
router.get(
  "/plans/:id",
  wrap(async (req, res) =>
    res.json(await planner.getPlan(req.params.id, req.openid)),
  ),
);
router.post(
  "/plans/:id/cancel",
  wrap(async (req, res) =>
    res.json(await planner.cancel(req.params.id, req.openid)),
  ),
);
const creates = new Map();
async function create(openid, body) {
  const { planId, requestId } = body;
  if (
    typeof planId !== "string" ||
    typeof requestId !== "string" ||
    !requestId.length ||
    requestId.length > 80
  )
    throw new AppError(426, "APP_UPDATE_REQUIRED", "请先生成录入预览后再提交");
  if (creates.has(openid)) {
    const existing = creates.get(openid);
    if (existing.planId !== planId)
      throw new AppError(409, "TASK_ACTIVE", "另一个任务正在创建");
    return existing.promise;
  }
  const session = pendingLogins.get(openid),
    priorBusy = session?.busyPlan,
    claim = "creating-" + planId;
  if (session && !priorBusy) session.busyPlan = claim;
  const promise = (async () => {
    try {
      const plan = await planner.getPlan(planId, openid);
      if (plan.usedBy) return { taskUuid: plan.usedBy, existing: true };
      if (priorBusy)
        throw new AppError(
          409,
          "SCAN_ACTIVE",
          "学校正在执行其他操作，请稍后提交",
        );
      if (plan.request?.recordType === "worklog-talk") {
        if (!plan.summary?.planned && plan.summary?.not_applicable)
          throw new AppError(
            400,
            "NO_WRITABLE_ITEMS",
            "没有可写入的过去工作时段或人员信息不完整，请核对未安排原因，不会使用未来时间",
          );
        if (body.confirmedActual !== true)
          throw new AppError(
            400,
            "ACTUAL_CONFIRMATION_REQUIRED",
            "请先逐项核对并确认实际谈话人员、时间和内容",
          );
        if (plan.revision && body.revision !== plan.revision)
          throw new AppError(409, "PLAN_CHANGED", "预览已被修改，请重新核对");
        await require("../services/schoolSession").requireSchoolSession(
          session,
        );
        session.calendar =
          await require("../services/academicCalendar").syncSchoolCalendar(
            session.page,
          );
      } else
        await require("../services/schoolSession").requireSchoolSession(
          session,
        );
      if (session.calendar?.startDate !== plan.calendar.startDate)
        throw new AppError(409, "CALENDAR_CHANGED", "学期已变化，请重新读取");
      const task = await model.createFromPlan(openid, planId, requestId);
      if (session.busyPlan === claim) session.busyPlan = null;
      if (!task.existing) runner.enqueue(task.taskUuid, openid, session);
      return task;
    } finally {
      if (session?.busyPlan === claim) session.busyPlan = null;
    }
  })();
  creates.set(openid, { planId, promise });
  try {
    return await promise;
  } finally {
    creates.delete(openid);
  }
}
router.post(
  "/create",
  wrap(async (req, res) => {
    const task = await create(req.openid, req.body);
    res.status(task.existing ? 200 : 202).json(task);
  }),
);
router.get(
  "/:uuid",
  wrap(async (req, res) =>
    res.json(await model.getTask(req.params.uuid, req.openid)),
  ),
);
for (const [path, action] of [
  ["pause", "pause"],
  ["resume", "resume"],
  ["cancel", "cancel"],
  ["abandon", "cancel"],
])
  router.post(
    "/:uuid/" + path,
    wrap(async (req, res) =>
      res.json(await runner.control(req.params.uuid, req.openid, action)),
    ),
  );
router.post(
  "/:uuid/retry-plan",
  wrap(async (req, res) =>
    res.json(await planner.retryPlan(req.params.uuid, req.openid)),
  ),
);
router.post(
  "/:uuid/verify",
  wrap(async (req, res) =>
    res.json(await runner.verify(req.params.uuid, req.openid)),
  ),
);
module.exports = router;
