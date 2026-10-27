"""服务×环境视图、闸门、内核规格：{env} 与 ~ 渲染、按环境启用、给 agent 的配置就位与遮蔽、只在负责的主机上起内核。"""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from support import seeded_registry, settings

from agent_platform.domain import Rejected, ServiceDef
from agent_platform.orchestration import gates
from agent_platform.services import envspec

run = asyncio.run


class ServiceViewTest(unittest.TestCase):
    def test_env_placeholder_renders_in_every_path(self):
        svc = ServiceDef.model_validate({"root": "/srv/b", "configs": ["/srv/b/settings-{env}.py"],
                                         "logs": {"app": "/srv/b/{env}.log", "web": "docker:b-web"}})
        v = svc.view("b", "test")
        self.assertEqual(v.root, "/srv/b")
        self.assertEqual(v.code_paths, ["/srv/b"])
        self.assertEqual(v.config_files, [{"key": "/srv/b/settings-{env}.py", "path": "/srv/b/settings-test.py"}])
        self.assertEqual(v.logs, {"app": "/srv/b/test.log", "web": "docker:b-web"})

    def test_env_overrides_root_and_logs(self):
        svc = ServiceDef.model_validate({"root": "/srv/b", "logs": {"app": "/srv/b/a.log", "nginx": "/var/log/n.log"},
                                         "envs": {"prod": {"node": "p1", "root": "/data/b", "logs": {"nginx": ""}}}})
        prod, test = svc.view("b", "prod"), svc.view("b", "test")      # 旧定义里的 node 读进来时忽略
        self.assertEqual((prod.root, list(prod.logs)), ("/data/b", ["app"]))
        self.assertEqual(test.root, "/srv/b")

    def test_old_config_shape_is_read(self):
        svc = ServiceDef.model_validate({"configs": [{"canonical": "/c/{env}/.env", "template": "/t/{env}/.env"}]})
        self.assertEqual(svc.configs, ["/c/{env}/.env"])

    def test_python_and_env_vars_render_per_env(self):
        svc = ServiceDef.model_validate({"python": "/srv/b/venv/{env}/bin/python",
                                         "env_vars": {"DJANGO_SETTINGS_MODULE": "b.settings-{env}"},
                                         "envs": {"prod": {"python": "/usr/bin/python3"}}})
        self.assertEqual(svc.view("b", "test").python, "/srv/b/venv/test/bin/python")
        self.assertEqual(svc.view("b", "test").env_vars, {"DJANGO_SETTINGS_MODULE": "b.settings-test"})
        self.assertEqual(svc.view("b", "prod").python, "/usr/bin/python3")
        self.assertEqual(ServiceDef().view("b", "prod").python, "python3")

    def test_secret_paths_cover_configs_and_hidden_of_every_env(self):
        svc = ServiceDef.model_validate({"configs": ["/c/{env}/.env"], "hidden": ["/c/compose.yaml"]})
        self.assertEqual(svc.secret_paths(["prod", "test"]), {"/c/prod/.env", "/c/test/.env", "/c/compose.yaml"})

    def test_env_vars_refuse_placeholders_and_bad_logs(self):
        with self.assertRaises(ValueError):
            ServiceDef.model_validate({"env_vars": {"DB": "${PW}"}})
        with self.assertRaises(ValueError):
            ServiceDef.model_validate({"logs": {"app": "relative.log"}})

    def test_prompt_block_points_to_kernel_and_logs(self):
        svc = ServiceDef.model_validate({"configs": ["/c/.env"], "logs": {"app": "/c/a.log"}})
        prod = svc.view("b", "prod").prompt_block(protected=True)
        self.assertIn("py 工具", prod)
        self.assertIn("只读版", prod)
        self.assertIn("logs 工具", prod)
        test = svc.view("b", "test").prompt_block(protected=False)
        self.assertIn("真实配置", test)                  # 测试：真实配置 + 提示词要求库只读
        self.assertIn("数据库只读", test)
        self.assertNotIn("只读版", test)


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.reg = seeded_registry()

    def test_every_seed_is_valid(self):
        import yaml
        from support import SEEDS
        for kind, path in (("task", "tasks.yaml"), ("role", "roles.yaml")):
            wanted = set(yaml.safe_load((SEEDS / path).read_text(encoding="utf-8")))
            got = {e.name for e in run(self.reg.entries(kind))}
            self.assertEqual(wanted, got, kind)
        self.assertEqual({e.name for e in run(self.reg.services())}, {"vision-board", "vision-dagster", "vision-web"})

    def test_seed_placeholders_are_stored_not_expanded(self):
        board = run(self.reg.store.get("service", "vision-board"))["definition"]
        self.assertIn("${CK_PROD_RO_PASSWORD}", board["envs"]["prod"]["databases"]["ck"])
        view = run(self.reg.service_view("vision-board", "prod"))
        self.assertIn("172.168.0.125", view.databases["ck"])
        self.assertIn("172.24.17.66", run(self.reg.service_view("vision-board", "test")).databases["ck"])
        self.assertEqual(view.env_vars["DJANGO_SETTINGS_MODULE"], "vision_board.settings-prod")
        self.assertEqual(board["root"], "~/deploy/vision-board")          # 库里存原样，用时才展开 ~
        self.assertEqual(view.config_files[0]["path"],
                         os.path.expanduser("~/deploy/vision-board/vision_board/settings-prod.py"))
        channels = run(self.reg.store.get("config", "notifications"))["definition"]["channels"]
        self.assertEqual(channels["default"]["token"], "${DINGTALK_ACCESS_TOKEN}")

    def test_unknown_env_is_rejected(self):
        with self.assertRaises(Rejected) as cm:
            run(self.reg.service_view("vision-board", "stage"))
        self.assertEqual(cm.exception.code, "unknown_env")

    def test_gate_rejects_disabled_service_env(self):
        run(self.reg.update("service", "vision-web", {"envs": {"prod": {"enabled": False}}}, "test"))
        task = run(self.reg.task("data-qa")).spec
        run(gates.check_switches(self.reg, task_name="data-qa", task=task, service="vision-web", env="test"))
        with self.assertRaises(Rejected) as cm:
            run(gates.check_switches(self.reg, task_name="data-qa", task=task, service="vision-web", env="prod"))
        self.assertEqual(cm.exception.code, "service_env_disabled")


class EnvSpecTest(unittest.TestCase):
    """项目内核与 bash 的规格：生产把给 agent 的配置 bind 到项目读的路径、所有配置与 hidden 遮蔽；
    测试直接用真实配置、只遮生产的；home 白名单。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        code = self.root / "code"
        (code / "conf").mkdir(parents=True)
        for env in ("prod", "test"):
            (code / "conf" / f"settings-{env}.py").write_text(f"DB='real-{env}'\n")
        (code / "compose.yaml").write_text("PW=x\n")
        conda = self.root / "conda"
        (conda / "conda-meta").mkdir(parents=True)
        (conda / "envs" / "vision-board" / "bin").mkdir(parents=True)
        self.conda = conda
        self.reg = seeded_registry()
        run(self.reg.update("service", "vision-board", {
            "root": str(code), "configs": [f"{code}/conf/settings-{{env}}.py"], "hidden": [f"{code}/compose.yaml"],
            "python": str(conda / "envs" / "vision-board" / "bin" / "python"),
            "logs": {"app": f"{code}/app.log", "web": "docker:board-web"},
        }, "test"))
        self.code = code
        self.key = f"{code}/conf/settings-{{env}}.py"
        self.s = settings(str(self.root / "data"))          # 开发机：什么环境都执行

    def tearDown(self):
        self.tmp.cleanup()

    def _spec(self, rows: dict, env: str):
        async def current(service, e, key):
            return rows.get((service, e, key))
        with mock.patch.object(envspec.service_configs, "current", current):
            return run(envspec.runtime_spec(self.reg, self.s, "vision-board", env))

    def test_prod_binds_agent_config_over_the_real_one(self):
        spec = self._spec({("vision-board", "prod", self.key): {"version": 3, "content": "DB='readonly'\n"}}, "prod")
        (src, dst), = spec["binds"]
        self.assertEqual(dst, f"{self.code}/conf/settings-prod.py")
        self.assertEqual(Path(src).read_text(), "DB='readonly'\n")
        self.assertTrue(src.startswith(self.s.agent_conf_dir))
        self.assertIn(f"{self.code}/conf/settings-test.py", spec["hidden"])
        self.assertIn(f"{self.code}/compose.yaml", spec["hidden"])
        self.assertNotIn(dst, spec["hidden"])
        self.assertIn(str(self.code), spec["allow"])
        self.assertIn(str(self.conda), spec["allow"])                # conda 环境连同 conda 根目录（有 conda-meta）
        self.assertEqual(spec["sinks"], [f"{self.code}/app.log"])    # 项目自己写的日志：内核里换成可写的 /dev/null
        self.assertIn(os.path.expanduser("~/.config/agent-platform"), spec["hidden"])   # 平台密钥目录总是遮
        changed = self._spec({("vision-board", "prod", self.key): {"version": 4, "content": "DB='readonly2'\n"}}, "prod")
        self.assertNotEqual(spec["digest"], changed["digest"])        # 配置换了版本，内核要重启

    def test_prod_without_agent_config_refuses(self):
        with self.assertRaises(Rejected) as cm:
            self._spec({}, "prod")
        self.assertEqual(cm.exception.code, "config_missing")

    def test_test_env_uses_the_real_config(self):
        spec = self._spec({}, "test")                                  # 不用填只读版
        self.assertEqual(spec["binds"], [])
        self.assertFalse(spec["protected"])
        self.assertNotIn(f"{self.code}/conf/settings-test.py", spec["hidden"])
        self.assertNotIn(f"{self.code}/compose.yaml", spec["hidden"])
        self.assertIn(f"{self.code}/conf/settings-prod.py", spec["hidden"])   # 生产的配置照样遮
        self.assertIn(self.s.agent_conf_dir, spec["hidden"])

    def test_bash_sandbox_masks_by_env(self):
        prod, _ = run(envspec.sandbox_paths(self.reg, self.s, "prod"))
        test, _ = run(envspec.sandbox_paths(self.reg, self.s, "test"))
        settings_test, settings_prod = f"{self.code}/conf/settings-test.py", f"{self.code}/conf/settings-prod.py"
        self.assertTrue({settings_test, settings_prod, f"{self.code}/compose.yaml"} <= set(prod))
        self.assertIn(settings_prod, test)
        self.assertNotIn(settings_test, test)
        self.assertNotIn(f"{self.code}/compose.yaml", test)
        dagster_env = os.path.expanduser("~/deploy/vision-dagster/.env")   # 没有 {env}：测试机上就是测试那份
        self.assertIn(dagster_env, prod)
        self.assertNotIn(dagster_env, test)

    def test_other_env_or_service_refuses(self):
        for kw in ({"env": "prod"}, {"env": "test", "services": ["vision-dagster"]}):
            self.s = settings(str(self.root / "data"), **kw)
            with self.assertRaises(Rejected) as cm:
                self._spec({}, "test")
            self.assertEqual(cm.exception.code, "wrong_env")


if __name__ == "__main__":
    unittest.main()
