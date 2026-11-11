const router = require("express").Router(),
  service = require("../services/academicAccess"),
  { rateLimit } = require("../middleware/rateLimit");
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
router.post(
  "/start",
  rateLimit({ max: 4, key: (req) => "academic-start:" + req.openid }),
  wrap(async (req, res) =>
    res.status(202).json(await service.start(req.openid)),
  ),
);
router.post(
  "/code",
  rateLimit({ max: 10, key: (req) => "academic-code:" + req.openid }),
  wrap(async (req, res) =>
    res.status(202).json(await service.code(req.openid, req.body.code)),
  ),
);
router.get(
  "/status",
  wrap(async (req, res) => res.json(await service.status(req.openid))),
);
router.post(
  "/release",
  wrap(async (req, res) => res.json(await service.release(req.openid))),
);
module.exports = router;
