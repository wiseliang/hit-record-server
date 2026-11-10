const router = require("express").Router(),
  planner = require("../services/worklogPlanner"),
  wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
router.post(
  "/scan",
  wrap(async (req, res) =>
    res.status(202).json(await planner.startScan(req.openid)),
  ),
);
router.get(
  "/scans/:id",
  wrap(async (req, res) =>
    res.json(await planner.getSnapshot(req.params.id, req.openid)),
  ),
);
router.post(
  "/scans/:id/cancel",
  wrap(async (req, res) =>
    res.json(await planner.cancelScan(req.params.id, req.openid)),
  ),
);
router.post(
  "/preview",
  wrap(async (req, res) =>
    res.json(await planner.preview(req.openid, req.body)),
  ),
);
router.post(
  "/plans/:id/review",
  wrap(async (req, res) =>
    res.json(await planner.review(req.openid, req.params.id, req.body)),
  ),
);
module.exports = router;
