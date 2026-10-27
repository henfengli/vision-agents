"""logs 工具读文件日志：整个文件里按正则搜、通配取最新的文件。"""

import os
import tempfile
import time
import unittest

from agent_platform.domain.services import ServiceDef
from agent_platform.services import hostlocal


class ReadLogTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def _write(self, name: str, lines: list[str]) -> str:
        path = os.path.join(self.dir.name, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        return path

    def test_grep_scans_whole_file(self):
        lines = [f"info {i}" for i in range(5000)]
        lines[10] = "ERROR early failure"
        lines[4990] = "Traceback late"
        path = self._write("app.log", lines)
        out = hostlocal.read_log(path, lines=50, grep="error|traceback")
        self.assertIn("整个文件", out)
        self.assertIn("共 2 行", out)
        self.assertIn("ERROR early failure", out)          # 远在最后 50 行之前，也搜得到
        self.assertIn("Traceback late", out)

    def test_grep_keeps_last_matches(self):
        path = self._write("app.log", [f"error {i}" for i in range(30)])
        out = hostlocal.read_log(path, lines=5, grep="error")
        self.assertIn("共 30 行，显示最后 5 行", out)
        self.assertIn("error 29", out)
        self.assertNotIn("error 24\n", out)

    def test_tail_without_grep(self):
        path = self._write("app.log", [f"line {i}" for i in range(100)])
        out = hostlocal.read_log(path, lines=3)
        self.assertTrue(out.rstrip().endswith("line 99"))
        self.assertNotIn("line 96", out)

    def test_glob_picks_newest(self):
        old = self._write("app-2026-10-20.log", ["old"])
        new = self._write("app-2026-10-21.log", ["new"])
        past = time.time() - 3600
        os.utime(old, (past, past))
        out = hostlocal.read_log(os.path.join(self.dir.name, "app-*.log"), lines=10)
        self.assertIn(new, out)
        self.assertIn("new", out.splitlines()[-1])

    def test_missing_and_bad_regex(self):
        self.assertTrue(hostlocal.read_log(os.path.join(self.dir.name, "nope-*.log")).startswith("[不存在]"))
        path = self._write("app.log", ["x"])
        self.assertTrue(hostlocal.read_log(path, grep="(").startswith("[参数]"))

    def test_log_targets_validated(self):
        ServiceDef(logs={"a": "~/x/app-*.log", "b": "docker:web", "c": "journal:nginx"})
        with self.assertRaises(ValueError):
            ServiceDef(logs={"a": "relative.log"})
        with self.assertRaises(ValueError):
            ServiceDef(logs={"a": "journal:"})


if __name__ == "__main__":
    unittest.main()
