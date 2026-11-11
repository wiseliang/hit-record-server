// Atomic, finished-before-rotation logical backup. Secrets never appear in command arguments.
const fs = require("fs"),
  path = require("path"),
  { spawn } = require("child_process"),
  { pipeline } = require("stream/promises"),
  config = require("../config");
function retained(files, days = 14, extras = 3) {
  const sorted = [...files].sort().reverse(),
    keep = new Set(sorted.slice(0, extras)),
    dates = new Set();
  for (const n of sorted) {
    const d = n.slice(17, 27);
    if (!dates.has(d) && dates.size < days) {
      dates.add(d);
      keep.add(n);
    }
  }
  return keep;
}
async function backup() {
  const dir =
    process.env.BACKUP_DIR || path.resolve(__dirname, "../.data/backups");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(
      dir,
      "student-recorder-" +
        new Date().toISOString().replace(/[:.]/g, "-") +
        ".sql",
    ),
    temp = file + ".partial";
  const child = spawn(
    "mysqldump",
    [
      "--single-transaction",
      "--skip-lock-tables",
      "--no-tablespaces",
      "-h",
      config.db.host,
      "-P",
      String(config.db.port),
      "-u",
      config.db.user,
      config.db.database,
    ],
    {
      env: { ...process.env, MYSQL_PWD: config.db.password },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let error = "";
  child.stderr.on("data", (d) => (error += d));
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            Error(
              "mysqldump failed: " + error.replace(/password/gi, "credential"),
            ),
          ),
    );
  });
  try {
    await Promise.all([
      pipeline(child.stdout, fs.createWriteStream(temp, { mode: 0o600 })),
      completed,
    ]);
    if (fs.statSync(temp).size < 100) throw Error("Backup unexpectedly empty");
    fs.renameSync(temp, file);
    const privateDir =
      process.env.BACKUP_CONFIG_DIR || path.resolve(dir, "../restore-private");
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const semester = process.env.SEMESTER_CONFIG_PATH;
    const capsule = {
      createdAt: new Date().toISOString(),
      AUTH_SECRET: process.env.AUTH_SECRET,
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
      semester:
        semester && fs.existsSync(semester)
          ? JSON.parse(fs.readFileSync(semester, "utf8"))
          : null,
    };
    const capsuleFile = path.join(privateDir, "recovery-config.json");
    fs.writeFileSync(capsuleFile + ".tmp", JSON.stringify(capsule), {
      mode: 0o600,
    });
    fs.renameSync(capsuleFile + ".tmp", capsuleFile);
    fs.chmodSync(capsuleFile, 0o600);
    const files = fs
        .readdirSync(dir)
        .filter((n) => /^student-recorder-.*\.sql$/.test(n)),
      keep = retained(files);
    for (const n of files) if (!keep.has(n)) fs.unlinkSync(path.join(dir, n));
    console.log(file);
    return file;
  } catch (e) {
    child.kill();
    fs.rmSync(temp, { force: true });
    throw e;
  }
}
if (require.main === module)
  backup().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = { backup, retained };
