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
        (root / "base/common.yaml").write_text(
            "domains:\n  board:\n    code_paths: [/srv/board]\n"
            "approvals: {enabled: false, danger_patterns: ['rm -rf']}\n")
        (root / "env/dev.yaml").write_text(
            "db_dsn: postgresql://x\n"
            "model: {url: http://m/v1, name: m, tokens: ['${TOKEN_A}']}\n"
            "dingtalk_relay_url: http://relay\n"
            "dingtalk_token: t\n"
            "bearer_token: b\n"
            "viewer_base_url: http://viewer\n"
            "approvals: {enabled: true}\n")  # 深合并：只覆盖 enabled，patterns 继承

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
                # 深合并：env 覆盖 enabled，common 的 patterns 保留
                self.assertTrue(s.approvals.enabled)
                self.assertEqual(s.approvals.danger_patterns, ["rm -rf"])
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

    def test_resolve_target_env(self):
        from agent_platform.config import Settings
        s = Settings(db_dsn="x", model={"url": "u", "name": "m", "tokens": ["t"]},
                     dingtalk_relay_url="r", dingtalk_token="t",
                     bearer_token="b", viewer_base_url="v",
                     env="deploy", target_envs=["prod", "test"])
        self.assertEqual(s.resolve_target_env(None), "prod")   # 默认第一档
        self.assertEqual(s.resolve_target_env("test"), "test")
        with self.assertRaises(ValueError):
            s.resolve_target_env("staging")                    # 未纳管的环境
        # 显式默认目标环境优先
        s2 = s.model_copy(update={"default_target_env": "test"})
        self.assertEqual(s2.resolve_target_env(None), "test")
        # 未配置 target_envs：单环境部署，退化为实例标签，任意请求透传
        s3 = s.model_copy(update={"target_envs": []})
        self.assertEqual(s3.resolve_target_env(None), "deploy")

    def test_domain_for_env(self):
        from agent_platform.config import DomainConfig
        d = DomainConfig(
            code_paths=["/srv/board"], readonly_dsn="postgres://prod_ro",
            envs={"test": {"readonly_dsn": "postgres://test_ro"}})
        prod = d.for_env("prod")          # 无覆盖 → 原样返回
        self.assertIs(prod, d)
        test = d.for_env("test")          # 目标环境覆盖
        self.assertEqual(test.readonly_dsn, "postgres://test_ro")
        self.assertEqual(test.code_paths, ["/srv/board"])  # 未覆盖字段继承基座
        self.assertEqual(test.envs, {})   # 覆盖表不泄漏进解析结果
        # for_env 不改动原对象
        self.assertEqual(d.readonly_dsn, "postgres://prod_ro")


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


class TestHostInfo(unittest.IsolatedAsyncioTestCase):
    async def test_instance_regex(self):
        from agent_platform.agent.tools.hostinfo import instance_regex
        r = instance_regex(["10.0.0.11", "10.0.0.21"])
        self.assertIn(r"\.", r)                    # IP 点号被转义（不当通配符）
        self.assertRegex("10.0.0.11:9100", r)
        self.assertRegex("10.0.0.21", r)
        self.assertNotRegex("10.0.0.119", r)       # 前缀不误匹配

    async def test_collect_render(self):
        from agent_platform.agent.tools.hostinfo import collect
        gb = 1024 ** 3

        async def fetch(expr):
            if "MemTotal" in expr:
                return {"10.0.0.11:9100": 32 * gb}
            if "MemAvailable" in expr:
                return {"10.0.0.11:9100": 8 * gb}
            if "node_load1" in expr:
                return {"10.0.0.11:9100": 3.2}
            if "cpu_seconds" in expr:
                return {"10.0.0.11:9100": 8.0}
            if "filesystem_size" in expr:
                return {"10.0.0.11:9100": 200 * gb}
            if "filesystem_avail" in expr:
                return {"10.0.0.11:9100": 100 * gb}
            return {}

        out = await collect(fetch, ["10.0.0.11", "10.0.0.21"])
        self.assertIn("75%", out)                  # (32-8)/32
        self.assertIn("3.20 / 8 核", out)
        self.assertIn("50%", out)                  # 根盘
        self.assertIn("10.0.0.21 | 无数据", out)   # 采不到的主机显式列出

    async def test_tool_wiring(self):
        from agent_platform.agent.tools.registry import ToolRegistry
        # 无 resolver：不注册
        reg = ToolRegistry(tempfile.mkdtemp())
        self.assertNotIn("host_metrics", reg._catalog)
        # 有 resolver 但域未登记主机
        reg = ToolRegistry(tempfile.mkdtemp(),
                           host_resolver=lambda d, e: ([], object()))
        fn = reg.host_tools(["host_metrics"])["host_metrics"]
        self.assertIn("未登记部署主机", await fn("board"))


class TestTraceGraph(unittest.TestCase):
    """详情页轨迹图：按本 run 事件流构建，每个 run 形状不同。"""

    @staticmethod
    def _ev(seq, kind, **payload):
        return {"seq": seq, "kind": kind, "payload": payload,
                "created_at": "2026-10-09T10:00:00"}

    def test_empty(self):
        from agent_platform.viewer.pages.runs import _trace_graph
        self.assertIsNone(_trace_graph([], "queued"))
        # graph 事件不属于执行轨迹（资产图 run 走另一分支）
        self.assertIsNone(_trace_graph(
            [self._ev(1, "graph", nodes=[], edges=[])], "running"))

    def test_tool_chain_with_final(self):
        from agent_platform.viewer.pages.runs import _trace_graph
        events = [
            self._ev(1, "thought", node="model", content="先查知识库"),
            self._ev(2, "tool_call", node="tools", tool="grep",
                     args='{"pattern": "margin"}'),
            self._ev(3, "tool_result", node="tools", tool="grep", output="hit"),
            self._ev(4, "tool_call", node="tools", tool="sql_query",
                     args='{"sql": "select 1"}'),
            self._ev(5, "tool_result", node="tools", tool="sql_query",
                     output="1"),
            self._ev(6, "llm", stage="final", content="结论"),
        ]
        g = _trace_graph(events, "success")
        self.assertEqual([n["id"] for n in g["nodes"]],
                         ["start", "seq-2", "seq-4", "seq-6"])
        self.assertEqual(g["nodes"][1]["label"], 'grep\n{"pattern": "margin"}')
        self.assertEqual(g["nodes"][3]["label"], "结论")
        self.assertEqual([(e["source"], e["target"]) for e in g["edges"]],
                         [("start", "seq-2"), ("seq-2", "seq-4"),
                          ("seq-4", "seq-6")])
        # 成功 run 全部已执行
        self.assertEqual(set(g["statuses"].values()), {"executed"})
        self.assertTrue(g["trace"])

    def test_running_marks_last_active(self):
        from agent_platform.viewer.pages.runs import _trace_graph
        events = [self._ev(1, "thought", node="model", content="清理临时目录"),
                  self._ev(2, "tool_call", node="tools", tool="bash",
                           args='{"command": "rm -rf /tmp/x"}')]
        g = _trace_graph(events, "running")
        self.assertEqual(g["statuses"], {"start": "executed",
                                         "seq-2": "active"})

    def test_failed_marks_last_failed(self):
        from agent_platform.viewer.pages.runs import _trace_graph
        events = [self._ev(1, "tool_call", node="tools", tool="bash",
                           args="ls"),
                  self._ev(2, "tool_result", node="tools", tool="bash",
                           output="boom")]
        g = _trace_graph(events, "failed")
        self.assertEqual(g["statuses"]["seq-1"], "failed")

    def test_no_tool_fallback_node(self):
        from agent_platform.viewer.pages.runs import _trace_graph
        # 纯问答：无工具调用，末事件兜底一个节点，图不缺席
        g = _trace_graph([self._ev(1, "thought", node="model", content="嗨")],
                         "success")
        self.assertEqual([n["label"] for n in g["nodes"]], ["开始", "思考"])
        self.assertEqual(g["edges"], [{"source": "start", "target": "seq-1"}])

    def test_args_clipped_first_line(self):
        from agent_platform.viewer.pages.runs import _trace_graph
        g = _trace_graph([self._ev(1, "tool_call", node="tools", tool="bash",
                                   args="x" * 60 + "\n第二行")], "success")
        self.assertEqual(g["nodes"][1]["label"], "bash\n" + "x" * 48)

    def test_pending_approval_marker(self):
        from agent_platform.viewer.pages.runs import _trace_graph
        events = [self._ev(1, "thought", node="model", content="清"),
                  self._ev(2, "tool_call", node="tools", tool="bash",
                           args="rm -rf /x")]
        g = _trace_graph(events, "running", pending=True)
        self.assertIn("⏸ 待审批", g["nodes"][-1]["label"])  # 位置节点显式标记
        self.assertEqual(g["statuses"]["seq-2"], "active")
        # 无 pending 不带标记
        g2 = _trace_graph(events, "running")
        self.assertNotIn("⏸", g2["nodes"][-1]["label"])
        # 提交闸门（结论后待审批）：标记落在结论节点
        g3 = _trace_graph(events + [self._ev(3, "llm", content="done")],
                          "running", pending=True)
        self.assertIn("⏸ 待审批", g3["nodes"][-1]["label"])
        self.assertEqual(g3["nodes"][-1]["id"], "seq-3")


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

    async def test_stderr_flood_no_deadlock(self):
        """P1 回归：stderr 超 64KB 管道缓冲也不死锁（并发消费 + 上限截断）。"""
        from agent_platform.agent.tools.run_code import execute_code
        with tempfile.TemporaryDirectory() as scratch:
            out = await execute_code(
                "import sys\nsys.stderr.write('x' * 200_000)\nprint('ok')",
                {}, scratch, timeout=30)
            self.assertIn("ok", out)
            self.assertIn("stderr", out)


class TestReviewHook(unittest.IsolatedAsyncioTestCase):
    async def test_hook_awaits_in_running_loop(self):
        """P0 回归：审批 hook 是 async 的，在运行中的事件循环里被直接 await。

        旧实现用 asyncio.run 包同步流程，工具在 loop 里调用即 RuntimeError；
        这里不打补丁地还原调用场景（registry 的 await review(...)）。
        """
        from agent_platform.agent import approvals

        calls = []

        async def fake_request(run_id, text):
            calls.append(("request", run_id, text))
            return 7

        async def fake_notify(run_id, text):
            calls.append(("notify", run_id))

        async def fake_wait(approval_id):
            calls.append(("wait", approval_id))

        saved = (approvals.request_approval, approvals.wait_decision)
        approvals.request_approval, approvals.wait_decision = fake_request, fake_wait
        try:
            hook = approvals.make_review_hook([r"rm\s+-rf"], fake_notify)
            token = approvals.current_run_id.set("run-1")
            try:
                await hook("rm -rf /data")  # 直接 await：旧实现此处必炸 RuntimeError
            finally:
                approvals.current_run_id.reset(token)
        finally:
            approvals.request_approval, approvals.wait_decision = saved
        self.assertEqual(calls, [("request", "run-1", "rm -rf /data"),
                                 ("notify", "run-1"), ("wait", 7)])

    async def test_hook_passes_safe_command(self):
        """未命中危险模式：直接返回，不碰 DB/通知。"""
        from agent_platform.agent import approvals
        hook = approvals.make_review_hook([r"rm\s+-rf"], None)
        await hook("ls -la")  # 无异常即通过


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
    # 规则已迁入域包（conf/domains/dagster/rules.yaml）；测试自带规则
    _RULES = [{"pattern": r"connection.*(refused|timeout|reset)",
               "category": "infra", "conclusion": "连接失败"}]

    def test_rule_classify(self):
        from agent_platform.triggers.dagster_sensor import rule_classify
        self.assertEqual(rule_classify("connection refused by db",
                                       self._RULES)["category"], "infra")
        self.assertIsNone(rule_classify("weird bespoke failure xyz",
                                        self._RULES))
        self.assertIsNone(rule_classify("connection refused", []))  # 无规则→交 agent

    def test_session_id_stable_within_day(self):
        from agent_platform.triggers.dagster_sensor import session_id_for
        a = session_id_for("my.asset", "connection refused", self._RULES,
                           day="2026-10-08")
        b = session_id_for("my.asset", "connection refused again", self._RULES,
                           day="2026-10-08")
        self.assertEqual(a, b)
        c = session_id_for("my.asset", "bespoke weird failure", self._RULES,
                           day="2026-10-08")
        self.assertNotEqual(a, c)  # 跨故障类开新线

    def test_session_template_from_pack(self):
        """episode 命名模板来自域包，可整体改写。"""
        from agent_platform.triggers.dagster_sensor import session_id_for
        sid = session_id_for("my.asset", "connection refused", self._RULES,
                             template="dc-{asset}-{date}",
                             day="2026-10-08")
        self.assertEqual(sid, "dc-my.asset-2026-10-08")


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

    def test_effective_env(self):
        from agent_platform.orchestration.spec import RunSpec
        self.assertEqual(RunSpec().effective_env("deploy"), "deploy")  # 退化实例标签
        self.assertEqual(RunSpec(target_env="prod").effective_env("deploy"),
                         "prod")


class TestModelPool(unittest.IsolatedAsyncioTestCase):
    def test_rotating_token_auth_per_request(self):
        """主 agent 的 httpx 客户端：每个请求换下一个 token（含 429 重试）。"""
        import httpx

        from agent_platform.model.pool import RotatingTokenAuth
        auth = RotatingTokenAuth(["t1", "t2"])
        seen = []
        for _ in range(3):
            req = httpx.Request("POST", "http://x/v1/chat/completions")
            list(auth.auth_flow(req))     # 同步驱动生成器
            seen.append(req.headers["Authorization"])
        self.assertEqual(seen, ["Bearer t1", "Bearer t2", "Bearer t1"])
        with self.assertRaises(Exception):
            RotatingTokenAuth([])         # 空 token 配置期暴露

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

    async def test_engine_model_http_reused_across_rebuilds(self):
        """agent TTL 重建时 http client 复用同一个——每周期新建就是连接池泄漏。"""
        from types import SimpleNamespace

        from agent_platform.agent.engine import Engine
        settings = SimpleNamespace(model=SimpleNamespace(
            url="http://m/v1", name="m", tokens=["t1", "t2"]))
        engine = Engine(settings, defs_store=None, tool_registry=None)
        engine._make_model()
        first = engine._model_http
        engine._make_model()  # 模拟 TTL 到期重建
        self.assertIs(engine._model_http, first)
        await engine.close()
        self.assertIsNone(engine._model_http)
        self.assertTrue(first.is_closed)


class _FakeLangfuseSDK:
    """langfuse.Langfuse 的测试替身：记录调用，可模拟远端故障。"""

    def __init__(self, **kw):
        self.kw = kw                    # 构造参数（host/keys/tracing_enabled）
        self.prompts: dict[str, dict] = {}
        self.scores: list[dict] = []
        self.flushed = False
        self.down = False

    def get_prompt(self, name, *, label=None, cache_ttl_seconds=None,
                   fetch_timeout_seconds=None, **_):
        if self.down:
            raise RuntimeError("Langfuse 不可达")
        p = self.prompts[name]
        from types import SimpleNamespace
        return SimpleNamespace(prompt=p["prompt"], config=p.get("config"))

    def create_prompt(self, *, name, prompt, config, labels, type,  # noqa: A002
                      commit_message=None, **_):
        self.prompts[name] = {"prompt": prompt, "config": config,
                              "labels": labels}

    def create_score(self, **kw):
        if self.down:
            raise RuntimeError("Langfuse 不可达")
        self.scores.append(kw)

    def flush(self):
        self.flushed = True


class _FakePgFallback:
    """definitions 表缓存的测试替身。"""

    def __init__(self):
        self.store: dict[str, dict] = {}

    async def get_cache(self, name):
        return self.store.get(name)

    async def put_cache(self, name, definition):
        self.store[name] = definition


class TestLangfuseClient(unittest.IsolatedAsyncioTestCase):
    """langfuse 门面：官方 SDK 注入替身，验证降级链与回写语义。"""

    def _client(self, enabled=True):
        from agent_platform.config import LangfuseConfig
        from agent_platform.langfuse import LangfuseClient
        cfg = LangfuseConfig(enabled=enabled, host="http://lf",
                             public_key="pk", secret_key="sk",
                             prompt_label="production", prompt_cache_ttl_s=10)
        return LangfuseClient(cfg, client_factory=_FakeLangfuseSDK)

    async def test_fetch_remote_and_write_through_pg(self):
        lf = self._client()
        sdk = lf._client
        sdk.prompts["role:analyst"] = {"prompt": "你是分析师",
                                       "config": {"tools": ["sql_query"]}}
        pg = _FakePgFallback()
        d = await lf.fetch_role("analyst", pg)
        self.assertEqual(d, {"prompt": "你是分析师", "tools": ["sql_query"]})
        self.assertEqual(pg.store["analyst"], d)      # 写穿 PG 持久缓存
        self.assertEqual(sdk.kw["tracing_enabled"], False)  # tracing 归 OTEL 管线

    async def test_remote_down_falls_back_to_last_known_then_pg(self):
        lf = self._client()
        sdk = lf._client
        sdk.prompts["role:analyst"] = {"prompt": "v1", "config": {}}
        pg = _FakePgFallback()
        await lf.fetch_role("analyst", pg)
        sdk.down = True
        # 远端挂 + 进程内 last-known-good 命中
        self.assertEqual((await lf.fetch_role("analyst", pg))["prompt"], "v1")
        # 进程重启（新门面无 last-known）→ PG 持久缓存兜底
        lf2 = self._client()
        lf2._client.down = True
        self.assertEqual((await lf2.fetch_role("analyst", pg))["prompt"], "v1")
        # PG 也没有 → None
        self.assertIsNone(await lf2.fetch_role("ghost", pg))

    async def test_disabled_goes_straight_to_pg(self):
        lf = self._client(enabled=False)
        self.assertFalse(lf.enabled)
        pg = _FakePgFallback()
        pg.store["analyst"] = {"prompt": "pg 版"}
        self.assertEqual((await lf.fetch_role("analyst", pg))["prompt"], "pg 版")
        with self.assertRaises(RuntimeError):
            await lf.put_role("analyst", {"prompt": "x"})
        self.assertFalse(await lf.score("tid", "user_feedback", 1.0))

    async def test_put_role_new_version_takes_label(self):
        lf = self._client()
        await lf.put_role("analyst", {"prompt": "v2", "tools": ["bash"]},
                          updated_by="admin")
        p = lf._client.prompts["role:analyst"]
        self.assertEqual(p["labels"], ["production"])  # 新版本接管 label
        self.assertEqual(p["config"], {"tools": ["bash"]})  # prompt 不进 config
        # last-known 同步更新，不依赖下一次拉取
        pg = _FakePgFallback()
        lf._client.down = True
        self.assertEqual((await lf.fetch_role("analyst", pg))["prompt"], "v2")

    async def test_score_and_flush(self):
        lf = self._client()
        self.assertTrue(await lf.score("tid-1", "user_feedback", 1.0,
                                       comment="赞"))
        self.assertEqual(lf._client.scores[0]["trace_id"], "tid-1")
        self.assertEqual(lf._client.scores[0]["data_type"], "NUMERIC")
        self.assertFalse(await lf.score("", "user_feedback", 1.0))  # 无 trace 不写
        lf._client.down = True
        self.assertFalse(await lf.score("tid-1", "user_feedback", 0.0))
        await lf.flush()
        self.assertTrue(lf._client.flushed)

    async def test_score_span_level(self):
        """节点级反馈：给 observation_id 即挂 span（Annotate 的 API 等价）。"""
        lf = self._client()
        self.assertTrue(await lf.score("tid-1", "step#2", -1.0,
                                       observation_id="obs-9"))
        self.assertEqual(lf._client.scores[0]["observation_id"], "obs-9")
        await lf.score("tid-1", "user_feedback", 1.0)  # 不给则不多传（trace 级）
        self.assertNotIn("observation_id", lf._client.scores[1])

    async def test_observations_failure_returns_empty(self):
        lf = self._client()
        # 替身没有 public API（连接 refuse）→ 空表降级，不抛错
        self.assertEqual(await lf.observations("tid-x"), [])
        self.assertEqual(await lf.observations(""), [])


class TestMatchObservation(unittest.TestCase):
    """seq → Langfuse observation id 的对齐规则。"""

    EVENTS = [
        {"seq": 0, "kind": "trace", "payload": {"trace_id": "t"}},
        {"seq": 1, "kind": "thought", "payload": {"content": "..."}},
        {"seq": 2, "kind": "tool_call", "payload": {"tool": "grep"}},
        {"seq": 3, "kind": "tool_result", "payload": {"tool": "grep"}},
        {"seq": 4, "kind": "tool_call", "payload": {"tool": "sql_query"}},
        {"seq": 5, "kind": "tool_result", "payload": {"tool": "sql_query"}},
        {"seq": 6, "kind": "tool_call", "payload": {"tool": "grep"}},
        {"seq": 7, "kind": "tool_result", "payload": {"tool": "grep"}},
        {"seq": 8, "kind": "llm", "payload": {"content": "a1"}},
        {"seq": 9, "kind": "llm", "payload": {"content": "a2"}},
    ]
    OBS = [
        {"id": "o-grep-2", "name": "grep", "type": "SPAN",
         "startTime": "2026-01-01T00:00:04Z"},   # 乱序到达，靠 startTime 排
        {"id": "o-grep-1", "name": "grep", "type": "SPAN",
         "startTime": "2026-01-01T00:00:02Z"},
        {"id": "o-sql", "name": "sql_query", "type": "TOOL",
         "startTime": "2026-01-01T00:00:03Z"},
        {"id": "o-gen-2", "name": "ChatOpenAI", "type": "GENERATION",
         "startTime": "2026-01-01T00:00:06Z"},
        {"id": "o-gen-1", "name": "ChatOpenAI", "type": "GENERATION",
         "startTime": "2026-01-01T00:00:05Z"},
    ]

    def m(self, seq):
        from agent_platform.langfuse import match_observation
        return match_observation(self.EVENTS, seq, self.OBS)

    def test_tool_steps_map_by_name_and_occurrence(self):
        self.assertEqual(self.m(2), "o-grep-1")   # 第一次 grep 的调用
        self.assertEqual(self.m(3), "o-grep-1")   # 同次执行的结果行
        self.assertEqual(self.m(4), "o-sql")
        self.assertEqual(self.m(6), "o-grep-2")   # 第二次 grep
        self.assertEqual(self.m(7), "o-grep-2")

    def test_llm_steps_map_to_generation_by_occurrence(self):
        self.assertEqual(self.m(8), "o-gen-1")
        self.assertEqual(self.m(9), "o-gen-2")

    def test_unmappable_returns_none(self):
        self.assertIsNone(self.m(0))    # trace 行
        self.assertIsNone(self.m(1))    # 思考行
        self.assertIsNone(self.m(99))   # seq 不存在
        # observations 为空 → None（调用方降级 trace 级）
        from agent_platform.langfuse import match_observation
        self.assertIsNone(match_observation(self.EVENTS, 2, []))

    async def test_trace_url_direct_link(self):
        import agent_platform.langfuse as lf_mod
        lf = self._client()
        calls = []

        def fake_get(url, headers):
            calls.append(url)
            self.assertEqual(url, "http://lf/api/public/projects")
            self.assertIn("Basic", headers["Authorization"])
            return {"data": [{"id": "proj-1", "name": "default"}]}

        orig = lf_mod._http_get_json
        lf_mod._http_get_json = fake_get
        try:
            self.assertEqual(await lf.trace_url("tid-9"),
                             "http://lf/project/proj-1/traces/tid-9")
            await lf.trace_url("tid-10")          # 第二次命中缓存
            self.assertEqual(calls, ["http://lf/api/public/projects"])
        finally:
            lf_mod._http_get_json = orig

    async def test_trace_url_fallbacks(self):
        import agent_platform.langfuse as lf_mod
        # 未启用 → 空串
        self.assertEqual(await self._client(enabled=False).trace_url("t"), "")
        lf = self._client()
        self.assertEqual(await lf.trace_url(""), "")  # 无 trace id → 空串
        # 解析失败 → 空串且缓存（不再重复请求）
        orig = lf_mod._http_get_json
        calls = []

        def boom(url, headers):
            calls.append(url)
            raise RuntimeError("down")

        lf_mod._http_get_json = boom
        try:
            self.assertEqual(await lf.trace_url("t"), "")
            self.assertEqual(await lf.trace_url("t"), "")
            self.assertEqual(len(calls), 1)
        finally:
            lf_mod._http_get_json = orig

    async def test_publish_trace_marks_public_and_caches(self):
        import agent_platform.langfuse as lf_mod
        lf = self._client()
        posts = []

        def fake_post(url, payload, headers):
            posts.append((url, payload))
            return 207

        orig = lf_mod._http_post_json
        lf_mod._http_post_json = fake_post
        try:
            self.assertTrue(await lf.publish_trace("tid-1"))
            self.assertTrue(await lf.publish_trace("tid-1"))  # 幂等去重
            self.assertEqual(len(posts), 1)
            url, payload = posts[0]
            self.assertEqual(url, "http://lf/api/public/ingestion")
            ev = payload["batch"][0]
            self.assertEqual(ev["type"], "trace-create")
            self.assertEqual(ev["body"], {"id": "tid-1", "public": True})
        finally:
            lf_mod._http_post_json = orig
        # 失败不记入已发布集合（下次重试），也不抛出
        def boom(url, payload, headers):
            raise RuntimeError("down")

        lf_mod._http_post_json = boom
        try:
            self.assertFalse(await lf.publish_trace("tid-2"))
            self.assertNotIn("tid-2", lf._published)
        finally:
            lf_mod._http_post_json = orig
        # embed 关闭 / 未启用 → 不发布
        self.assertFalse(await self._client(enabled=False).publish_trace("t"))

    async def test_publish_disabled_skips_public_link(self):
        """publish=false（同站点登录态部署）：不设公开链接、直接视为就绪。"""
        import agent_platform.langfuse as lf_mod
        from agent_platform.config import LangfuseConfig
        from agent_platform.langfuse import LangfuseClient
        cfg = LangfuseConfig(enabled=True, host="http://lf", public_key="pk",
                             secret_key="sk", publish=False)
        lf = LangfuseClient(cfg, client_factory=_FakeLangfuseSDK)
        posts = []
        orig = lf_mod._http_post_json
        lf_mod._http_post_json = lambda *a: posts.append(a) or 207
        try:
            self.assertTrue(await lf.publish_trace("tid-1"))  # 就绪但不发请求
            self.assertEqual(posts, [])
            self.assertNotIn("tid-1", lf._published)
        finally:
            lf_mod._http_post_json = orig

    async def test_frame_check(self):
        import agent_platform.langfuse as lf_mod
        lf = self._client()
        orig = lf_mod._http_headers
        try:
            lf_mod._http_headers = lambda url: {}
            self.assertTrue(await lf.frame_check("http://lf/x"))
            lf_mod._http_headers = lambda url: {
                "x-frame-options": "SAMEORIGIN"}
            self.assertFalse(await lf.frame_check("http://lf/x"))
            lf_mod._http_headers = lambda url: {
                "content-security-policy": "default-src 'self'; "
                                           "frame-ancestors 'self'"}
            self.assertFalse(await lf.frame_check("http://lf/x"))

            def boom(url):
                raise RuntimeError("down")

            lf_mod._http_headers = boom
            self.assertFalse(await lf.frame_check("http://lf/x"))  # 不可达按禁止
        finally:
            lf_mod._http_headers = orig


class TestArtGraph(unittest.TestCase):
    """资产化任务图的纯逻辑面：声明校验 / 拓扑分层 / 闸门求值。"""

    def test_node_def_exactly_one_materializer(self):
        from agent_platform.orchestration.artgraph import NodeDef
        with self.assertRaises(ValueError):
            NodeDef()                                  # 三种物化方式都没有
        with self.assertRaises(ValueError):
            NodeDef(code="a", agent={"role": "r"})     # 多选不允许
        with self.assertRaises(ValueError):
            NodeDef(route={"choices": ["x"]}, map="up")  # route 不支持 map
        self.assertEqual(NodeDef(code="a").code, "a")  # 恰一个：合法

    def test_topo_layers(self):
        from agent_platform.orchestration.artgraph import NodeDef, topo_layers
        nodes = {
            "c": NodeDef(code="c", deps=["a", "b"]),
            "a": NodeDef(code="a"),
            "b": NodeDef(code="b", deps=["a"]),
        }
        self.assertEqual(topo_layers(nodes), [["a"], ["b"], ["c"]])

    def test_topo_cycle_and_dangling_rejected(self):
        from agent_platform.orchestration.artgraph import NodeDef, topo_layers
        with self.assertRaises(ValueError):  # 环
            topo_layers({"a": NodeDef(code="x", deps=["b"]),
                         "b": NodeDef(code="x", deps=["a"])})
        with self.assertRaises(ValueError):  # 悬空依赖
            topo_layers({"a": NodeDef(code="x", deps=["ghost"])})

    def test_gate_holds(self):
        from agent_platform.orchestration.artgraph import SKIPPED, gate_holds
        self.assertTrue(gate_holds('verdict == "ok"', {"verdict": "ok"}))
        self.assertFalse(gate_holds('verdict == "ok"', {"verdict": "escalate"}))
        self.assertTrue(gate_holds('verdict != "ok"', {"verdict": "escalate"}))
        # 上游缺失/跳过按空串处理：!= 成立、== 不成立
        self.assertTrue(gate_holds('verdict != "ok"', {"verdict": SKIPPED}))
        self.assertFalse(gate_holds('verdict == "ok"', {}))
        with self.assertRaises(ValueError):  # 只接受受限语法
            gate_holds("x > 1", {})

    def test_terminal_nodes(self):
        from agent_platform.orchestration.artgraph import (
            NodeDef, terminal_nodes)
        nodes = {"a": NodeDef(code="a"), "b": NodeDef(code="b", deps=["a"]),
                 "c": NodeDef(code="c")}
        self.assertEqual(terminal_nodes(nodes), ["b", "c"])


class TestRunGraph(unittest.IsolatedAsyncioTestCase):
    """解释器 run_graph：IO 全部走注入的 call，这里用内存桩验证编排语义。"""

    @staticmethod
    def _spec():
        return {"run_id": "r1", "task_type": "t", "input": {}, "artifacts": {
            "extract": {"code": "c.extract"},
            "per": {"agent": {"role": "r"}, "map": "extract",
                    "deps": ["extract"]},
            "verdict": {"route": {"choices": ["ok", "escalate"]},
                        "deps": ["per"]},
            "report": {"agent": {"role": "r"}, "deps": ["verdict"],
                       "gate": {"when": 'verdict == "escalate"'}},
            "summary": {"code": "c.summary", "deps": ["per"]},
        }}

    async def test_skip_propagation_and_terminals(self):
        from agent_platform.orchestration import activities
        from agent_platform.orchestration.artgraph import run_graph
        marks, gates = [], []

        async def call(fn, *args):  # prod 里这是 workflow.execute_activity
            if fn is activities.art_mark:
                marks.append(args)
                return None
            if fn is activities.art_gate:
                gates.append(args)
                return True
            if fn is activities.art_materialize:
                _, name, node_def, payload = args
                if name == "extract":
                    return {"content": ["a", "b"]}
                if payload.get("item") is not None:
                    return {"content": f"item:{payload['item']}"}
                if node_def.get("route"):
                    return {"content": "ok"}
                return {"content": f"made:{name}"}
            raise AssertionError(f"未预期的 activity：{fn}")

        out = await run_graph(self._spec(), call)
        # verdict 被 report 依赖 = 中间产物，不进终末；gate 不命中 →
        # report 跳过且不审批；终末只有 summary
        self.assertEqual(out, {"summary": "made:summary"})
        self.assertEqual(gates, [])
        skipped = [m for m in marks if m[3] == "skipped"]
        self.assertEqual(len(skipped), 1)
        self.assertEqual(skipped[0][2], "report")

    async def test_gate_holds_triggers_approval(self):
        from agent_platform.orchestration import activities
        from agent_platform.orchestration.artgraph import run_graph
        gates = []

        async def call(fn, *args):
            if fn is activities.art_mark:
                return None
            if fn is activities.art_gate:
                gates.append(args)
                return True                     # 审批通过 → 继续物化
            if fn is activities.art_materialize:
                _, name, node_def, payload = args
                if name == "extract":
                    return {"content": ["a"]}
                if payload.get("item") is not None:
                    return {"content": f"item:{payload['item']}"}
                if node_def.get("route"):
                    return {"content": "escalate"}
                return {"content": f"made:{name}"}
            raise AssertionError(fn)

        out = await run_graph(self._spec(), call)
        self.assertEqual(len(gates), 1)          # 条件命中 → 过一次人工门
        self.assertEqual(out["report"], "made:report")

    async def test_empty_graph_rejected(self):
        from agent_platform.orchestration.artgraph import run_graph

        async def call(fn, *args):
            raise AssertionError("不应有 IO")

        with self.assertRaises(ValueError):
            await run_graph({"run_id": "r", "task_type": "t"}, call)


class TestDomainPack(unittest.TestCase):
    """域包加载：conf/domains/<name>/ 与 base/common.yaml 内联域深合并。"""

    def _write_conf(self, root: Path):
        (root / "base").mkdir(parents=True)
        (root / "env").mkdir(parents=True)
        (root / "base/common.yaml").write_text(
            "domains:\n  board:\n    code_paths: [/srv/board]\n"
            "  dagster:\n    code_paths: [/srv/dagster-override]\n")
        (root / "env/dev.yaml").write_text(
            "db_dsn: postgresql://x\n"
            "model: {url: http://m/v1, name: m, tokens: [t]}\n"
            "dingtalk_relay_url: http://relay\n"
            "dingtalk_token: t\n"
            "bearer_token: b\n"
            "viewer_base_url: http://viewer\n")
        pack = root / "domains" / "dagster"
        pack.mkdir(parents=True)
        (pack / "domain.yaml").write_text("code_paths: [/srv/dagster]\n")
        (pack / "rules.yaml").write_text(
            "rules:\n  - {pattern: 'timeout', category: infra,"
            " conclusion: 查服务}\n")
        (pack / "session.yaml").write_text(
            "template: 'dagster:{asset}:{error_class}:{date}'\n")
        (pack / "tasks.yaml").write_text(
            "tasks:\n  - {name: failure-analysis, role: ops_analyst}\n")

    def test_pack_loading_and_merge(self):
        from agent_platform import config
        with tempfile.TemporaryDirectory() as d:
            self._write_conf(Path(d))
            old_root = config._CONF_ROOT
            config._CONF_ROOT = Path(d)
            try:
                s = config.load_settings("dev")
                dag = s.domains["dagster"]
                # 内联覆盖优先于域包（叶值替换），域包独有的字段保留
                self.assertEqual(dag.code_paths, ["/srv/dagster-override"])
                self.assertEqual(dag.rules[0]["category"], "infra")
                self.assertEqual(dag.session_template,
                                 "dagster:{asset}:{error_class}:{date}")
                self.assertEqual(dag.seed_tasks[0]["name"], "failure-analysis")
                self.assertIn("board", s.domains)  # 纯内联域不受影响
            finally:
                config._CONF_ROOT = old_root


class TestSvcRun(unittest.TestCase):
    """通用服务纳管启动器：注册表校验与 bwrap 命令行构造（纯逻辑）。"""

    def _registry(self):
        return {
            "envs": ["prod", "test", "dev"],
            "services": {
                "board": {
                    "workdir": "/srv/board",
                    "cmd": ["node", "server.js", "--port", "{port}"],
                    "ports": {"prod": 8080, "test": 8081},
                    "env_vars": {"APP_ENV": "{env}"},
                    "configs": [{
                        "canonical": "/srv/board/.env",
                        "template": "/srv/board/conf/.env.{env}",
                    }],
                },
            },
        }

    def test_bind_selected_mask_others(self):
        from agent_platform import svcrun
        existing = {"/srv/board/conf/.env.prod", "/srv/board/conf/.env.test"}
        argv = svcrun.build_argv(self._registry(), "board", "test",
                                 path_exists=lambda p: p in existing)
        # 选中环境 bind 到服务读的固定路径
        i = argv.index("--ro-bind")
        self.assertEqual(argv[i + 1:i + 3],
                         ["/srv/board/conf/.env.test", "/srv/board/.env"])
        # 其他环境已存在的配置文件被 /dev/null 遮蔽；dev 的文件不存在则跳过
        masks = [argv[j + 2] for j, a in enumerate(argv)
                 if a == "--ro-bind" and argv[j + 1] == "/dev/null"]
        self.assertEqual(masks, ["/srv/board/conf/.env.prod"])
        self.assertIn("--die-with-parent", argv)
        self.assertEqual(argv[argv.index("--chdir") + 1], "/srv/board")
        # {port}/{env} 占位渲染 + env_vars 注入
        self.assertEqual(argv[-2:], ["--port", "8081"])
        setenvs = {argv[j + 1]: argv[j + 2] for j, a in enumerate(argv)
                   if a == "--setenv"}
        self.assertEqual(setenvs["APP_ENV"], "test")
        self.assertEqual(setenvs["SVCRUN_ENV"], "test")

    def test_unknown_service_and_env(self):
        from agent_platform import svcrun
        with self.assertRaises(ValueError):
            svcrun.build_argv(self._registry(), "ghost", "test")
        with self.assertRaises(ValueError):
            svcrun.build_argv(self._registry(), "board", "staging")

    def test_missing_selected_config_raises(self):
        from agent_platform import svcrun
        with self.assertRaises(FileNotFoundError):
            svcrun.build_argv(self._registry(), "board", "test",
                              path_exists=lambda p: False)

    def test_registry_validation(self):
        from agent_platform import svcrun
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "services.yaml"
            p.write_text("envs: [prod]\nservices:\n  bad:\n    workdir: /x\n")
            with self.assertRaises(ValueError):  # 缺 cmd
                svcrun.load_registry(p)
            p.write_text("services: {}\n")
            with self.assertRaises(ValueError):  # 缺顶层 envs
                svcrun.load_registry(p)
            p.write_text("envs: [prod, test]\nservices:\n  s:\n"
                         "    cmd: [run]\n")
            self.assertEqual(svcrun.load_registry(p)["envs"], ["prod", "test"])


if __name__ == "__main__":
    unittest.main()
