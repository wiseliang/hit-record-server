const router = require("express").Router(),
  service = require("../services/contentTemplates");
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
router.get(
  "/",
  wrap(async (req, res) => res.json(await service.get(req.openid))),
);
router.post(
  "/",
  wrap(async (req, res) =>
    res.json(await service.change(req.openid, req.body)),
  ),
);
module.exports = router;
