"""沙箱命令行：配置与密钥遮蔽、home 白名单、可写的日志空洞、资源 scope、没有 bwrap 时拒绝执行；bash 的输出截取。"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent_platform.agent.tools import sandbox
from agent_platform.agent.tools.sandbox import mask_args
from agent_platform.config import LimitsConfig


class SandboxTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.file, self.dir = root / "prod.env", root / "secrets"
        self.file.write_text("PW=1")
        self.dir.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_mask_args(self):
        args = mask_args([str(self.file), str(self.dir), str(self.file) + ".missing"])
        self.assertEqual(len(args), 5)
        i = args.index(str(self.file))
        self.assertEqual(args[i - 2:i], ["--ro-bind", "/dev/null"])
        self.assertEqual(args[args.index(str(self.dir)) - 1], "--tmpfs")

    def test_agent_sandbox_masks_before_scratch_and_keeps_network(self):
        with mock.patch.object(sandbox, "has_bwrap", return_value=True):
            argv = sandbox.wrap_argv(["bash", "-c", "cat x"], "/data/scratch", hidden=(str(self.file),))
        self.assertLess(argv.index(str(self.file)), argv.index("/data/scratch"))
        self.assertNotIn("--unshare-net", argv)                      # 网络不限
        self.assertIn("--unshare-ipc", argv)
        self.assertIn("--as-pid-1", argv)
        self.assertEqual(argv[-3:], ["bash", "-c", "cat x"])

    def test_home_itself_is_never_rebound(self):
        home = os.path.expanduser("~")
        argv = sandbox.bwrap_argv(["true"], scratch="/s", allow=[home, os.path.dirname(home)])
        self.assertNotIn(["--ro-bind", home, home], [argv[i:i + 3] for i in range(len(argv))])

    def test_sinks_are_writable_dev_null(self):
        argv = sandbox.bwrap_argv(["true"], scratch="/s", sinks=[str(self.file), str(self.dir)])
        i = argv.index(str(self.file))
        self.assertEqual(argv[i - 2:i], ["--bind", "/dev/null"])
        self.assertNotIn(str(self.dir), argv)                        # 只对文件

    def test_bash_output_is_bounded(self):
        import subprocess
        import sys

        from agent_platform.agent.tools import bash
        code = "import sys; sys.stdout.write('S' + 'a' * 3000000); sys.stdout.flush(); sys.stderr.write('ERR')"
        proc = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        cap = bash._Capture(proc.stdout)
        proc.wait(30)
        out, truncated = cap.text()
        self.assertTrue(truncated)
        self.assertEqual(cap.total, 3000004)
        self.assertLessEqual(len(cap.head) + len(cap.tail), 2 * bash._KEEP_BYTES)   # 只留首尾，不整份进内存
        self.assertTrue(out.startswith("S") and out.endswith("ERR"))
        self.assertLess(len(out), bash.MAX_OUTPUT_CHARS + 100)

    def test_home_is_hidden_except_allowed_dirs(self):
        home = os.path.expanduser("~")
        code = os.path.join(home, ".vision-agents-test-code")
        os.makedirs(code, exist_ok=True)
        try:
            argv = sandbox.bwrap_argv(["true"], scratch="/data/scratch", allow=[code], hidden=[os.path.join(home, ".ssh")])
        finally:
            os.rmdir(code)
        self.assertEqual(argv[argv.index("--tmpfs") + 1], home)
        i = argv.index(code)
        self.assertEqual(argv[i - 1], "--ro-bind")
        self.assertLess(argv.index(home), i)                       # 先清空 home，再挂回代码目录
        self.assertNotIn(os.path.join(home, ".ssh"), argv)         # home 下没挂回的不用再单独遮

    def test_binds_come_after_masks(self):
        argv = sandbox.bwrap_argv(["true"], scratch="/s", hidden=[str(self.file)], binds=[("/agent/conf", str(self.file))])
        self.assertLess(argv.index("/dev/null"), argv.index("/agent/conf"))

    def test_limits_wrap_in_user_scope(self):
        argv = sandbox.limit_argv(["bwrap", "x"], LimitsConfig(enabled=True), memory="32G")
        self.assertEqual(argv[:3], ["systemd-run", "--user", "--scope"])
        self.assertIn("MemoryMax=32G", argv)
        self.assertFalse([a for a in argv if a.startswith("CPU")])        # 只限内存，CPU 不限
        self.assertEqual(argv[-2:], ["bwrap", "x"])
        self.assertEqual(sandbox.limit_argv(["x"], LimitsConfig(enabled=False), memory="1G"), ["x"])

    def test_no_bwrap_refuses_when_required(self):
        with mock.patch.object(sandbox, "has_bwrap", return_value=False):
            with self.assertRaises(sandbox.SandboxUnavailable):
                sandbox.wrap_argv(["bash"], "/s")
            self.assertEqual(sandbox.wrap_argv(["bash"], "/s", require=False), ["bash"])


if __name__ == "__main__":
    unittest.main()
