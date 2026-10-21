"""服务×环境视图、闸门、进程控制器：{env} 渲染、只看不起、配置与密钥遮蔽。"""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path

from support import seeded_registry, settings

from agent_platform.config import ProcessControlConfig
from agent_platform.domain import Rejected, ServiceDef
from agent_platform.orchestration import gates
from agent_platform.services.control import ProcessController, _ensure_mount_points

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
                         [{"canonical": "/srv/svc/b/code/test/.env", "path": "/srv/svc/b/conf/test/.env"}])

    def test_startable_follows_env_default_unless_service_overrides(self):
        svc = ServiceDef.model_validate({"envs": {"test": {"startable": False}, "prod": {"startable": True}}})
        self.assertTrue(svc.view("b", "prod", startable_default=False).startable)
        self.assertFalse(svc.view("b", "test", startable_default=True).startable)
        self.assertFalse(ServiceDef().view("b", "prod", startable_default=False).startable)
        self.assertTrue(ServiceDef().view("b", "dev", startable_default=True).startable)

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

    def test_prompt_block_tells_agent_when_view_only(self):
        svc = ServiceDef.model_validate({"processes": {"web": {"cmd": ["x"]}}})
        self.assertIn("只看不起", svc.view("b", "prod", False).prompt_block())
        self.assertIn("可启停进程", svc.view("b", "test", True).prompt_block())


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.reg = seeded_registry()

    def test_every_seed_is_valid(self):
        import yaml
        from support import SEEDS
        for kind, path in (("task", "tasks.yaml"), ("role", "roles.yaml"), ("policy", "policies.yaml")):
            wanted = set(yaml.safe_load((SEEDS / path).read_text(encoding="utf-8")))
            got = {e.name for e in run(self.reg.entries(kind))}
            self.assertEqual(wanted, got, kind)
        self.assertEqual({e.name for e in run(self.reg.services())}, {"board", "dagster", "config-center"})

    def test_seed_placeholders_are_stored_not_expanded(self):
        board = run(self.reg.store.get("service", "board"))["definition"]
        self.assertIn("${BOARD_RO_PASSWORD}", board["envs"]["prod"]["readonly_dsn"])
        channels = run(self.reg.store.get("config", "notifications"))["definition"]["channels"]
        self.assertEqual(channels["default"]["token"], "${DINGTALK_ACCESS_TOKEN}")

    def test_prod_is_view_only_out_of_the_box(self):
        self.assertFalse(run(self.reg.service_view("board", "prod")).startable)
        self.assertTrue(run(self.reg.service_view("board", "test")).startable)

    def test_unknown_env_is_rejected(self):
        with self.assertRaises(Rejected) as cm:
            run(self.reg.service_view("board", "stage"))
        self.assertEqual(cm.exception.code, "unknown_env")

    def test_gate_rejects_disabled_service_env(self):
        task = run(self.reg.task("data-qa")).spec
        run(gates.check_switches(self.reg, task_name="data-qa", task=task, service="config-center", env="test"))
        with self.assertRaises(Rejected) as cm:
            run(gates.check_switches(self.reg, task_name="data-qa", task=task, service="config-center", env="dev"))
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
        run(self.reg.update("service", "board", {
            "root": f"{self.root}/code/{{env}}",
            "configs": [{"canonical": f"{self.root}/code/{{env}}/.env", "template": f"{self.root}/conf/{{env}}/.env"}],
        }, "test"))
        self.ctl = ProcessController(settings(str(self.root / "data"), hidden_paths=[f"{self.root}/secrets"]), self.reg)

    def tearDown(self):
        self.tmp.cleanup()

    def test_spec_binds_own_env_and_masks_the_rest(self):
        svc = run(self.reg.service("board")).spec
        spec = run(self.ctl.build_spec("board", svc, "test", "server"))
        r = str(self.root)
        self.assertEqual(spec["binds"], [[f"{r}/conf/test/.env", f"{r}/code/test/.env"]])
        for hidden in (f"{r}/conf/prod/.env", f"{r}/conf/dev/.env", f"{r}/code/prod/.env", f"{r}/secrets"):
            self.assertIn(hidden, spec["masks"])
        self.assertNotIn(f"{r}/conf/test/.env", spec["masks"])
        self.assertEqual(spec["workdir"], f"{r}/code/test")
        self.assertEqual((spec["port"], spec["env_vars"]), (8081, {"PORT": "8081"}))

    def test_view_only_env_refuses_start(self):
        with self.assertRaises(Rejected) as cm:
            run(self.ctl.ensure_startable("board", "prod"))
        self.assertEqual(cm.exception.code, "start_not_allowed")
        run(self.ctl.ensure_startable("board", "test"))

    def test_service_can_open_up_a_view_only_env(self):
        envs = run(self.reg.store.get("service", "board"))["definition"]["envs"]
        envs["prod"]["startable"] = True
        run(self.reg.update("service", "board", {"envs": envs}, "test"))
        run(self.ctl.ensure_startable("board", "prod"))

    def test_backend_off_refuses(self):
        ctl = ProcessController(settings(str(self.root / "data"), process_control=ProcessControlConfig(backend="off")),
                                self.reg)
        with self.assertRaises(Rejected) as cm:
            run(ctl.ensure_startable("board", "test"))
        self.assertEqual(cm.exception.code, "process_control_off")

    def test_mount_points_are_created(self):
        target = self.root / "code" / "test" / ".env"
        _ensure_mount_points([str(target)])
        self.assertTrue(target.is_file())
        self.assertEqual(os.path.getsize(target), 0)


if __name__ == "__main__":
    unittest.main()
