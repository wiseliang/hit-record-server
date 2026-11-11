const express = require("express"),
  config = require("./config"),
  pool = require("./config/database"),
  logger = require("./utils/logger");
const { rateLimit } = require("./middleware/rateLimit");
const app = express();
app.set("trust proxy", "loopback");
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.set(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,x-openid",
  );
  res.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(require("./routes/releases"));
app.use("/api", rateLimit({ max: 240, key: (req) => "api:" + req.ip }));
app.use("/api/week", require("./routes/week"));
app.use("/api/auth", require("./routes/auth"));
app.use(
  "/api/academic",
  require("./middleware/auth"),
  require("./routes/academic"),
);
app.use(
  "/api/worklog",
  require("./middleware/auth"),
  require("./routes/worklog"),
);
app.use(
  "/api/overview",
  require("./middleware/auth"),
  require("./routes/overview"),
);
app.use(
  "/api/content-templates",
  require("./middleware/auth"),
  require("./routes/contentTemplates"),
);
app.use("/api/task", require("./middleware/auth"), require("./routes/task"));
app.use(
  "/api/history",
  require("./middleware/auth"),
  require("./routes/history"),
);
app.use(
  "/api/academic-access",
  require("./middleware/auth"),
  require("./routes/academicAccess"),
);
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    const runner = require("./services/taskRunner"),
      browser = require("./services/browser");
    res.json({
      status: "ok",
      version: require("./package.json").version,
      database: "ok",
      activeWorkers: runner.live.size,
      queuedTasks: runner.queue.length,
      browserContexts: browser.activeCount(),
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(503).json({
      status: "degraded",
      version: require("./package.json").version,
      database: "unavailable",
      code: "DEPENDENCY_UNAVAILABLE",
    });
  }
});
app.use((req, res) =>
  res.status(404).json({
    error: "接口不存在，请确认使用最新版应用",
    code: "NOT_FOUND",
    retryable: false,
  }),
);
app.use(require("./middleware/error"));
async function start() {
  if (!config.auth.secret || Buffer.byteLength(config.auth.secret) < 32)
    throw Error("AUTH_SECRET must contain at least 32 bytes");
  if (
    !process.env.ENCRYPTION_KEY ||
    Buffer.byteLength(process.env.ENCRYPTION_KEY) < 32
  )
    throw Error("ENCRYPTION_KEY must contain at least 32 bytes");
  await require("./scripts/migrate-v12").migrate();
  await require("./models/tasksV12").recoverOrphans();
  await require("./services/overview").recover();
  await require("./services/maintenance").cleanup();
  const maintenance = setInterval(
    () =>
      require("./services/maintenance")
        .cleanup()
        .then((r) => logger.info("Temporary data cleanup", r))
        .catch((e) => logger.error(e.message)),
    6 * 3600000,
  );
  maintenance.unref();
  const reaper = setInterval(
    () =>
      require("./services/taskRunner")
        .reapOrphans()
        .catch((e) => logger.error(e.message)),
    30000,
  );
  reaper.unref();
  const server = app.listen(config.port, process.env.HOST || "127.0.0.1", () =>
    logger.info("Student recorder ready", {
      port: config.port,
      version: require("./package.json").version,
    }),
  );
  let closing = false;
  async function stop(exitCode = 0) {
    if (closing) return;
    closing = true;
    clearInterval(reaper);
    clearInterval(maintenance);
    server.close();
    const timer = setTimeout(() => process.exit(1), 12000);
    timer.unref();
    try {
      await require("./services/taskRunner").stop();
      await require("./services/browser").shutdown();
      await pool.end();
      process.exit(exitCode);
    } catch (e) {
      logger.error(e.message);
      process.exit(1);
    }
  }
  process.on("SIGTERM", () => void stop(0));
  process.on("SIGINT", () => void stop(0));
  process.on("uncaughtException", (e) => {
    logger.error(e.message, { event: "uncaughtException" });
    void stop(1);
  });
  process.on("unhandledRejection", (e) => {
    logger.error(e?.message || String(e), { event: "unhandledRejection" });
    void stop(1);
  });
  return server;
}
if (require.main === module)
  start().catch((e) => {
    logger.error(e.message);
    process.exit(1);
  });
module.exports = app;
module.exports.start = start;
