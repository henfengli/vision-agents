"""端到端平台测试：真实 PG + fake 模型/agent/Temporal。

覆盖：submit → 执行 → 沉淀全链路；纠正只取代最近一次 run 的记忆；
dedup；API 鉴权与 admin CRUD。
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

try:
    import pgserver
    HAS_PG = True
except ImportError:
    HAS_PG = False

from fakes import FakeTemporalClient, configure_fake_deps  # noqa: E402


def _settings(**over):
    from agent_platform.config import Settings
    base = dict(
        env="test",
        model={"url": "http://llm/v1", "name": "m", "tokens": ["t"]},
        db_dsn="postgresql://placeholder",
        dingtalk_relay_url="http://relay",
        dingtalk_token="x",
        viewer_base_url="http://viewer",
        bearer_token="test-token",
        scratch_dir=tempfile.mkdtemp(),
        domains={"board": {"code_paths": ["/tmp/board"]},
                 "dagster": {"code_paths": ["/tmp/dagster"]}},
    )
    base.update(over)
    return Settings.model_validate(base)


@unittest.skipUnless(HAS_PG, "pgserver 不可用")
class TestPlatform(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls._pg = pgserver.get_server(tempfile.mkdtemp())

    @classmethod
    def tearDownClass(cls):
        cls._pg.cleanup()

    async def asyncSetUp(self):
        from agent_platform.main import seed_if_empty
        from agent_platform.orchestration.tasks import TaskRegistry
        from agent_platform.orchestration.submitter import Submitter
        from agent_platform.store import db
        from agent_platform.store.definitions import DefinitionStore

        self.settings = _settings(db_dsn=self._pg.get_uri())
        await db.open_db(self.settings.db_dsn)
        async with db.pool().connection() as conn:
            await conn.execute(
                "TRUNCATE run_events, feedback, approvals, knowledge,"
                " cases, definitions, runs CASCADE")

        self.defs = DefinitionStore()
        await seed_if_empty(self.defs, "test")
        configure_fake_deps(self.settings, self.defs)
        self.tasks = TaskRegistry(self.defs, "test")
        self.temporal = FakeTemporalClient(execute=True)
        self.submitter = Submitter(self.temporal, self.tasks, "tq", "test")

    async def asyncTearDown(self):
        from agent_platform.store import db
        await db.close_db()

    # ---- 全链路 ----

    async def test_submit_runs_to_success(self):
        from agent_platform.store import runs
        result = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "total_fee 口径"}, "sdk")
        run = await runs.get(result["run_id"])
        self.assertEqual(run["status"], "success")
        self.assertIn("answer", run["output"])
        events = await runs.get_events(result["run_id"])
        self.assertTrue(any(e["kind"] == "llm" for e in events))

    async def test_dedup(self):
        payload = {"run_id": "dr1", "asset_key": "a", "error": "weird failure"}
        r1 = await self.submitter.submit("failure-analysis", payload, "sensor")
        r2 = await self.submitter.submit("failure-analysis", payload, "sensor")
        self.assertTrue(r2["dedup_hit"])
        self.assertEqual(r2["run_id"], r1["run_id"])

    async def test_unknown_task_rejected(self):
        from agent_platform.orchestration.submitter import TaskRejected
        with self.assertRaises(TaskRejected):
            await self.submitter.submit("no-such-task", {}, "sdk")

    async def test_env_gate(self):
        from agent_platform.orchestration.submitter import TaskRejected
        settings = _settings(db_dsn=self._pg.get_uri(), env="dev")
        from agent_platform.orchestration.submitter import Submitter
        sub = Submitter(self.temporal, self.tasks, "tq", "dev")
        with self.assertRaises(TaskRejected):  # failure-analysis 只在 prod/test
            await sub.submit("failure-analysis", {"error": "x"}, "sensor")

    async def test_resume_failed_run(self):
        from agent_platform.store import runs
        # 造一个 failed run：agent 抛错
        from agent_platform.orchestration import activities
        deps = activities._d()

        class _BoomEngine:
            def __init__(self, defs):
                self._defs = defs

            async def roles(self):
                from agent_platform.agent.roles import parse_defs
                return parse_defs(await self._defs.list_active("role", "test"))

            async def agent(self):
                raise RuntimeError("模型不可用")

        activities.configure(activities.Deps(
            settings=self.settings, engine=_BoomEngine(self.defs),
            model_pool=deps.model_pool, notifier=None, langfuse=None))
        result = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "q"}, "sdk")
        run = await runs.get(result["run_id"])
        self.assertEqual(run["status"], "failed")

        # 恢复正常引擎后续跑
        configure_fake_deps(self.settings, self.defs)
        resumed = await self.submitter.resume_run(result["run_id"])
        self.assertEqual(resumed["run_id"], result["run_id"])
        self.assertEqual(
            self.temporal.started[-1][2].get("id_reuse_policy").name,
            "ALLOW_DUPLICATE_FAILED_ONLY")

    # ---- 纠正反馈 ----

    async def test_correction_supersedes_only_latest(self):
        from agent_platform.store import knowledge, runs

        # 同一 session 两个 run：r1 沉淀 k_old，r2 沉淀 k_new
        configure_fake_deps(self.settings, self.defs,
                            model_content='[{"kind":"knowledge","key":"k_old",'
                                          '"content":"旧结论"}]')
        await self.submitter.submit(
            "data-qa", {"server": "board", "question": "q1"}, "sdk",
            session_id="s-corr")
        configure_fake_deps(self.settings, self.defs,
                            model_content='[{"kind":"knowledge","key":"k_new",'
                                          '"content":"新结论"}]')
        r2 = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "q2"}, "sdk",
            session_id="s-corr")

        # 纠正：distill 关停（空产出），只观察 supersede 效果
        configure_fake_deps(self.settings, self.defs, model_content="[]")
        result = await self.submitter.correct("s-corr", "方向错了", by="ops")
        self.assertTrue(
            await runs.session_exists(result["session_id"]))

        def entry(key):
            return knowledge.list_all("test", include_inactive=True)

        rows = {r["key"]: r for r in await entry("")}
        self.assertFalse(rows["k_old"]["superseded"])   # 更早的正确历史不误伤
        self.assertTrue(rows["k_new"]["superseded"])    # 只杀最近一次

    # ---- API ----

    async def test_api_endpoints(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app, make_api_router
        app = create_app(self.settings)
        app.include_router(make_api_router(self.settings, self.submitter,
                                           self.tasks, self.defs))
        client = TestClient(app)
        headers = {"Authorization": "Bearer test-token"}

        self.assertEqual(client.get("/health").json()["status"], "ok")
        self.assertEqual(client.post("/v1/tasks", json={
            "task_type": "data-qa",
            "input": {"server": "board", "question": "q"}}).status_code, 401)

        resp = client.post("/v1/tasks", headers=headers, json={
            "task_type": "data-qa",
            "input": {"server": "board", "question": "q"}})
        self.assertEqual(resp.status_code, 200)
        run_id = resp.json()["run_id"]
        run = client.get(f"/v1/tasks/{run_id}", headers=headers).json()
        self.assertEqual(run["status"], "success")

        # admin：任务定义写入 + 列表
        resp = client.post("/v1/admin/tasks", headers=headers, json={
            "name": "nightly", "definition": {"role": "ops_analyst"}})
        self.assertEqual(resp.status_code, 200)
        names = [t["name"] for t in
                 client.get("/v1/admin/tasks", headers=headers).json()]
        self.assertIn("nightly", names)

        # session 纠正：未知 session 404
        resp = client.post("/v1/sessions/nope/feedback", headers=headers,
                           json={"correction": "x"})
        self.assertEqual(resp.status_code, 404)

    async def test_viewer_pages_render(self):
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app
        from agent_platform.viewer import make_viewer_router
        app = create_app(self.settings)
        app.include_router(make_viewer_router(self.submitter, self.defs, "test"))
        client = TestClient(app)
        for path in ("/admin", "/memory", "/chat"):
            resp = client.get(path)
            self.assertEqual(resp.status_code, 200, path)

    # ---- Dagster 触发端 ----

    async def test_dagster_hook_rule_hit(self):
        from agent_platform.triggers import dagster_sensor

        class _Notifier:
            sent = []

            async def send_alert_card(self, title, content, *, dedup_hash):
                self.sent.append(title)

        router = dagster_sensor.make_router(self.submitter, _Notifier())
        route = next(r for r in router.routes if r.path == "/v1/hooks/dagster")
        resp = await route.endpoint(
            {"run_id": "x", "asset_key": "a", "error": "connection refused"})
        self.assertEqual(resp["status"], "rule_resolved")

    async def test_dagster_hook_agent_path(self):
        from agent_platform.triggers import dagster_sensor
        router = dagster_sensor.make_router(self.submitter, None)
        route = next(r for r in router.routes if r.path == "/v1/hooks/dagster")
        resp = await route.endpoint(
            {"run_id": "x", "asset_key": "orders_daily", "error": "bespoke xyz"})
        self.assertEqual(resp["status"], "queued")
        self.assertTrue(resp["session_id"].startswith("dagster:orders_daily:"))


if __name__ == "__main__":
    unittest.main()
