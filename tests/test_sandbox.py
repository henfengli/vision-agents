"""沙箱命令行：配置与密钥遮蔽、业务进程的 pid 命名空间。"""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent_platform.agent.tools import sandbox
from agent_platform.services.svcrun import build_argv, mask_args


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

    def test_agent_sandbox_masks_before_scratch_and_cuts_network(self):
        with mock.patch.object(sandbox, "has_bwrap", return_value=True):
            argv = sandbox.wrap_argv(["bash", "-c", "cat x"], "/data/scratch", hidden=(str(self.file),))
        self.assertLess(argv.index(str(self.file)), argv.index("/data/scratch"))
        self.assertIn("--unshare-net", argv)
        self.assertEqual(argv[-3:], ["bash", "-c", "cat x"])

    def test_service_process_gets_own_pid_namespace_and_binds_win(self):
        argv = build_argv({"service": "b", "env": "test", "argv": ["node", "server.js"], "port": 8081,
                           "binds": [["/conf/test/.env", "/code/test/.env"]], "masks": [str(self.file)]})
        self.assertIn("--unshare-pid", argv)
        self.assertLess(argv.index(str(self.file)), argv.index("/conf/test/.env"))
        self.assertEqual(argv[argv.index("SVC_ENV") + 1], "test")
        self.assertEqual(argv[-3:], ["--", "node", "server.js"])


if __name__ == "__main__":
    unittest.main()
