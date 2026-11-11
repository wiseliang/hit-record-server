const { AsyncLocalStorage } = require("async_hooks"),
  { performance } = require("perf_hooks"),
  logger = require("./logger");
const storage = new AsyncLocalStorage();
function recordRpc(ms, ok) {
  const s = storage.getStore();
  if (!s) return;
  s.rpcRequests++;
  s.rpcMs += ms;
  if (!ok) s.rpcErrors++;
}
async function phase(name, fn) {
  const s = storage.getStore(),
    start = performance.now();
  try {
    return await fn();
  } finally {
    if (s) s.phases[name] = (s.phases[name] || 0) + performance.now() - start;
  }
}
async function run(taskUuid, kind, fn) {
  const s = {
      taskUuid,
      kind,
      rpcRequests: 0,
      rpcMs: 0,
      rpcErrors: 0,
      phases: {},
      memoryBefore: process.memoryUsage(),
    },
    start = performance.now();
  return storage.run(s, async () => {
    try {
      return await fn();
    } finally {
      logger.info("Execution performance", {
        taskUuid,
        kind,
        elapsedMs: Math.round(performance.now() - start),
        rpcRequests: s.rpcRequests,
        rpcMs: Math.round(s.rpcMs),
        rpcErrors: s.rpcErrors,
        memoryBefore: s.memoryBefore,
        memoryAfter: process.memoryUsage(),
        phaseMs: Object.fromEntries(
          Object.entries(s.phases).map(([k, v]) => [k, Math.round(v)]),
        ),
      });
    }
  });
}
module.exports = { run, phase, recordRpc, active: () => !!storage.getStore() };
