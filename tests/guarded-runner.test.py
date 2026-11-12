import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

RUNNER = Path(__file__).resolve().parents[1] / "scripts/run-guarded.py"

class RunnerTests(unittest.TestCase):
    def invoke(self, folder, command, *flags):
        proof = Path(folder) / "proof.json"
        started = time.monotonic()
        result = subprocess.run([sys.executable,str(RUNNER),"--min-free-tasks","0","--min-free-memory-mb","0","--grace","0.15","--timeout","2","--lock-file",str(Path(folder)/"lock"),"--proof",str(proof),*flags,"--",sys.executable,"-c",command],capture_output=True,text=True,timeout=8)
        return result, json.loads(proof.read_text()), time.monotonic()-started

    def test_success(self):
        with tempfile.TemporaryDirectory() as folder:
            result, proof, _ = self.invoke(folder,"print('ok')")
            self.assertEqual(result.returncode,0)
            self.assertEqual(proof["status"],"passed")
            self.assertEqual(proof["remainingProcesses"],0)

    def test_timeout_kills_detached_child_ignoring_sigterm(self):
        with tempfile.TemporaryDirectory() as folder:
            code="import subprocess,sys,time,signal; subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'],start_new_session=True); signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)"
            result, proof, elapsed = self.invoke(folder,code,"--timeout","0.5")
            self.assertEqual(result.returncode,124)
            self.assertTrue(proof["timedOut"])
            self.assertEqual(proof["remainingProcesses"],0)
            self.assertLess(elapsed,4)

    def test_parent_success_does_not_leave_detached_orphan(self):
        with tempfile.TemporaryDirectory() as folder:
            code="import subprocess,sys;subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True);print('done')"
            result,proof,elapsed=self.invoke(folder,code)
            self.assertEqual(result.returncode,0)
            self.assertEqual(proof["remainingProcesses"],0)
            self.assertLess(elapsed,4)

    def test_capacity_refuses_without_starting_command(self):
        with tempfile.TemporaryDirectory() as folder:
            marker=Path(folder)/"should-not-exist"
            result,proof,_=self.invoke(folder,"from pathlib import Path;Path("+repr(str(marker))+").touch()","--min-free-tasks","1000000000")
            if proof["before"].get("pids.max") is None:
                self.skipTest("No finite cgroup limit")
            self.assertEqual(result.returncode,75)
            self.assertEqual(proof["status"],"insufficient_tasks")
            self.assertFalse(marker.exists())

    def test_memory_gate_refuses_without_starting_command(self):
        with tempfile.TemporaryDirectory() as folder:
            marker=Path(folder)/"memory-marker"
            result,proof,_=self.invoke(folder,"from pathlib import Path;Path("+repr(str(marker))+").touch()","--min-free-memory-mb","1000000000")
            if proof["before"].get("memory.max") is None:
                self.skipTest("No finite memory limit")
            self.assertEqual(result.returncode,75)
            self.assertEqual(proof["status"],"insufficient_memory")
            self.assertFalse(marker.exists())

    def test_interruption_cleans_detached_descendants(self):
        with tempfile.TemporaryDirectory() as folder:
            marker=Path(folder)/"ready"
            proof=Path(folder)/"interrupt-proof.json"
            code="import subprocess,sys,time;from pathlib import Path;subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True);Path("+repr(str(marker))+").touch();time.sleep(60)"
            child=subprocess.Popen([sys.executable,str(RUNNER),"--min-free-tasks","0","--min-free-memory-mb","0","--timeout","5","--grace","0.15","--lock-file",str(Path(folder)/"lock"),"--proof",str(proof),"--",sys.executable,"-c",code],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
            try:
                deadline=time.monotonic()+2
                while not marker.exists() and time.monotonic()<deadline:
                    time.sleep(0.02)
                self.assertTrue(marker.exists())
                child.send_signal(signal.SIGTERM)
                child.communicate(timeout=4)
                self.assertEqual(child.returncode,130)
                data=json.loads(proof.read_text())
                self.assertEqual(data["status"],"interrupted")
                self.assertEqual(data["remainingProcesses"],0)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.communicate(timeout=2)

    def test_second_run_fails_fast_on_same_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            lock=Path(folder)/"lock"
            first=subprocess.Popen([sys.executable,str(RUNNER),"--min-free-tasks","0","--min-free-memory-mb","0","--timeout","2","--grace","0.1","--lock-file",str(lock),"--",sys.executable,"-c","import time;time.sleep(1)"],stdout=subprocess.DEVNULL)
            try:
                time.sleep(0.2)
                result,proof,elapsed=self.invoke(folder,"print('must not start')")
                self.assertEqual(result.returncode,73)
                self.assertEqual(proof["status"],"busy")
                self.assertLess(elapsed,1)
            finally:
                first.wait(timeout=5)

if __name__ == "__main__":
    unittest.main()
