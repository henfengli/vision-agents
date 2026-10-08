"""工具层测试：沙箱包装 / run_code 编排（RPC 桩）/ sql 只读校验 / 审查层。"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))


class TestSandbox(unittest.TestCase):
    def test_wrap_fallback_when_no_bwrap(self):
        from agent_platform.tools import sandbox
        sandbox._HAS_BWRAP = False
        argv = sandbox.wrap_argv(["echo", "hi"], "/tmp")
        self.assertEqual(argv, ["echo", "hi"])

    def test_wrap_with_bwrap(self):
        from agent_platform.tools import sandbox
        sandbox._HAS_BWRAP = True
        argv = sandbox.wrap_argv(["echo", "hi"], "/scratch")
        self.assertEqual(argv[0], "bwrap")
        self.assertIn("--unshare-net", argv)
        joined = " ".join(argv)
        self.assertIn("--bind /scratch /scratch", joined)
        self.assertEqual(argv[-2:], ["echo", "hi"])

    def test_allow_net(self):
        from agent_platform.tools import sandbox
        sandbox._HAS_BWRAP = True
        argv = sandbox.wrap_argv(["echo"], "/scratch", allow_net=True)
        self.assertNotIn("--unshare-net", argv)
        sandbox._HAS_BWRAP = None


class TestRunCode(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.mkdtemp()
        from agent_platform.tools import sandbox
        sandbox._HAS_BWRAP = False  # 测试环境无 bwrap，走退化路径

    def _run(self, code, tools=None, timeout=30):
        from agent_platform.tools.run_code import execute_code
        return asyncio.run(execute_code(code, tools or {}, self.scratch,
                                        timeout=timeout))

    def test_print_only(self):
        out = self._run("print('hello')")
        self.assertIn("hello", out)

    def test_stub_rpc_call(self):
        async def echo(text: str) -> str:
            return f"echo:{text}"

        out = self._run("r = echo('abc')\nprint(r)", {"echo": echo})
        self.assertIn("echo:abc", out)
        self.assertIn("工具调用 1 次", out)

    def test_stub_error_propagates(self):
        async def boom() -> str:
            raise RuntimeError("炸了")

        out = self._run(
            "try:\n    boom()\nexcept Exception as e:\n    print('捕获:', e)",
            {"boom": boom})
        self.assertIn("捕获", out)
        self.assertIn("炸了", out)

    def test_unknown_tool(self):
        out = self._run(
            "try:\n    nope()\nexcept Exception as e:\n    print('err', e)",
            {})
        # 桩不存在 → NameError（未声明的工具根本没注入）
        self.assertIn("err", out)

    def test_timeout(self):
        out = self._run("import time\ntime.sleep(30)", timeout=2)
        self.assertIn("超时", out)

    def test_intermediate_data_stays_local(self):
        """中间数据不进上下文：大列表在沙箱内处理，只 print 摘要。"""
        out = self._run(
            "data = list(range(100000))\nprint('sum =', sum(data))")
        self.assertIn("sum = 4999950000", out)
        self.assertNotIn("99999", out.split("sum =")[0])


class TestSqlGuard(unittest.TestCase):
    def test_allow_readonly(self):
        from agent_platform.tools.sql import validate_query
        for ok in ["select * from t", "WITH x AS (SELECT 1) SELECT * FROM x",
                   "explain select 1", "  SELECT a FROM t LIMIT 10;"]:
            self.assertIsNone(validate_query(ok), ok)

    def test_reject_writes_and_multi(self):
        from agent_platform.tools.sql import validate_query
        for bad in ["insert into t values (1)", "select 1; drop table t",
                    "DELETE FROM t", "update t set a=1", "select 1; select 2"]:
            self.assertIsNotNone(validate_query(bad), bad)


class TestReviewLayer(unittest.TestCase):
    def test_review_blocks_bash(self):
        from agent_platform.tools import ToolRegistry

        def review(command: str) -> None:
            if "rm -rf" in command:
                raise PermissionError("危险命令需审批")

        reg = ToolRegistry(tempfile.mkdtemp(), review=review)
        tools = reg.host_tools(["bash"])
        with self.assertRaises(PermissionError):
            asyncio.run(tools["bash"]("rm -rf /x"))
        # 安全命令放行（退化路径真实执行）
        out = asyncio.run(tools["bash"]("echo safe"))
        self.assertIn("safe", out)


if __name__ == "__main__":
    unittest.main()
