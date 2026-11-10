// Run only AFTER public release verification. Never clean old files while publishing a candidate.
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto"),
  { execFileSync } = require("child_process");
const sha = (p) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const inside = (root, p) => p === root || p.startsWith(root + path.sep);
function inspectApk(file, root) {
  let target = file,
    temp;
  try {
    if (file.endsWith(".zip")) {
      temp = fs.mkdtempSync(path.join(root, ".runtime/apk-inspect-"));
      target = path.join(temp, "package.apk");
      execFileSync(
        "python3",
        [
          "-c",
          "import zipfile,sys,pathlib\nz=zipfile.ZipFile(sys.argv[1]);f=[i for i in z.infolist() if not i.is_dir()];assert len(f)==1 and f[0].filename.endswith('.apk') and f[0].file_size<250*1024*1024;pathlib.Path(sys.argv[2]).write_bytes(z.read(f[0]))",
          file,
          target,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    }
    const text = execFileSync("aapt", ["dump", "badging", target], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      }),
      m = text.match(
        /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/,
      );
    return m
      ? { package: m[1], versionCode: Number(m[2]), version: m[3] }
      : null;
  } catch {
    return null;
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
}
function finalize({
  root,
  publicDir,
  downloadDir,
  proof,
  apply = false,
  inspect = inspectApk,
}) {
  root = fs.realpathSync(root);
  publicDir = fs.realpathSync(publicDir);
  downloadDir = fs.realpathSync(downloadDir);
  if (!inside(root, publicDir) || !inside(root, downloadDir))
    throw Error("Release directories must belong to this project");
  const manifest = JSON.parse(
      fs.readFileSync(path.join(publicDir, "release.json"), "utf8"),
    ),
    latest = path.join(downloadDir, manifest.file);
  if (
    !/^student-recorder-v\d+\.\d+\.\d+\.apk$/.test(manifest.file) ||
    manifest.status !== "ready" ||
    proof.passed !== true ||
    !proof.latestFullDownloadMatches ||
    proof.version !== manifest.version ||
    proof.sha256 !== manifest.sha256 ||
    proof.bytes !== manifest.bytes ||
    proof.health?.version !== manifest.version ||
    proof.health?.database !== "ok" ||
    proof.releaseUrl !== "https://wiseliang.cloud/student-recorder/releases/"
  )
    throw Error(
      "Public verification must match the currently published release",
    );
  if (fs.lstatSync(latest).isSymbolicLink() || sha(latest) !== manifest.sha256)
    throw Error("Current APK checksum differs from verified public release");
  const current = inspect(latest, root);
  if (
    !current ||
    current.package !== "com.wiseliang.studentrecorder" ||
    current.version !== manifest.version ||
    current.versionCode !== manifest.versionCode
  )
    throw Error("Current APK identity is not verified");
  const files = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const directoryStat = fs.lstatSync(dir);
    if (
      directoryStat.isSymbolicLink() ||
      !directoryStat.isDirectory() ||
      !inside(root, fs.realpathSync(dir))
    )
      return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const name = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (
          !["android-sdk", "node_modules", ".git", "backups"].includes(e.name)
        )
          walk(name);
      } else if (
        e.isFile() &&
        (e.name.endsWith(".apk") ||
          (e.name.endsWith(".zip") && /apk|artifact/i.test(e.name)))
      )
        files.push(name);
    }
  }
  for (const dir of [".runtime", ".build-tools", "outbox"])
    walk(path.join(root, dir));
  const result = {
    version: manifest.version,
    applied: apply,
    removed: [],
    wouldRemove: [],
    skippedUnverified: [],
    estimatedReclaimedAllocatedBytes: 0,
  };
  for (const file of files) {
    if (path.resolve(file) === path.resolve(latest)) continue;
    const before = fs.lstatSync(file),
      old = inspect(file, root);
    if (!old) {
      result.skippedUnverified.push(path.relative(root, file));
      continue;
    }
    if (
      old.package !== current.package ||
      old.versionCode >= current.versionCode
    )
      continue;
    const now = fs.lstatSync(file);
    if (
      !now.isFile() ||
      now.isSymbolicLink() ||
      now.size !== before.size ||
      now.mtimeMs !== before.mtimeMs
    )
      throw Error("Artifact changed during verification; cleanup stopped");
    const entry = {
      file: path.relative(root, file),
      version: old.version,
      versionCode: old.versionCode,
    };
    result.wouldRemove.push(entry);
    if (apply) {
      fs.unlinkSync(file);
      result.removed.push(entry);
      if (now.nlink === 1)
        result.estimatedReclaimedAllocatedBytes += now.blocks * 512;
    }
  }
  if (!fs.existsSync(latest) || sha(latest) !== manifest.sha256)
    throw Error("Current APK must remain available");
  return result;
}
if (require.main === module) {
  try {
    const [proofPath, ...flags] = process.argv.slice(2),
      root = path.resolve(
        process.env.RELEASE_ARTIFACT_ROOT ||
          path.resolve(__dirname, "../../.."),
      ),
      publicDir = path.resolve(__dirname, "../public/releases"),
      downloadDir =
        process.env.RELEASE_DOWNLOAD_DIR ||
        path.resolve(__dirname, "../.data/public-downloads");
    if (!proofPath)
      throw Error(
        "Usage: node scripts/finalize-release.cjs verified-public-proof.json [--apply]",
      );
    const result = finalize({
      root,
      publicDir,
      downloadDir,
      proof: JSON.parse(fs.readFileSync(proofPath, "utf8")),
      apply: flags.includes("--apply"),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
module.exports = { finalize, inspectApk };
