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
router.post(
  "/create",
  wrap(async (req, res) => {
    const { planId, requestId } = req.body;
    if (
      typeof planId !== "string" ||
      typeof requestId !== "string" ||
      requestId.length > 80
    )
      throw new AppError(
        426,
        "APP_UPDATE_REQUIRED",
        "请使用新版预览流程后再提交，不会直接执行旧版请求",
      );
    const session = pendingLogins.get(req.openid);
    const plan = await planner.getPlan(planId, req.openid);
    if (plan.usedBy) return res.json({ taskUuid: plan.usedBy, existing: true });
    await require("../services/schoolSession").requireSchoolSession(session);
    if (session.busyPlan)
      throw new AppError(409, "SCAN_ACTIVE", "检查尚未结束");
    if (session.calendar?.startDate !== plan.calendar.startDate)
      throw new AppError(409, "CALENDAR_CHANGED", "学期已变化，请重新检查");
    const task = await model.createFromPlan(req.openid, planId, requestId);
    if (!task.existing) runner.enqueue(task.taskUuid, req.openid, session);
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
