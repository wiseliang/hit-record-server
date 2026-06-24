const logger = require('../utils/logger')

module.exports = function errorHandler(err, req, res, _next) {
  logger.error(err.message, { stack: err.stack, url: req.url })
  res.status(err.status || 500).json({
    error: err.message || '服务器内部错误'
  })
}
