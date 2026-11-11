const { execFileSync } = require("child_process");
function summarize(lines) {
  const groups = new Map();
  for (const line of lines.split("\n")) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.message !== "Execution performance") continue;
    if (!groups.has(r.kind)) groups.set(r.kind, []);
    groups.get(r.kind).push(r);
  }
  const percentile = (values, p) =>
    [...values].sort((a, b) => a - b)[
      Math.max(0, Math.ceil(values.length * p) - 1)
    ];
  return [...groups].map(([kind, rows]) => ({
    kind,
    samples: rows.length,
    p50Ms: percentile(
      rows.map((r) => r.elapsedMs),
      0.5,
    ),
    p95Ms: percentile(
      rows.map((r) => r.elapsedMs),
      0.95,
    ),
    rpcRequests: rows.reduce((n, r) => n + r.rpcRequests, 0),
    rpcErrors: rows.reduce((n, r) => n + r.rpcErrors, 0),
    latestAt: rows.at(-1).time,
  }));
}
if (require.main === module) {
  try {
    const lines = execFileSync(
      "journalctl",
      [
        "-u",
        process.env.RECORDER_SERVICE || "student-recorder-p4f22.service",
        "--since",
        "7 days ago",
        "--no-pager",
        "-o",
        "cat",
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    console.log(
      JSON.stringify(
        { generatedAt: new Date().toISOString(), groups: summarize(lines) },
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
module.exports = { summarize };
