const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path"),
  os = require("os"),
  crypto = require("crypto"),
  { finalize } = require("../scripts/finalize-release.cjs");
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-cleanup-")),
    publicDir = path.join(root, "public"),
    downloadDir = path.join(root, ".runtime/public-downloads");
  for (const dir of [
    publicDir,
    downloadDir,
    path.join(root, "outbox"),
    path.join(root, "inbox"),
    path.join(root, ".runtime/backups"),
  ])
    fs.mkdirSync(dir, { recursive: true });
  const file = "student-recorder-v1.5.0.apk",
    latest = path.join(downloadDir, file);
  fs.writeFileSync(latest, "new");
  const sha256 = crypto.createHash("sha256").update("new").digest("hex"),
    manifest = {
      file,
      version: "1.5.0",
      versionCode: 9,
      status: "ready",
      sha256,
      bytes: 3,
    };
  fs.writeFileSync(
    path.join(publicDir, "release.json"),
    JSON.stringify(manifest),
  );
  const proof = {
    passed: true,
    latestFullDownloadMatches: true,
    version: "1.5.0",
    sha256,
    bytes: 3,
    health: { version: "1.5.0", database: "ok" },
    releaseUrl: "https://wiseliang.cloud/student-recorder/releases/",
  };
  return {
    root,
    publicDir,
    downloadDir,
    proof,
    inspect: (p) => ({
      package: p.includes("foreign")
        ? "other.app"
        : "com.wiseliang.studentrecorder",
      version: fs.readFileSync(p, "utf8") === "new" ? "1.5.0" : "1.4.3",
      versionCode: fs.readFileSync(p, "utf8") === "new" ? 9 : 8,
    }),
  };
}
test("publication failure or mismatched public proof never removes old packages", () => {
  const f = fixture(),
    old = path.join(f.downloadDir, "student-recorder-v1.4.3.apk");
  fs.writeFileSync(old, "old");
  try {
    assert.throws(() =>
      finalize({ ...f, proof: { ...f.proof, passed: false }, apply: true }),
    );
    assert(fs.existsSync(old));
    assert.throws(() =>
      finalize({ ...f, proof: { ...f.proof, sha256: "bad" }, apply: true }),
    );
    assert(fs.existsSync(old));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test("dry run preserves files, confirmed cleanup keeps latest and excludes uploads, backups and foreign packages", () => {
  const f = fixture(),
    old = path.join(f.downloadDir, "student-recorder-v1.4.3.apk"),
    copy = path.join(f.root, "outbox/old.apk");
  fs.writeFileSync(old, "old");
  fs.linkSync(old, copy);
  for (const name of [
    "inbox/upload.apk",
    ".runtime/backups/backup.apk",
    "outbox/foreign.apk",
  ])
    fs.writeFileSync(path.join(f.root, name), "old");
  try {
    const dry = finalize(f);
    assert.equal(dry.wouldRemove.length, 2);
    assert(fs.existsSync(old));
    const done = finalize({ ...f, apply: true });
    assert.equal(done.removed.length, 2);
    assert(done.estimatedReclaimedAllocatedBytes > 0);
    assert(!fs.existsSync(copy));
    assert(
      fs.existsSync(path.join(f.downloadDir, "student-recorder-v1.5.0.apk")),
    );
    for (const name of [
      "inbox/upload.apk",
      ".runtime/backups/backup.apk",
      "outbox/foreign.apk",
    ])
      assert(fs.existsSync(path.join(f.root, name)));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test("cleanup cannot follow directory symlinks or remove an unrecognized package", () => {
  const f = fixture(),
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-release-")),
    old = path.join(outside, "old.apk");
  fs.writeFileSync(old, "old");
  fs.symlinkSync(outside, path.join(f.root, "outbox/link"));
  fs.writeFileSync(path.join(f.root, "outbox/unknown.apk"), "unknown");
  try {
    const result = finalize({
      ...f,
      apply: true,
      inspect: (p, ...args) =>
        p.endsWith("unknown.apk") ? null : f.inspect(p, ...args),
    });
    assert.equal(result.removed.length, 0);
    assert(fs.existsSync(old));
    assert(fs.existsSync(path.join(f.root, "outbox/unknown.apk")));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
test("top-level artifact directories must not redirect cleanup into another project", () => {
  const f = fixture(),
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-artifacts-")),
    old = path.join(outside, "old.apk");
  fs.writeFileSync(old, "old");
  fs.rmdirSync(path.join(f.root, "outbox"));
  fs.symlinkSync(outside, path.join(f.root, "outbox"));
  try {
    const result = finalize({ ...f, apply: true });
    assert.equal(result.removed.length, 0);
    assert(fs.existsSync(old));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
