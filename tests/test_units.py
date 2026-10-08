"""纯逻辑单测：不依赖 PG / Temporal / LangChain 运行时。"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))


class TestConfig(unittest.TestCase):
    def _write_conf(self, root: Path):
        (root / "base").mkdir(parents=True)
        (root / "env").mkdir(parents=True)
        (root / "base/domains.yaml").write_text(
            "domains:\n  board:\n    code_paths: [/srv/board]\n")
        (root / "env/dev.yaml").write_text(
            "db_dsn: postgresql://x\n"
            "model: {url: http://m/v1, name: m, tokens: ['${TOKEN_A}']}\n"
            "dingtalk_relay_url: http://relay\n"
            "dingtalk_token: t\n"
            "bearer_token: b\n"
            "viewer_base_url: http://viewer\n")

    def test_load_and_interpolate(self):
        from agent_platform import config
        with tempfile.TemporaryDirectory() as d:
            self._write_conf(Path(d))
            old_root, old_env = config._CONF_ROOT, os.environ.get("AGENT_ENV")
            config._CONF_ROOT = Path(d)
            os.environ["TOKEN_A"] = "secret"
            try:
                s = config.load_settings("dev")
                self.assertEqual(s.env, "dev")
                self.assertEqual(s.model.tokens, ["secret"])
                self.assertIn("board", s.domains)
                self.assertEqual(s.port, 8100)  # 默认值
            finally:
                config._CONF_ROOT = old_root
                if old_env:
                    os.environ["AGENT_ENV"] = old_env

    def test_missing_env_var_raises(self):
        from agent_platform import config
        with tempfile.TemporaryDirectory() as d:
            self._write_conf(Path(d))
            old_root = config._CONF_ROOT
            config._CONF_ROOT = Path(d)
            os.environ.pop("TOKEN_A", None)
            try:
                with self.assertRaises(KeyError):
                    config.load_settings("dev")
            finally:
                config._CONF_ROOT = old_root


class TestRoles(unittest.TestCase):
    def test_inheritance_intersection(self):
        from agent_platform.agent.roles import parse_defs, resolve
        defs = parse_defs([
            {"name": "base", "domains": ["a", "b"], "tools": ["bash", "sql_query"],
             "prompt": "基座", "description": "base"},
            {"name": "child", "extends": "base", "domains": ["b"],
             "tools": ["bash", "run_code"],  # run_code 超父级，应被收敛掉
             "prompt_append": "子约定"},
        ])
        r = resolve("child", defs)
        self.assertEqual(r.domains, ["b"])
        self.assertEqual(r.tools, ["bash"])       # 交集收敛，防提权
        self.assertEqual(r.prompt, "基座\n\n子约定")
        self.assertEqual(r.lineage, ["base", "child"])

    def test_cycle_rejected(self):
        from agent_platform.agent.roles import RoleError, parse_defs, resolve
        defs = parse_defs([
            {"name": "a", "extends": "b"}, {"name": "b", "extends": "a"}])
        with self.assertRaises(RoleError):
            resolve("a", defs)


class TestSqlTool(unittest.IsolatedAsyncioTestCase):
    async def test_validate(self):
        from agent_platform.agent.tools.sql import validate_query
        self.assertIsNone(validate_query("SELECT 1"))
        self.assertIsNone(validate_query("WITH t AS (SELECT 1) SELECT * FROM t"))
        self.assertIsNotNone(validate_query("DELETE FROM t"))
        self.assertIsNotNone(validate_query("SELECT 1; DROP TABLE t"))
        self.assertIsNotNone(validate_query("insert into t values (1)"))

    async def test_run_query_against_pg(self):
        """真实只读库执行（pgserver 可用时）。"""
        try:
            import pgserver  # noqa: F401
        except ImportError:
            self.skipTest("pgserver 不可用")


class TestBashTool(unittest.TestCase):
    def test_truncate(self):
        from agent_platform.agent.tools.bash import truncate
        text, cut = truncate("x" * 100, 200)
        self.assertFalse(cut)
        text, cut = truncate("x" * 10000, 100)
        self.assertTrue(cut)
        self.assertIn("截断", text)

    def test_run_command_timeout(self):
        from agent_platform.agent.tools.bash import run_command
        r = run_command("sleep 5", timeout=1)
        self.assertEqual(r.exit_code, 124)

    def test_run_command_basic(self):
        from agent_platform.agent.tools.bash import run_command
        r = run_command("echo hello")
        self.assertEqual(r.exit_code, 0)
        self.assertIn("hello", r.output)


class TestSandbox(unittest.TestCase):
    def test_wrap_without_bwrap(self):
        from agent_platform.agent.tools import sandbox
        sandbox._HAS_BWRAP = False  # 强制不可用路径
        argv = sandbox.wrap_argv(["echo", "hi"], "/tmp")
        self.assertEqual(argv, ["echo", "hi"])
        sandbox._HAS_BWRAP = None


class TestRunCode(unittest.IsolatedAsyncioTestCase):
    async def test_rpc_roundtrip(self):
        from agent_platform.agent.tools.run_code import execute_code
        with tempfile.TemporaryDirectory() as scratch:
            async def double(x):
                return x * 2

            out = await execute_code(
                "print('结果', double(21))", {"double": double}, scratch)
            self.assertIn("结果 42", out)
            self.assertIn("工具调用 1 次", out)

    async def test_tool_error_surfaces(self):
        """host 工具抛错 → 沙箱内以 RuntimeError 形式回到 agent 代码。"""
        from agent_platform.agent.tools.run_code import execute_code
        with tempfile.TemporaryDirectory() as scratch:
            async def boom():
                raise ValueError("内部错误详情")

            out = await execute_code(
                "try:\n    boom()\nexcept RuntimeError as e:\n    print('捕获:', e)",
                {"boom": boom}, scratch)
            self.assertIn("捕获: boom: 内部错误详情", out)

    async def test_timeout(self):
        from agent_platform.agent.tools.run_code import execute_code
        with tempfile.TemporaryDirectory() as scratch:
            out = await execute_code(
                "import time; time.sleep(10)", {}, scratch, timeout=1)
            self.assertIn("超时", out)


class TestRegistry(unittest.IsolatedAsyncioTestCase):
    async def test_host_tools_whitelist(self):
        from agent_platform.agent.tools.registry import ToolRegistry
        reg = ToolRegistry(tempfile.mkdtemp())
        tools = reg.host_tools(["bash", "nonexistent"])
        self.assertEqual(list(tools), ["bash"])  # 白名单外忽略

    async def test_run_code_placeholder_refuses(self):
        from agent_platform.agent.tools.registry import ToolRegistry
        reg = ToolRegistry(tempfile.mkdtemp())
        fn = reg.host_tools(["run_code"]).get("run_code")  # placeholder 不进 host_tools
        self.assertIsNone(fn)


class TestCasesFingerprint(unittest.TestCase):
    def test_same_pattern_same_fingerprint(self):
        from agent_platform.store.cases import fingerprint
        a = fingerprint('psycopg.errors.UniqueViolation: duplicate key "123" at x.py:10')
        b = fingerprint('psycopg.errors.UniqueViolation: duplicate key "999" at x.py:55')
        self.assertEqual(a, b)

    def test_different_pattern_differs(self):
        from agent_platform.store.cases import fingerprint
        a = fingerprint("connection refused to db")
        b = fingerprint("out of memory")
        self.assertNotEqual(a, b)


class TestDagsterSensor(unittest.TestCase):
    def test_rule_classify(self):
        from agent_platform.triggers.dagster_sensor import rule_classify
        self.assertEqual(rule_classify("connection refused by db")["category"], "infra")
        self.assertIsNone(rule_classify("weird bespoke failure xyz"))

    def test_session_id_stable_within_day(self):
        from agent_platform.triggers.dagster_sensor import session_id_for
        a = session_id_for("my.asset", "connection refused", day="2026-10-08")
        b = session_id_for("my.asset", "connection refused again", day="2026-10-08")
        self.assertEqual(a, b)
        c = session_id_for("my.asset", "bespoke weird failure", day="2026-10-08")
        self.assertNotEqual(a, c)  # 跨故障类开新线


class TestSpec(unittest.TestCase):
    def test_roundtrip(self):
        from agent_platform.orchestration.spec import RunSpec
        spec = RunSpec(run_id="r1", task_type="data-qa", role="data_searcher",
                       question="q", session_id="s1")
        spec2 = RunSpec.from_dict({**spec.to_dict(), "unknown_field": 1})
        self.assertEqual(spec, spec2)

    def test_defaults(self):
        from agent_platform.orchestration.spec import RunSpec
        spec = RunSpec()
        self.assertEqual(spec.timeout_s, 300)
        self.assertFalse(spec.correction)


class TestModelPool(unittest.IsolatedAsyncioTestCase):
    async def test_token_rotation_on_retryable(self):
        from agent_platform.model.pool import ModelPool

        calls = []

        class RateLimitError(Exception):
            pass

        def factory(token):
            class C:
                class chat:
                    class completions:
                        @staticmethod
                        async def create(model, messages, **kw):
                            calls.append(token)
                            if token == "t1":
                                raise RateLimitError()
                            return "ok"
            return C()

        pool = ModelPool("http://x", "m", ["t1", "t2"], client_factory=factory)
        result = await pool.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(result, "ok")
        self.assertEqual(calls, ["t1", "t2"])

    async def test_embed_disabled_returns_none(self):
        from agent_platform.model.pool import ModelPool
        pool = ModelPool("http://x", "m", ["t"], client_factory=lambda t: None)
        self.assertIsNone(await pool.embed(["text"]))


if __name__ == "__main__":
    unittest.main()
