"""bash 工具纯逻辑测试：截断、危险识别、环境白名单、真实命令执行。"""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from agent_platform.tools.bash import (build_safe_env, is_dangerous, run_command,
                                       truncate)

DANGER = [r"\brm\s+-[rf]", r"\bdrop\b", r"\btruncate\b", r"\bkill\b", r"\bsystemctl\b"]


class TestTruncate(unittest.TestCase):
    def test_short_text_untouched(self):
        text, truncated = truncate("hello", 100)
        self.assertEqual((text, truncated), ("hello", False))

    def test_long_text_truncated_with_head_and_tail(self):
        text, truncated = truncate("x" * 10000, 1000)
        self.assertTrue(truncated)
        self.assertLess(len(text), 1200)
        self.assertTrue(text.startswith("x" * 100))
        self.assertIn("截断", text)


class TestDangerDetection(unittest.TestCase):
    def test_dangerous_commands(self):
        for cmd in ["rm -rf /tmp/x", "DROP TABLE t", "kill -9 1",
                    "systemctl restart board"]:
            self.assertTrue(is_dangerous(cmd, DANGER), cmd)

    def test_safe_commands(self):
        for cmd in ["psql -c 'select 1'", "grep -r total_fee /srv/board",
                    "tail -200 app.log", "git log --oneline"]:
            self.assertFalse(is_dangerous(cmd, DANGER), cmd)


class TestSafeEnv(unittest.TestCase):
    def test_secrets_never_leak(self):
        os.environ["AGENT_DB_PASSWORD"] = "supersecret"
        os.environ["MODEL_TOKEN_A"] = "tok"
        env = build_safe_env()
        self.assertNotIn("AGENT_DB_PASSWORD", env)
        self.assertNotIn("MODEL_TOKEN_A", env)
        self.assertIn("PATH", env)


class TestRunCommand(unittest.TestCase):
    def test_echo(self):
        r = run_command("echo hello", timeout=5)
        self.assertEqual(r.exit_code, 0)
        self.assertIn("hello", r.output)

    def test_timeout_becomes_exit_124(self):
        r = run_command("sleep 10", timeout=1)
        self.assertEqual(r.exit_code, 124)
        self.assertIn("超时", r.output)


if __name__ == "__main__":
    unittest.main()
