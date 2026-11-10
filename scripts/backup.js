// Project-only logical backup. No passwords are put in shell arguments.
const fs = require("fs"),
  path = require("path"),
  { spawn } = require("child_process"),
  config = require("../config");
const directory =
  process.env.BACKUP_DIR || path.resolve(__dirname, "../.data/backups");
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = path.join(
  directory,
  "student-recorder-" + new Date().toISOString().replace(/[:.]/g, "-") + ".sql",
);
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
const output = fs.createWriteStream(file, { mode: 0o600 });
child.stdout.pipe(output);
let error = "";
child.stderr.on("data", (d) => (error += d));
child.on("error", (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
child.on("close", (code) => {
  if (code) {
    try {
      fs.unlinkSync(file);
    } catch {}
    console.error("Backup failed:", error.replace(/password/gi, "credential"));
    process.exitCode = 1;
  } else {
    console.log(file);
    const all = fs
      .readdirSync(directory)
      .filter((n) => n.endsWith(".sql"))
      .sort();
    for (const old of all.slice(0, -14))
      fs.unlinkSync(path.join(directory, old));
  }
});
