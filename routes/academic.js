const router = require("express").Router(),
  p = require("../services/academicPlanner"),
  wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
router.post(
  "/rosters",
  wrap(async (req, res) =>
    res.status(202).json(await p.startRoster(req.openid, req.body)),
  ),
);
router.get(
  "/rosters/:id",
  wrap(async (req, res) =>
    res.json(await p.snapshot(req.params.id, req.openid)),
  ),
);
router.post(
  "/rosters/:id/cancel",
  wrap(async (req, res) => res.json(await p.cancel(req.params.id, req.openid))),
);
router.post(
  "/preview",
  wrap(async (req, res) =>
    res.status(202).json(await p.preview(req.openid, req.body)),
  ),
);
router.post(
  "/plans/:id/review",
  wrap(async (req, res) =>
    res.json(await p.review(req.openid, req.params.id, req.body)),
  ),
);
router.post(
  "/plans/:id/cancel",
  wrap(async (req, res) => res.json(await p.cancel(req.params.id, req.openid))),
);
router.get(
  "/options",
  wrap(async (req, res) => {
    const session = require("../services/login").pendingLogins.peek(req.openid);
    const options = await require("../services/schoolOptions").get(
      req.openid,
      session,
    );
    res.json({
      ...options,
      ruleVersion: require("../services/academicRequirements").VERSION,
    });
  }),
);
module.exports = router;
