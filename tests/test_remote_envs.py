"""代管执行（部署配置 remote_envs）：过渡期只在测试机部署，生产的运行由测试机代管。
认领范围、配置一律用只读版、日志与主机状况不可用、提示词说清不在部署主机上、记忆不按本机代码核对；
平台 MCP 的进程进沙箱、限内存。不需要 Postgres。"""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from support import seeded_registry, settings

from agent_platform import runtime
from agent_platform.agent import scope as run_scope
from agent_platform.agent.tools import mcp_bridge
from agent_platform.agent.tools import sandbox as sb
from agent_platform.agent.tools.catalog import Toolbox
from agent_platform.config import LimitsConfig
from agent_platform.domain import Rejected
from agent_platform.orchestration import pipeline
from agent_platform.services import envspec
from agent_platform.store import workers

run = asyncio.run


class SettingsTest(unittest.TestCase):
    def test_test_host_also_serves_prod(self):
        s = settings("/tmp/d", env="test", services=["vision-board"], remote_envs=["prod", "prod", " "])
        self.assertEqual(s.remote_envs, ["prod"])
        self.assertTrue(s.serves("vision-board", "prod"))
        self.assertTrue(s.serves(None, "prod"))                       # 平台任务按环境算
        self.assertFalse(s.serves("vision-dagster", "prod"))          # 服务范围和本机的一样
        self.assertEqual((s.is_local("test"), s.is_local("prod")), (True, False))
        self.assertEqual(s.claim_envs, ["test", "prod"])
        self.assertEqual(s.describe(), "test（vision-board），代管 prod")

    def test_own_env_cannot_be_remote(self):
        with self.assertRaises(ValueError):
            settings("/tmp/d", env="test", remote_envs=["test"])

    def test_without_remote_envs_nothing_changes(self):
        s = settings("/tmp/d", env="prod")
        self.assertEqual((s.claim_envs, s.is_local("prod"), s.serves("x", "test")), (["prod"], True, False))
        dev = settings("/tmp/d")
        self.assertEqual((dev.claim_envs, dev.is_local("prod")), ([], True))   # 开发机：什么都认领、都算本机的


class CheckRemoteEnvsTest(unittest.TestCase):
    def test_remote_env_must_exist_and_be_protected(self):
        reg = seeded_registry()
        run(envspec.check_remote_envs(reg, settings("/tmp/d", env="test", remote_envs=["prod"])))      # 种子里 prod 受保护
        with self.assertRaisesRegex(RuntimeError, "不在平台配置的环境里"):
            run(envspec.check_remote_envs(reg, settings("/tmp/d", env="test", remote_envs=["staging"])))
        with self.assertRaisesRegex(RuntimeError, "没有标成受保护"):
            run(envspec.check_remote_envs(reg, settings("/tmp/d", env="prod", remote_envs=["test"])))

    def test_worker_refuses_to_start(self):
        rt = mock.Mock(spec=runtime.Runtime)
        rt.settings = settings("/tmp/d", env="test", remote_envs=["staging"])
        rt.registry = seeded_registry()
        with self.assertRaisesRegex(RuntimeError, "不在平台配置的环境里"):
            run(runtime.Runtime.start_worker(rt))


class RemoteSpecTest(unittest.TestCase):
    """测试机上的目录结构：代码目录里只有测试的 settings（没有 {env} 的配置路径就是测试那份）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        code = self.root / "code"
        (code / "conf").mkdir(parents=True)
        (code / "conf" / "settings-test.py").write_text("DB='real-test'\n")
        (code / ".env").write_text("PW=real-test\n")
        self.code = code
        self.reg = seeded_registry()
        run(self.reg.update("service", "vision-board", {
            "root": str(code), "configs": [f"{code}/conf/settings-{{env}}.py", f"{code}/.env"],
            "logs": {"app": f"{code}/app.log"}}, "liyd"))
        self.s = settings(str(self.root / "data"), env="test", services=["vision-board"], remote_envs=["prod"])
        self.rows = {("vision-board", "prod", f"{code}/conf/settings-{{env}}.py"): {"version": 2, "content": "DB='ro'\n"},
                     ("vision-board", "prod", f"{code}/.env"): {"version": 1, "content": "PW=ro\n"}}

    def tearDown(self):
        self.tmp.cleanup()

    def spec(self, env, rows=None):
        async def current(service, e, key):
            return (self.rows if rows is None else rows).get((service, e, key))
        with mock.patch.object(envspec.service_configs, "current", current):
            return run(envspec.runtime_spec(self.reg, self.s, "vision-board", env))

    def test_prod_kernel_needs_a_mount_point_on_this_host(self):
        with self.assertRaises(Rejected) as cm:
            self.spec("prod")
        self.assertEqual(cm.exception.code, "config_missing")
        self.assertIn("挂载点", cm.exception.message)                 # 告诉人建个空文件
        self.assertIn("touch", cm.exception.message)

    def test_prod_kernel_binds_read_only_versions_over_test_files(self):
        (self.code / "conf" / "settings-prod.py").write_text("")       # 空文件当挂载点
        spec = self.spec("prod")
        binds = {dst: Path(src).read_text() for src, dst in spec["binds"]}
        self.assertEqual(binds, {f"{self.code}/conf/settings-prod.py": "DB='ro'\n", f"{self.code}/.env": "PW=ro\n"})
        self.assertIn(f"{self.code}/conf/settings-test.py", spec["hidden"])   # 本机（测试）的真实配置遮掉
        self.assertTrue(spec["protected"])
        test = self.spec("test")                                         # 测试的运行照旧用本机的真实配置
        self.assertEqual(test["binds"], [])
        self.assertNotIn(f"{self.code}/.env", test["hidden"])

    def test_unprotected_remote_env_still_uses_read_only_versions(self):
        """启动时会拒绝不受保护的代管环境；运行时也按受保护处理，不会拿本机的真实配置去跑。"""
        run(self.reg.put_config("envs", {"items": [{"name": "prod", "protected": False}, {"name": "test"}],
                                          "default": "test"}, "liyd"))
        (self.code / "conf" / "settings-prod.py").write_text("")
        spec = self.spec("prod")
        self.assertEqual(len(spec["binds"]), 2)
        with self.assertRaises(Rejected):
            self.spec("prod", rows={})                                  # 没填只读版就不跑

    def test_bash_masks_every_config_for_remote_runs(self):
        hidden, allow = run(envspec.sandbox_paths(self.reg, self.s, "prod"))
        self.assertIn(f"{self.code}/.env", hidden)
        self.assertIn(f"{self.code}/conf/settings-test.py", hidden)
        self.assertIn(str(self.code), allow)
        test_hidden, _ = run(envspec.sandbox_paths(self.reg, self.s, "test"))
        self.assertNotIn(f"{self.code}/.env", test_hidden)

    def test_prompt_says_where_it_runs(self):
        view = run(self.reg.service_view("vision-board", "prod"))
        local = view.prompt_block(True)
        remote = view.prompt_block(True, executor="board-test（test 的部署主机）")
        self.assertIn("你就在这个环境部署它的那台主机上", local)
        self.assertIn("代管执行", remote)
        self.assertIn("board-test（test 的部署主机）", remote)
        self.assertNotIn("你就在这个环境部署它的那台主机上", remote)
        self.assertIn("logs、host_status 不可用", remote)
        self.assertNotIn("日志（logs 工具", remote)                      # 不列不能用的日志
        self.assertIn("只读版", remote)


def remote_scope(view=None, local=False):
    return run_scope.RunScope(run_id="r", session_id="s", task="ask", env="prod", protected=True, local=local,
                              service="vision-board", view=view)


class RemoteToolsTest(unittest.TestCase):
    def setUp(self):
        self.reg = seeded_registry()
        self.s = settings(tempfile.mkdtemp(), env="test", remote_envs=["prod"])
        self.tb = Toolbox(self.s, notifier=None, registry=self.reg)
        self.view = run(self.reg.service_view("vision-board", "prod"))

    def call(self, tool, local=False, **kw):
        with run_scope.bind(remote_scope(self.view, local=local)):
            return run(self.tb._fns[tool](**kw))

    def test_logs_and_host_status_refuse(self):
        for name, kw in (("logs", {"name": "app"}), ("logs", {}), ("host_status", {})):
            out = self.call(name, **kw)
            self.assertTrue(out.startswith("[不可用] 这次是代管执行"), out)
            self.assertIn("不能当成 prod 的", out)

    def test_local_runs_keep_logs(self):
        out = self.call("logs", local=True)
        self.assertIn("可读的日志", out)

    def test_service_info_labels_the_code(self):
        with mock.patch("agent_platform.agent.tools.catalog.svc_inspect.git_state",
                        return_value={"commit": "abc1234", "branch": "master", "committed_at": "2026-10-01", "dirty": False}), \
                mock.patch("agent_platform.agent.tools.catalog.svc_inspect.config_status",
                           mock.AsyncMock(return_value=[])):
            out = self.call("service_info")
        self.assertIn("代管执行", out)
        self.assertIn("abc1234", out)
        self.assertIn("不是 prod 部署的版本", out)


class GardenerTest(unittest.TestCase):
    def test_remote_env_is_skipped(self):
        d = mock.Mock(settings=settings("/tmp/d", env="test", remote_envs=["prod"]))
        spec = mock.Mock(env="prod", service="vision-board")
        with mock.patch.object(pipeline, "run_gardener", mock.AsyncMock()) as g:
            out = run(pipeline._gardener(d, spec))
        g.assert_not_awaited()
        self.assertEqual(out["drift_expired"], 0)
        self.assertIn("代管", out["skipped"])


class ServingTest(unittest.TestCase):
    def test_remote_envs_count_as_serving(self):
        hosts = [{"host": "t1", "online": True, "env": "test", "services": ["vision-board"], "remote_envs": ["prod"]},
                 {"host": "t2", "online": True, "env": "test", "services": ["vision-dagster"], "remote_envs": []},
                 {"host": "old", "online": True, "env": "prod", "services": []}]          # 老版本报到没有 remote_envs
        self.assertEqual([h["host"] for h in workers.serving(hosts, "prod", "vision-board")], ["t1", "old"])
        self.assertEqual([h["host"] for h in workers.serving(hosts, "prod", "vision-dagster")], ["old"])


class McpContainmentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.s = settings(self.tmp.name, limits=LimitsConfig(enabled=True))
        self.cfg = {"transport": "stdio", "command": "node", "args": ["cli.js", "--output-dir", "{data}/scratch/b"],
                    "env": {"PLAYWRIGHT_BROWSERS_PATH": "{data}/b"}, "sandbox": True, "memory": "4G",
                    "allow": [self.tmp.name]}

    def tearDown(self):
        self.tmp.cleanup()

    def wrap(self, cfg, hidden=("/secret/.env",)):
        conns, _ = mcp_bridge.connections({"browser": cfg})
        return mcp_bridge.containment(self.s, set(hidden))("browser", cfg, conns["browser"])

    def test_sandboxed_and_memory_limited(self):
        with mock.patch.object(sb, "has_bwrap", return_value=True), \
                mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": "/run/user/1"}):
            out = self.wrap(self.cfg)
        argv = [out["command"], *out["args"]]
        self.assertEqual(argv[:3], ["systemd-run", "--user", "--scope"])
        self.assertIn("MemoryMax=4G", argv)
        i = argv.index("bwrap")
        self.assertLess(argv.index("MemoryMax=4G"), i)                  # scope 套在沙箱外面
        self.assertEqual(argv[argv.index("--") + 1:][-4:], ["node", "cli.js", "--output-dir",
                                                            f"{self.tmp.name}/scratch/b"])   # {data} 换成了数据目录
        self.assertIn("--die-with-parent", argv)
        self.assertNotIn("sandbox", out)                                # 平台字段不交给适配器
        self.assertEqual(out["env"]["PLAYWRIGHT_BROWSERS_PATH"], f"{self.tmp.name}/b")
        self.assertEqual(out["env"]["XDG_RUNTIME_DIR"], "/run/user/1")  # systemd-run 要找用户总线
        self.assertIn("--unsetenv", argv)                               # 进了沙箱再去掉

    def test_no_bwrap_with_require_sandbox_skips_the_server(self):
        with mock.patch.object(sb, "has_bwrap", return_value=False):
            self.assertIsNone(self.wrap(self.cfg))

    def test_plain_servers_untouched_except_data(self):
        plain = {"transport": "stdio", "command": "x", "args": ["{data}"]}
        out = self.wrap(plain)
        self.assertEqual((out["command"], out["args"]), ("x", [self.tmp.name]))

    def test_load_drops_skipped_servers(self):
        seen = {}

        async def fake_load(conns, owners):
            seen.update(conns)
            return [], []
        with mock.patch.object(mcp_bridge, "load_routed", fake_load):
            run(mcp_bridge.load_mcp_tools({"a": {"transport": "stdio", "command": "x"}, "b": {"transport": "stdio", "command": "y"}},
                                          lambda name, cfg, conn: None if name == "b" else conn))
        self.assertEqual(list(seen), ["a"])


if __name__ == "__main__":
    unittest.main()
