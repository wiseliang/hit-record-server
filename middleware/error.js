const logger = require("../utils/logger");
module.exports = (error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || 500;
  logger.error(error.message, { code: error.code, status, path: req.path });
  res
    .status(status)
    .json({
      error:
        status === 500 && !error.code
          ? "服务暂时不可用，请稍后重试"
          : error.message,
      code: error.code || "SERVICE_ERROR",
      retryable: status >= 500 || status === 429,
      ...(error.taskUuid ? { taskUuid: error.taskUuid } : {}),
      ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
    });
};
