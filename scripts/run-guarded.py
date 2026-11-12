#!/usr/bin/env python3
"""Run validation with an exclusive lock, resource checks and process-tree deadline."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

def budget():
    result = {}
    try:
        line = next(x for x in Path("/proc/self/cgroup").read_text().splitlines() if x.startswith("0::"))
        root = Path("/sys/fs/cgroup") / line.split("::", 1)[1].lstrip("/")
        for key in ("pids.current", "pids.max", "memory.current", "memory.max"):
            try:
                raw = (root / key).read_text().strip()
                result[key] = None if raw == "max" else int(raw)
            except (OSError, ValueError):
                pass
        for key in ("pids.events", "memory.events"):
            try:
                result[key] = {a: int(b) for a, b in (x.split() for x in (root / key).read_text().splitlines())}
            except (OSError, ValueError):
                pass
    except (OSError, StopIteration):
        pass
    return result

def process_table():
    rows = {}
    for p in Path("/proc").iterdir():
        if not p.name.isdigit():
            continue
        try:
            fields = (p / "stat").read_text().rsplit(")", 1)[1].split()
            rows[int(p.name)] = (int(fields[1]), fields[19], fields[0])
        except (OSError, ValueError, IndexError):
            pass
    return rows

class OwnedTree:
    """Subreaper adoption keeps detached Chromium descendants attributable."""
    def __init__(self):
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        self.subreaper = libc.prctl(36, 1, 0, 0, 0) == 0
        self.identities = {}
        self.peak = 0

    def scan(self):
        rows = process_table()
        owned = {pid for pid, birth in self.identities.items() if pid in rows and rows[pid][1] == birth}
        owned.update(pid for pid, info in rows.items() if info[0] == os.getpid())
        while True:
            descendants = {pid for pid, info in rows.items() if info[0] in owned}
            if descendants.issubset(owned):
                break
            owned.update(descendants)
        for pid in owned:
            self.identities[pid] = rows[pid][1]
        live = [pid for pid in owned if rows[pid][2] != "Z"]
        self.peak = max(self.peak, len(live))
        return live

    def reap(self):
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    break
            except ChildProcessError:
                break

    def stop(self, child, grace):
        # Only descendants observed by this supervisor are signalled.
        for sig, duration in ((signal.SIGTERM, grace), (signal.SIGKILL, 2)):
            deadline = time.monotonic() + duration
            while True:
                child.poll()
                live = self.scan()
                for pid in live:
                    try:
                        # Revalidate birth time to protect against PID reuse.
                        row = process_table().get(pid)
                        if row and row[1] == self.identities[pid]:
                            os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
                child.poll()
                self.reap()
                if not self.scan() or time.monotonic() >= deadline:
                    break
                time.sleep(0.05)
        child.poll()
        self.reap()
        return len(self.scan())

def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".partial")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
    os.replace(temp, path)

def run(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--grace", type=float, default=2)
    parser.add_argument("--heartbeat", type=float, default=15)
    parser.add_argument("--min-free-tasks", type=int, default=128)
    parser.add_argument("--min-free-memory-mb", type=int, default=384)
    parser.add_argument("--label", default="validation")
    parser.add_argument("--lock-file")
    parser.add_argument("--log")
    parser.add_argument("--proof")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args(argv)
    command = options.command
    if command and command[0] == "--":
        command = command[1:]
    if not command or options.timeout <= 0 or options.grace < 0:
        parser.error("a command and a positive timeout are required")
    key = hashlib.sha256(str(Path.cwd().resolve()).encode()).hexdigest()[:16]
    lock_path = Path(options.lock_file or os.environ.get("RECORDER_VALIDATION_LOCK") or (Path(tempfile.gettempdir()) / ("recorder-validation-" + key + ".lock")))
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock = os.fdopen(os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600), "r+")
    before = budget()
    proof = {"label": options.label, "status": "starting", "before": before, "timedOut": False}
    child = None
    tree = OwnedTree()
    proof["subreaper"] = tree.subreaper
    log = None
    started = time.monotonic()
    peak_tasks = before.get("pids.current", 0)
    def interrupt(signum, _frame):
        raise KeyboardInterrupt
    previous = {s: signal.signal(s, interrupt) for s in (signal.SIGTERM, signal.SIGINT)}
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            proof["status"] = "busy"
            print("Another validation owns the lock; no new process was started.", flush=True)
            return 73
        limited = before.get("pids.max")
        memory = before.get("memory.max")
        if limited is not None and limited - before.get("pids.current", 0) < options.min_free_tasks:
            proof["status"] = "insufficient_tasks"
            print("Not enough process/thread capacity; retry after the current task completes.", flush=True)
            return 75
        if memory is not None and memory - before.get("memory.current", 0) < options.min_free_memory_mb * 1024**2:
            proof["status"] = "insufficient_memory"
            print("Not enough memory capacity; no validation process was started.", flush=True)
            return 75
        if options.log:
            path = Path(options.log)
            path.parent.mkdir(parents=True, exist_ok=True)
            log = os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb")
        if not tree.subreaper:
            proof["status"] = "unsupported_cleanup"
            print("Linux subreaper unavailable; refusing an uncontained validation.", flush=True)
            return 75
        # No PIPE: an orphan grandchild cannot keep a pipe open and trap the parent.
        child_env = {**os.environ, "RECORDER_GUARDED": "1", "RECORDER_VALIDATION_LOCK": str(lock_path.resolve())}
        child = subprocess.Popen(command, start_new_session=True, env=child_env, stdout=log, stderr=subprocess.STDOUT if log else None)
        proof["processGroup"] = child.pid
        proof["status"] = "running"
        print(options.label + ": started with an exclusive lock and hard deadline.", flush=True)
        next_heartbeat = started + options.heartbeat
        code = 1
        while child.poll() is None:
            now = time.monotonic()
            tree.scan()
            sample = budget()
            peak_tasks = max(peak_tasks, sample.get("pids.current", 0))
            if now - started >= options.timeout:
                proof["status"] = "timeout"
                proof["timedOut"] = True
                code = 124
                break
            if now >= next_heartbeat:
                print(options.label + ": running %.0fs; tasks %s/%s." % (now-started, sample.get("pids.current","?"), sample.get("pids.max","unlimited")), flush=True)
                next_heartbeat = now + options.heartbeat
            time.sleep(0.1)
        if child.poll() is not None and not proof["timedOut"]:
            code = child.returncode
            proof["status"] = "passed" if code == 0 else "failed"
        return code
    except KeyboardInterrupt:
        proof["status"] = "interrupted"
        return 130
    except OSError as error:
        proof["status"] = "spawn_failed"
        proof["errno"] = error.errno
        print(options.label + ": unable to start validation; errno %s." % error.errno, flush=True)
        return 75
    finally:
        if child:
            proof["remainingProcesses"] = tree.stop(child, options.grace)
            proof["peakChildProcesses"] = tree.peak
        if log:
            log.close()
        proof["elapsedSeconds"] = round(time.monotonic() - started, 2)
        proof["peakTasksObserved"] = peak_tasks
        proof["after"] = budget()
        if options.proof:
            atomic_json(options.proof, proof)
        print(options.label + ": " + proof["status"] + " (%.2fs)." % proof["elapsedSeconds"], flush=True)
        for s, handler in previous.items():
            signal.signal(s, handler)
        lock.close()
        if proof.get("remainingProcesses", 0):
            raise SystemExit(76)

if __name__ == "__main__":
    sys.exit(run())
