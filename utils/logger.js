const secretKeys =
  /password|token|secret|authorization|cookie|captcha|recovery|code/i;
function clean(value, key = "") {
  if (secretKeys.test(key)) return "[redacted]";
  if (typeof value === "string")
    return value.replace(/https?:\/\/[^\s"<>]+/g, (url) => {
      try {
        const u = new URL(url);
        return u.origin + u.pathname;
      } catch {
        return "[URL]";
      }
    });
  if (Array.isArray(value)) return value.map((v) => clean(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, clean(v, k)]),
    );
  return value;
}
function log(level, msg, data = {}) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    message: clean(String(msg)),
    ...(typeof data === "object" && data !== null
      ? clean(data)
      : { detail: clean(String(data)) }),
  });
  (level === "ERROR" ? console.error : console.log)(line);
}
module.exports = {
  info: (m, d) => log("INFO", m, d),
  warn: (m, d) => log("WARN", m, d),
  error: (m, d) => log("ERROR", m, d),
  clean,
};
