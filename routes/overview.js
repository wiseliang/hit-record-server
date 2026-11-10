const router = require("express").Router(),
  service = require("../services/overview"),
  wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
router.get(
  "/latest",
  wrap(async (req, res) =>
    res.json(await service.latest(req.openid, req.query.kind, req.query)),
  ),
);
router.post(
  "/scan",
  wrap(async (req, res) =>
    res.status(202).json(await service.start(req.openid, req.body.kind)),
  ),
);
router.get(
  "/:id",
  wrap(async (req, res) =>
    res.json(await service.get(req.params.id, req.openid, req.query)),
  ),
);
router.post(
  "/:id/cancel",
  wrap(async (req, res) =>
    res.json(await service.cancel(req.params.id, req.openid)),
  ),
);
router.get(
  "/:id/students/:studentId",
  wrap(async (req, res) =>
    res.json(
      await service.detail(
        req.params.id,
        req.openid,
        req.params.studentId,
        req.query,
      ),
    ),
  ),
);
router.post(
  "/:id/selection",
  wrap(async (req, res) =>
    res.json(await service.selection(req.params.id, req.openid, req.body)),
  ),
);
module.exports = router;
