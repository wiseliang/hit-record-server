const buckets = new Map();
function rateLimit({
  windowMs = 60000,
  max = 20,
  key = (req) => req.openid || req.ip,
} = {}) {
  return (req, res, next) => {
    const now = Date.now(),
      id = key(req),
      old = buckets.get(id);
    const bucket =
      old && old.until > now ? old : { until: now + windowMs, count: 0 };
    bucket.count++;
    buckets.set(id, bucket);
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.until - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res
        .status(429)
        .json({
          code: "RATE_LIMITED",
          error: `操作较频繁，请 ${retryAfter} 秒后重试`,
          retryAfter,
          retryable: true,
        });
    }
    next();
  };
}
const timer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.until < now) buckets.delete(k);
}, 60000);
timer.unref();
module.exports = { rateLimit };
