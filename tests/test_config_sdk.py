"""部署配置的 extends；SDK 的对话参数与等待计时。"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx
from support import REPO

from agent_platform import config

sys.path.insert(0, str(REPO / "sdk"))
from agent_client import client as sdk  # noqa: E402

SECRETS = {k: "x" for k in ("AGENT_DB_PASSWORD", "AGENT_DB_HOST", "AGENT_ROOT_TOKEN", "MODEL_TOKEN_A")}
NO_LOCAL = Path(tempfile.gettempdir()) / "agent-platform-no-local.yaml"


class ConfigTest(unittest.TestCase):
    def test_prod_profile(self):
        with mock.patch.dict(os.environ, SECRETS), mock.patch.object(config, "LOCAL_CONF", NO_LOCAL):
            s = config.load_settings("prod")
        self.assertTrue(s.limits.enabled)
        self.assertTrue(s.require_sandbox)
        self.assertEqual((s.env, s.services), ("", []))
        self.assertEqual(s.model.max_concurrency, 3)
        self.assertEqual(s.limits.kernel_memory, "30%")
        self.assertEqual(s.model.tokens, ["x"])                 # prod 的差异合并进 common 了
        self.assertFalse(s.otel.enabled)
        self.assertEqual(s.retention.checkpoints_days, 30)
        self.assertEqual(s.profile, "prod")

    def test_local_overlay_sets_env_and_services(self):
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp) / "local.yaml"
            local.write_text("env: test\nservices: [vision-board]\nlisten: {host: 0.0.0.0}\n")
            with mock.patch.dict(os.environ, SECRETS), mock.patch.object(config, "LOCAL_CONF", local):
                s = config.load_settings("prod")
        self.assertEqual((s.env, s.services, s.listen.host, s.listen.port), ("test", ["vision-board"], "0.0.0.0", 8100))
        self.assertTrue(s.serves("vision-board", "test"))
        self.assertTrue(s.serves(None, "test"))                  # 平台任务按环境算
        self.assertFalse(s.serves("vision-dagster", "test"))     # 另一台测试机上的
        self.assertFalse(s.serves("vision-board", "prod"))

    def test_extends_merges_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "base").mkdir()
            (root / "env").mkdir()
            (root / "base/common.yaml").write_text("model: {url: u, name: n, tokens: [t]}\n")
            (root / "env/a.yaml").write_text("db_dsn: d\nroot_token: r\nmodel: {name: a}\n")
            (root / "env/b.yaml").write_text("extends: a\nmodel: {tokens: [b]}\n")
            with mock.patch.object(config, "CONF_ROOT", root):
                s = config.load_settings("b")
        self.assertEqual((s.model.url, s.model.name, s.model.tokens), ("u", "a", ["b"]))

    def test_extends_cycle_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "base").mkdir()
            (root / "env").mkdir()
            (root / "base/common.yaml").write_text("model: {url: u, name: n, tokens: [t]}\n")
            (root / "env/a.yaml").write_text("extends: b\n")
            (root / "env/b.yaml").write_text("extends: a\n")
            with mock.patch.object(config, "CONF_ROOT", root), self.assertRaises(ValueError):
                config.load_settings("a")


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, s):
        self.now += s


class SdkTest(unittest.TestCase):
    def client(self, handler):
        c = sdk.AgentClient(service="board", env="test", url="http://agent")
        c._http = httpx.Client(base_url="http://agent", transport=httpx.MockTransport(handler))
        return c

    def test_ask_passes_per_call_scope_and_memory(self):
        seen = {}

        def handler(req):
            seen.update(json.loads(req.content))
            events = [{"type": "run", "session_id": "s1"},
                      {"type": "final", "status": "success", "output": {"answer": "42"}}]
            return httpx.Response(200, text="".join(f"data: {json.dumps(e)}\n\n" for e in events))

        c = self.client(handler)
        self.assertEqual(c.ask("q", env="prod", subtask="t1", recall=False), "42")
        self.assertEqual((seen["service"], seen["env"], seen["subtask"]), ("board", "prod", "t1"))
        self.assertEqual(seen["memory"], {"recall": False, "save": None})
        self.assertEqual(c.session_id, "s1")

    def test_run_wait_counts_server_side_wait(self):
        clock = FakeClock()

        def handler(req):
            if req.method == "POST":
                clock.now += 3                     # 服务端先等了 3 秒才回执
                return httpx.Response(202, json={"run_id": "r1", "session_id": "r1", "status": "running"})
            return httpx.Response(200, json={"run_id": "r1", "status": "running"})

        with mock.patch.object(sdk, "time", clock):
            run = self.client(handler).run("t", wait=5)
        self.assertEqual(run["status"], "running")
        self.assertLessEqual(clock.now, 5.0)


if __name__ == "__main__":
    unittest.main()
