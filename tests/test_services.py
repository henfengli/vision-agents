"""服务×环境视图、闸门、进程控制器：{env} 渲染、按环境启用、配置与密钥遮蔽。"""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from support import seeded_registry, settings

from agent_platform.config import ProcessControlConfig
from agent_platform.domain import Rejected, ServiceDef
from agent_platform.orchestration import gates
from agent_platform.services.control import ProcessController, ensure_mount_points

run = asyncio.run


class ServiceViewTest(unittest.TestCase):
    def test_env_placeholder_renders_in_every_path(self):
        svc = ServiceDef.model_validate({
            "root": "/srv/svc/b/code/{env}",
            "configs": [{"canonical": "/srv/svc/b/code/{env}/.env", "template": "/srv/svc/b/conf/{env}/.env"}]})
        v = svc.view("b", "test")
        self.assertEqual(v.root, "/srv/svc/b/code/test")
        self.assertEqual(v.code_paths, ["/srv/svc/b/code/test"])
        self.assertEqual(v.config_files,
                         [{"canonical": "/srv/svc/b/code/test/.env", "path": "/srv/svc/b/conf/test/.env",
                           "upstream": ".env"}])          # 固定路径在代码目录里：上游默认是仓库里的同一个文件

    def test_python_and_env_vars_render_per_env(self):
        svc = ServiceDef.model_validate({"python": "/srv/svc/b/venv/{env}/bin/python",
                                         "env_vars": {"DAGSTER_HOME": "/srv/svc/b/code/{env}"},
                                         "envs": {"dev": {"python": "/usr/bin/python3"}}})
        self.assertEqual(svc.view("b", "test").python, "/srv/svc/b/venv/test/bin/python")
        self.assertEqual(svc.view("b", "test").env_vars, {"DAGSTER_HOME": "/srv/svc/b/code/test"})
        self.assertEqual(svc.view("b", "dev").python, "/usr/bin/python3")
        self.assertEqual(ServiceDef().view("b", "prod").python, "python3")

    def test_ref_override_per_env(self):
        svc = ServiceDef.model_validate({"repo": "git@x:b.git", "ref": "main", "envs": {"prod": {"ref": "release"}}})
        self.assertEqual(svc.view("b", "prod").ref, "release")
        self.assertEqual(svc.view("b", "test").ref, "main")

    def test_secret_paths_cover_both_ends_of_every_env(self):
        svc = ServiceDef.model_validate({"configs": [{"canonical": "/c/{env}/.env", "template": "/t/{env}/.env"}]})
        self.assertEqual(svc.secret_paths(["prod", "test"]),
                         {"/c/prod/.env", "/c/test/.env", "/t/prod/.env", "/t/test/.env"})

    def test_process_env_vars_refuse_placeholders(self):
        with self.assertRaises(ValueError):
            ServiceDef.model_validate({"processes": {"web": {"cmd": ["x"], "env_vars": {"DB": "${PW}"}}}})

    def test_prompt_block_points_to_kernel_and_processes(self):
        svc = ServiceDef.model_validate({"processes": {"web": {"cmd": ["x"]}}})
        block = svc.view("b", "prod").prompt_block()
        self.assertIn("py 工具", block)
        self.assertIn("可启停进程", block)


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
        self.assertIn("172.24.17.66", run(self.reg.service_view("vision-board", "dev")).databases["ck"])
        self.assertEqual(view.env_vars["DJANGO_SETTINGS_MODULE"], "vision_board.settings-prod")
        self.assertEqual(view.config_files[0]["canonical"], "/srv/svc/vision-board/code/prod/vision_board/settings-prod.py")
        channels = run(self.reg.store.get("config", "notifications"))["definition"]["channels"]
        self.assertEqual(channels["default"]["token"], "${DINGTALK_ACCESS_TOKEN}")

    def test_unknown_env_is_rejected(self):
        with self.assertRaises(Rejected) as cm:
            run(self.reg.service_view("vision-board", "stage"))
        self.assertEqual(cm.exception.code, "unknown_env")

    def test_gate_rejects_disabled_service_env(self):
        run(self.reg.update("service", "vision-web", {"envs": {"dev": {"enabled": False}}}, "test"))
        task = run(self.reg.task("data-qa")).spec
        run(gates.check_switches(self.reg, task_name="data-qa", task=task, service="vision-web", env="test"))
        with self.assertRaises(Rejected) as cm:
            run(gates.check_switches(self.reg, task_name="data-qa", task=task, service="vision-web", env="dev"))
        self.assertEqual(cm.exception.code, "service_env_disabled")


class ControllerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for env in ("prod", "test", "dev"):
            (self.root / "conf" / env).mkdir(parents=True)
            (self.root / "conf" / env / ".env").write_text(f"DB={env}\n")
        (self.root / "code" / "prod").mkdir(parents=True)
        (self.root / "code" / "prod" / ".env").write_text("")
        (self.root / "secrets").mkdir()
        self.reg = seeded_registry()
        run(self.reg.update("service", "vision-board", {
            "root": f"{self.root}/code/{{env}}",
            "configs": [{"canonical": f"{self.root}/code/{{env}}/.env", "template": f"{self.root}/conf/{{env}}/.env"}],
        }, "test"))
        self.ctl = ProcessController(settings(str(self.root / "data"), hidden_paths=[f"{self.root}/secrets"]), self.reg)

    def tearDown(self):
        self.tmp.cleanup()

    def test_spec_binds_own_env_and_masks_the_rest(self):
        svc = run(self.reg.service("vision-board")).spec
        spec = run(self.ctl.build_spec("vision-board", svc, "test", "server"))
        r = str(self.root)
        self.assertEqual(spec["binds"], [[f"{r}/conf/test/.env", f"{r}/code/test/.env"]])
        for hidden in (f"{r}/conf/prod/.env", f"{r}/conf/dev/.env", f"{r}/code/prod/.env", f"{r}/secrets"):
            self.assertIn(hidden, spec["masks"])
        self.assertNotIn(f"{r}/conf/test/.env", spec["masks"])
        self.assertEqual(spec["workdir"], f"{r}/code/test")
        self.assertEqual((spec["port"], spec["env_vars"]), (8181, {"DJANGO_SETTINGS_MODULE": "vision_board.settings-test"}))
        self.assertEqual(spec["argv"][-2:], ["127.0.0.1:8181", "--noreload"])

    def test_every_enabled_env_can_start(self):
        for env in ("prod", "test", "dev"):
            run(self.ctl.ensure_startable("vision-board", env))

    def test_disabled_env_refuses_start(self):
        run(self.reg.update("service", "vision-web", {"envs": {"dev": {"enabled": False}}}, "test"))
        with self.assertRaises(Rejected) as cm:
            run(self.ctl.ensure_startable("vision-web", "dev"))
        self.assertEqual(cm.exception.code, "service_env_disabled")

    def test_backend_off_refuses(self):
        ctl = ProcessController(settings(str(self.root / "data"), process_control=ProcessControlConfig(backend="off")),
                                self.reg)
        with self.assertRaises(Rejected) as cm:
            run(ctl.ensure_startable("vision-board", "test"))
        self.assertEqual(cm.exception.code, "process_control_off")

    def test_systemd_backend_uses_user_manager(self):
        calls = []

        async def fake_exec(*argv, timeout=20.0):
            calls.append(argv[:2])
            return 0, ""

        ctl = ProcessController(settings(str(self.root / "data"), process_control=ProcessControlConfig(backend="systemd")),
                                self.reg)
        with mock.patch("agent_platform.services.control._exec", fake_exec):
            run(ctl.logs("vision-board", "test", "server"))
            run(ctl._live_state("vision-board", "test", "server", None))
        self.assertEqual(calls, [("journalctl", "--user"), ("systemctl", "--user")])

    def test_mount_points_are_created(self):
        target = self.root / "code" / "test" / ".env"
        ensure_mount_points([str(target)])
        self.assertTrue(target.is_file())
        self.assertEqual(os.path.getsize(target), 0)


if __name__ == "__main__":
    unittest.main()
