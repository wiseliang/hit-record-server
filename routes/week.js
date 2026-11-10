const router = require("express").Router();
router.get("/current", (req, res, next) => {
  try {
    res.json({
      ...require("../utils/week").getWeekInfo(),
      readOnly: true,
      canEdit: false,
    });
  } catch (e) {
    next(e);
  }
});
router.post(["/*", "/"], (req, res) =>
  res
    .status(410)
    .json({
      code: "USE_SCHOOL_CALENDAR",
      error: "学期以学校系统核验结果为准，请在登录后重新同步，无需手工修改",
      retryable: false,
    }),
);
module.exports = router;
