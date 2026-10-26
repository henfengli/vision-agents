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
        block = svc.view("b", "prod").prompt_block()
        self.assertIn("py 工具", block)
        self.assertIn("只读版", block)
        self.assertIn("logs 工具", block)


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
    """项目内核的规格：给 agent 的配置写到本机再 bind 到项目读的路径，别的环境的配置与 hidden 遮蔽，home 白名单。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        code = self.root / "code"
        (code / "conf").mkdir(parents=True)
        for env in ("prod", "test"):
            (code / "conf" / f"settings-{env}.py").write_text(f"DB='real-{env}'\n")
        (code / "compose.yaml").write_text("PW=x\n")
        self.reg = seeded_registry()
        run(self.reg.update("service", "vision-board", {
            "root": str(code), "configs": [f"{code}/conf/settings-{{env}}.py"], "hidden": [f"{code}/compose.yaml"],
            "python": "/opt/conda/envs/vision-board/bin/python",
        }, "test"))
        self.code = code
        self.s = settings(str(self.root / "data"), env="test", services=["vision-board"])

    def tearDown(self):
        self.tmp.cleanup()

    def _spec(self, rows: dict):
        async def current(service, env, key):
            return rows.get((service, env, key))
        with mock.patch.object(envspec.service_configs, "current", current):
            return run(envspec.runtime_spec(self.reg, self.s, "vision-board", "test"))

    def test_agent_config_is_bound_over_the_real_one(self):
        key = f"{self.code}/conf/settings-{{env}}.py"
        spec = self._spec({("vision-board", "test", key): {"version": 3, "content": "DB='readonly'\n"}})
        (src, dst), = spec["binds"]
        self.assertEqual(dst, f"{self.code}/conf/settings-test.py")
        self.assertEqual(Path(src).read_text(), "DB='readonly'\n")
        self.assertTrue(src.startswith(self.s.agent_conf_dir))
        self.assertIn(f"{self.code}/conf/settings-prod.py", spec["hidden"])
        self.assertIn(f"{self.code}/compose.yaml", spec["hidden"])
        self.assertNotIn(dst, spec["hidden"])
        self.assertIn(str(self.code), spec["allow"])
        self.assertIn("/opt/conda", spec["allow"])                   # conda 环境连同 conda 根目录
        changed = self._spec({("vision-board", "test", key): {"version": 4, "content": "DB='readonly2'\n"}})
        self.assertNotEqual(spec["digest"], changed["digest"])        # 配置换了版本，内核要重启

    def test_missing_agent_config_refuses(self):
        with self.assertRaises(Rejected) as cm:
            self._spec({})
        self.assertEqual(cm.exception.code, "config_missing")

    def test_other_env_or_service_refuses(self):
        for kw in ({"env": "prod"}, {"env": "test", "services": ["vision-dagster"]}):
            self.s = settings(str(self.root / "data"), **kw)
            with self.assertRaises(Rejected) as cm:
                self._spec({})
            self.assertEqual(cm.exception.code, "wrong_env")


if __name__ == "__main__":
    unittest.main()
