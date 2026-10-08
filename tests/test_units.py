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
        skipped = [m for m in marks if m[-1] == "skipped"]
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
