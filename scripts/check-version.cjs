const assert = require("assert/strict"),
  pkg = require("../package.json"),
  lock = require("../package-lock.json");
assert.equal(pkg.version, lock.version);
assert.equal(pkg.version, lock.packages[""].version);
if (process.argv.includes("--published")) {
  const release = require("../public/releases/release.json");
  assert.equal(release.backendVersions?.studentRecorder || release.version, pkg.version);
  assert.equal(release.status, "ready");
}
console.log("Server version consistency verified");
