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
        assets_dir=tempfile.mkdtemp(),
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
                " cases, definitions, artifacts, runs, assets CASCADE")

        self.defs = DefinitionStore()
        from agent_platform.config import DomainConfig
        dagster_pack = DomainConfig(
            code_paths=["/tmp/dagster"],
            rules=[{"pattern": r"connection.*(refused|timeout|reset)",
                    "category": "infra",
                    "conclusion": "连接失败，检查服务存活"}],
            seed_tasks=[{"name": "failure-analysis", "role": "ops_analyst",
                         "triggers": ["dagster_sensor"],
                         "input_schema": {"run_id": "str", "asset_key": "str",
                                          "error": "str"},
                         "output_channel": "dingtalk", "dedup_key": "run_id",
                         "dedup_window_s": 600, "timeout_s": 300,
                         "env_gate": ["prod", "test"]}])
        await seed_if_empty(self.defs, "test",
                            domains={"dagster": dagster_pack})
        configure_fake_deps(self.settings, self.defs)
        self.tasks = TaskRegistry(self.defs, "test")
        self.temporal = FakeTemporalClient(execute=True)
        self.submitter = Submitter(self.temporal, self.tasks, "tq", "test",
                                   defs=self.defs)
        self.dagster_rules = dagster_pack.rules

    async def asyncTearDown(self):
        from agent_platform.store import db
        await db.close_db()

    # ---- 全链路 ----

    async def test_log_event_seq_unique_under_concurrency(self):
        """资产图层内并行的多节点同时写事件：seq 不得撞号（SSE 按 seq 增量拉取）。"""
        import asyncio

        from agent_platform.store import runs
        r = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "q"}, "sdk")
        await asyncio.gather(*(runs.log_event(
            r["run_id"], "note", {"stage": "race", "i": i}) for i in range(10)))
        seqs = [e["seq"] for e in await runs.get_events(r["run_id"])]
        self.assertEqual(len(seqs), len(set(seqs)))  # 无重复
        self.assertEqual(seqs, sorted(seqs))

    async def test_submit_runs_to_success(self):
        from agent_platform.store import runs
        result = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "total_fee 口径"}, "sdk")
        run = await runs.get(result["run_id"])
        self.assertEqual(run["status"], "success")
        self.assertIn("answer", run["output"])
        events = await runs.get_events(result["run_id"])
        self.assertTrue(any(e["kind"] == "llm" for e in events))

    async def test_run_pins_definition_versions(self):
        """谱系固定：run 记录执行时刻的定义版本，历史 run 不被新版本改写。"""
        from agent_platform.store import runs
        r1 = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "q1"}, "sdk")
        run1 = await runs.get(r1["run_id"])
        self.assertEqual((run1["task_version"], run1["role_version"]), (1, 1))

        await self.defs.put("role", "test", "data_searcher",
                            {"description": "v2", "domains": ["board"],
                             "tools": ["bash"], "prompt": "p2"})
        r2 = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "q2"}, "sdk")
        run2 = await runs.get(r2["run_id"])
        self.assertEqual(run2["role_version"], 2)
        run1 = await runs.get(r1["run_id"])
        self.assertEqual(run1["role_version"], 1)  # 历史 run 的版本不被改写

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

    # ---- 重跑 / 节点级反馈（v4.11.0） ----

    async def test_rerun_success_opens_new_run_skipping_dedup(self):
        from agent_platform.store import runs
        payload = {"run_id": "rr1", "asset_key": "a", "error": "weird failure"}
        r1 = await self.submitter.submit("failure-analysis", payload, "sensor")
        # 同输入窗口内直接 submit 会去重；人工重跑必须真跑一个新 run
        dup = await self.submitter.submit("failure-analysis", payload, "sensor")
        self.assertTrue(dup["dedup_hit"])
        again = await self.submitter.rerun(r1["run_id"])
        self.assertNotEqual(again["run_id"], r1["run_id"])
        self.assertFalse(again["dedup_hit"])
        run = await runs.get(again["run_id"])
        self.assertEqual(run["trigger_source"], "rerun")
        self.assertEqual(run["status"], "success")

    async def test_rerun_failed_resumes_same_id(self):
        from agent_platform.orchestration import activities
        from agent_platform.store import runs
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
        self.assertEqual((await runs.get(result["run_id"]))["status"], "failed")

        configure_fake_deps(self.settings, self.defs)
        out = await self.submitter.rerun(result["run_id"])
        self.assertEqual(out["run_id"], result["run_id"])  # 断点续跑：同 id
        self.assertEqual(
            self.temporal.started[-1][2].get("id_reuse_policy").name,
            "ALLOW_DUPLICATE_FAILED_ONLY")

    async def test_rerun_rejects_in_flight(self):
        from agent_platform.orchestration.submitter import TaskRejected
        from agent_platform.store import db, runs
        await runs.create("run-inflight", "data-qa", "data_searcher", None,
                          "sdk", "", {})
        async with db.pool().connection() as conn:
            await conn.execute(
                "UPDATE runs SET status='running' WHERE run_id='run-inflight'")
        with self.assertRaises(TaskRejected):
            await self.submitter.rerun("run-inflight")
        with self.assertRaises(TaskRejected):
            await self.submitter.rerun("no-such-run")

    async def test_step_feedback_stored(self):
        from agent_platform.store import db, feedback
        r = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "q"}, "sdk")
        await feedback.add_step(r["run_id"], 3, -1, "这步查错表了")
        async with db.pool().connection() as conn:
            cur = await conn.execute(
                "SELECT kind, score, step_seq, comment FROM feedback"
                " WHERE run_id=%s", (r["run_id"],))
            row = await cur.fetchone()
        self.assertEqual(tuple(row), ("step", -1, 3, "这步查错表了"))
        with self.assertRaises(ValueError):
            await feedback.add_step(r["run_id"], 3, 0)

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
        await self.submitter.submit(
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

        # 再保存产生 v2：响应带上一版本号与近 24h 影响面字段
        resp = client.post("/v1/admin/tasks", headers=headers, json={
            "name": "nightly",
            "definition": {"role": "ops_analyst", "timeout_s": 600}})
        data = resp.json()
        self.assertEqual(data["version"], 2)
        self.assertEqual(data["previous_version"], 1)
        self.assertIn("recent_runs_on_previous", data)

        # session 纠正：未知 session 404
        resp = client.post("/v1/sessions/nope/feedback", headers=headers,
                           json={"correction": "x"})
        self.assertEqual(resp.status_code, 404)

    def _api_client(self, submitter=None):
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app, make_api_router
        app = create_app(self.settings)
        app.include_router(make_api_router(self.settings,
                                           submitter or self.submitter,
                                           self.tasks, self.defs))
        return TestClient(app), {"Authorization": "Bearer test-token"}

    async def test_api_rejections_are_4xx(self):
        """客户端错误（未知任务/env_gate 拒绝）返 400 + error_code，不是 500。"""
        client, headers = self._api_client()
        resp = client.post("/v1/tasks", headers=headers, json={
            "task_type": "no-such-task", "input": {}})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["error_code"], "task_rejected")
        # env_gate：failure-analysis 只允许 prod/test
        resp = client.post("/v1/tasks", headers=headers, json={
            "task_type": "failure-analysis", "env": "staging",
            "input": {"run_id": "r", "asset_key": "a", "error": "x"}})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["error_code"], "task_rejected")

    async def test_run_view_and_list_filters(self):
        """单 run 走字段白名单视图；列表透传过滤 + keyset 游标信封。"""
        client, headers = self._api_client()
        resp = client.post("/v1/tasks", headers=headers, json={
            "task_type": "data-qa",
            "input": {"server": "board", "question": "q"}})
        run_id = resp.json()["run_id"]
        run = client.get(f"/v1/tasks/{run_id}", headers=headers).json()
        self.assertEqual(run["status"], "success")
        self.assertEqual(run["run_id"], run_id)
        self.assertNotIn("dedup_key", run)      # 内部字段不外泄
        listed = client.get("/v1/runs?status=success&task=data-qa",
                            headers=headers).json()
        self.assertEqual(listed["total"], 1)
        self.assertEqual(listed["runs"][0]["run_id"], run_id)
        self.assertIn("next_cursor", listed)     # 信封字段齐
        self.assertEqual(client.get(
            "/v1/runs?status=failed", headers=headers).json()["total"], 0)

    async def test_run_events_endpoint(self):
        """事件流端点：全量 + after_seq 增量。"""
        client, headers = self._api_client()
        resp = client.post("/v1/tasks", headers=headers, json={
            "task_type": "data-qa",
            "input": {"server": "board", "question": "q"}})
        run_id = resp.json()["run_id"]
        body = client.get(f"/v1/runs/{run_id}/events",
                          headers=headers).json()
        self.assertEqual(body["run_id"], run_id)
        self.assertGreater(len(body["events"]), 0)
        last = body["events"][-1]["seq"]
        inc = client.get(f"/v1/runs/{run_id}/events?after_seq={last}",
                         headers=headers).json()
        self.assertEqual(inc["events"], [])
        self.assertEqual(client.get("/v1/runs/nope/events",
                                    headers=headers).status_code, 404)

    async def test_cancel_run(self):
        """取消：queued 的 run 落 cancelled；重复取消 409；不存在 404。"""
        from agent_platform.orchestration.submitter import Submitter
        from fakes import FakeTemporalClient
        sub = Submitter(FakeTemporalClient(execute=False), self.tasks,
                        "tq", "test", defs=self.defs)
        client, headers = self._api_client(submitter=sub)
        run_id = client.post("/v1/tasks", headers=headers, json={
            "task_type": "data-qa",
            "input": {"server": "board", "question": "q"}}).json()["run_id"]
        resp = client.post(f"/v1/runs/{run_id}/cancel", headers=headers,
                           json={"by": "tester"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "cancelled")
        run = client.get(f"/v1/tasks/{run_id}", headers=headers).json()
        self.assertEqual(run["status"], "cancelled")
        # terminate 语义传达给了 workflow handle
        handle = sub._client.get_workflow_handle(run_id)
        self.assertIn("tester", handle.terminated)
        # 终态重复取消 → 409；不存在 → 404
        self.assertEqual(client.post(f"/v1/runs/{run_id}/cancel",
                                     headers=headers, json={}).status_code, 409)
        self.assertEqual(client.post("/v1/runs/nope/cancel",
                                     headers=headers, json={}).status_code, 404)

    async def test_idempotency_key(self):
        """Idempotency-Key：同键重提命中首个 run（dedup_hit）。"""
        client, headers = self._api_client()
        payload = {"task_type": "data-qa",
                   "input": {"server": "board", "question": "幂等"}}
        h = {**headers, "Idempotency-Key": "req-123"}
        r1 = client.post("/v1/tasks", headers=h, json=payload).json()
        r2 = client.post("/v1/tasks", headers=h, json=payload).json()
        self.assertEqual(r2["run_id"], r1["run_id"])
        self.assertTrue(r2["dedup_hit"])
        # 不同键 = 新 run
        r3 = client.post("/v1/tasks", headers={
            **headers, "Idempotency-Key": "req-456"}, json=payload).json()
        self.assertNotEqual(r3["run_id"], r1["run_id"])

    async def test_role_override_on_tasks(self):
        """POST /v1/tasks 支持 role 覆盖（与 /v1/chat 对齐）。"""
        client, headers = self._api_client()
        resp = client.post("/v1/tasks", headers=headers, json={
            "task_type": "data-qa", "role": "ops_analyst",
            "input": {"server": "board", "question": "q"}})
        run = client.get(f"/v1/tasks/{resp.json()['run_id']}",
                         headers=headers).json()
        self.assertEqual(run["role"], "ops_analyst")

    async def test_approvals_list_endpoint(self):
        """审批查询：pending 收件箱 + 已处理历史。"""
        from agent_platform.agent import approvals
        client, headers = self._api_client()
        run_id = client.post("/v1/tasks", headers=headers, json={
            "task_type": "data-qa",
            "input": {"server": "board", "question": "q"}}).json()["run_id"]
        aid = await approvals.request_approval(run_id, "rm -rf /tmp/x")
        pending = client.get("/v1/approvals?status=pending",
                             headers=headers).json()["approvals"]
        self.assertEqual([a["id"] for a in pending], [aid])
        await approvals.decide(aid, True, "tester")
        done = client.get("/v1/approvals?status=approved",
                          headers=headers).json()
        self.assertEqual(done["total"], 1)
        self.assertEqual(done["approvals"][0]["decided_by"], "tester")
        self.assertEqual(client.get("/v1/approvals?status=pending",
                                    headers=headers).json()["approvals"], [])

    async def test_deliver_http_callback(self):
        """output_channel=http：终态后回调收到 {run_id, task_type, status, output}。"""
        from unittest.mock import patch

        import httpx
        posts = []

        def handler(request):
            posts.append(__import__("json").loads(request.content))
            return httpx.Response(200)

        await self.defs.put("task", "test", "cb-task",
                            {"role": "data_searcher", "output_channel": "http",
                             "output_callback": "http://caller.test/hook"},
                            updated_by="test")
        client, headers = self._api_client()
        real_client = httpx.AsyncClient
        with patch.object(httpx, "AsyncClient",
                          side_effect=lambda **kw: real_client(
                              transport=httpx.MockTransport(handler), **kw)):
            run_id = client.post("/v1/tasks", headers=headers, json={
                "task_type": "cb-task",
                "input": {"server": "board", "question": "q"}}).json()["run_id"]
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["run_id"], run_id)
        self.assertEqual(posts[0]["status"], "success")
        self.assertIn("output", posts[0])

    async def test_deliver_failure_logged_not_raised(self):
        """回调失败：run 仍是 success，留 deliver_failed 事件（不翻案）。"""
        from unittest.mock import patch

        import httpx

        def handler(request):
            return httpx.Response(502)

        await self.defs.put("task", "test", "cb-bad",
                            {"role": "data_searcher", "output_channel": "http",
                             "output_callback": "http://caller.test/down"},
                            updated_by="test")
        client, headers = self._api_client()
        real_client = httpx.AsyncClient
        with patch.object(httpx, "AsyncClient",
                          side_effect=lambda **kw: real_client(
                              transport=httpx.MockTransport(handler), **kw)):
            run_id = client.post("/v1/tasks", headers=headers, json={
                "task_type": "cb-bad",
                "input": {"server": "board", "question": "q"}}).json()["run_id"]
        run = client.get(f"/v1/tasks/{run_id}", headers=headers).json()
        self.assertEqual(run["status"], "success")
        events = client.get(f"/v1/runs/{run_id}/events",
                            headers=headers).json()["events"]
        self.assertTrue(any(e["payload"].get("stage") == "deliver_failed"
                            for e in events))

    async def test_deliver_dingtalk(self):
        """output_channel=dingtalk：平台经中继投递（不再靠 agent 自觉）。"""
        from agent_platform.orchestration import activities
        from fakes import configure_fake_deps

        class _Notifier:
            def __init__(self):
                self.sent = []

            async def send_markdown(self, title, text):
                self.sent.append((title, text))
                return {}

        notifier = _Notifier()
        configure_fake_deps(self.settings, self.defs, notifier=notifier)
        await self.defs.put("task", "test", "dt-task",
                            {"role": "data_searcher",
                             "output_channel": "dingtalk"}, updated_by="test")
        client, headers = self._api_client()
        run_id = client.post("/v1/tasks", headers=headers, json={
            "task_type": "dt-task",
            "input": {"server": "board", "question": "q"}}).json()["run_id"]
        self.assertEqual(len(notifier.sent), 1)
        self.assertIn("dt-task", notifier.sent[0][0])
        # 还原默认 deps（notifier=None），不影响后续用例
        configure_fake_deps(self.settings, self.defs)
        self.assertIsNotNone(run_id)

    def _ops_client(self):
        from fastapi.testclient import TestClient

        from agent_platform.api import create_app, make_ops_router
        app = create_app(self.settings)
        app.include_router(make_ops_router(self.settings))
        return TestClient(app), {"Authorization": "Bearer test-token"}

    async def test_knowledge_api(self):
        """/v1/knowledge 全套：upsert 幂等、清单不扛正文、明细/改/过期/恢复。"""
        client, headers = self._ops_client()
        # 未带 token 401
        self.assertEqual(client.get("/v1/knowledge").status_code, 401)
        # 空字段 422
        self.assertEqual(client.post("/v1/knowledge", headers=headers, json={
            "domain": "board", "key": " ", "content": "x"}).status_code, 422)
        # 建 + 同 key 覆盖（upsert 幂等：不产生第二条）
        for content in ("口径 v1", "口径 v2"):
            resp = client.post("/v1/knowledge", headers=headers, json={
                "domain": "board", "key": "毛利率口径", "content": content})
            self.assertEqual(resp.status_code, 201)
        data = client.get("/v1/knowledge?domain=board",
                          headers=headers).json()
        rows = [i for i in data["items"] if i["key"] == "毛利率口径"]
        self.assertEqual(len(rows), 1)
        self.assertNotIn("content", rows[0])  # 清单不扛正文
        # 明细：正文 + 演化链/反馈/用量字段齐全
        entry = client.get(f"/v1/knowledge/{rows[0]['id']}",
                           headers=headers).json()
        self.assertEqual(entry["content"], "口径 v2")
        for k in ("fresh", "chain", "feedback", "usage", "recent_hits"):
            self.assertIn(k, entry)
        # 改内容
        resp = client.post(f"/v1/knowledge/{rows[0]['id']}", headers=headers,
                           json={"content": "口径 v3"})
        self.assertEqual(resp.status_code, 200)
        entry = client.get(f"/v1/knowledge/{rows[0]['id']}",
                           headers=headers).json()
        self.assertEqual(entry["content"], "口径 v3")
        # 过期 → 默认清单消失；恢复 → 回来
        client.post(f"/v1/knowledge/{rows[0]['id']}/expire", headers=headers)
        items = client.get("/v1/knowledge?domain=board",
                           headers=headers).json()["items"]
        self.assertNotIn("毛利率口径", [i["key"] for i in items])
        items = client.get("/v1/knowledge?domain=board&include_inactive=true",
                           headers=headers).json()["items"]
        self.assertIn("毛利率口径", [i["key"] for i in items])
        client.post(f"/v1/knowledge/{rows[0]['id']}/restore", headers=headers)
        items = client.get("/v1/knowledge?domain=board",
                           headers=headers).json()["items"]
        self.assertIn("毛利率口径", [i["key"] for i in items])
        # 不存在 404；检索 q 空 422、有 q 出 block/hits
        self.assertEqual(client.get("/v1/knowledge/999999",
                                    headers=headers).status_code, 404)
        self.assertEqual(client.get("/v1/knowledge/search?domain=board",
                                    headers=headers).status_code, 422)
        data = client.get("/v1/knowledge/search?domain=board&q=毛利率",
                          headers=headers).json()
        self.assertIn("block", data)
        self.assertIn("hits", data)

    async def test_assets_api(self):
        """/v1/assets 全套：登记（kind 校验）/列表过滤/明细/改/过期/恢复。"""
        client, headers = self._ops_client()
        self.assertEqual(client.post("/v1/assets", headers=headers, json={
            "domain": "board", "kind": "bad-kind", "name": "x",
            "content": "x"}).status_code, 422)
        resp = client.post("/v1/assets", headers=headers, json={
            "domain": "board", "kind": "procedure", "name": "重启手册",
            "summary": "board 服务重启步骤", "content": "1. ..."})
        self.assertEqual(resp.status_code, 201)
        rows = client.get("/v1/assets?domain=board&kind=procedure",
                          headers=headers).json()["assets"]
        row = next(a for a in rows if a["name"] == "重启手册")
        entry = client.get(f"/v1/assets/{row['id']}", headers=headers).json()
        self.assertEqual(entry["content"], "1. ...")
        self.assertEqual(entry["files"], [])
        # 改 + 过期/恢复 + 状态过滤
        client.post(f"/v1/assets/{row['id']}", headers=headers,
                    json={"summary": "v2", "content": "2. ..."})
        entry = client.get(f"/v1/assets/{row['id']}", headers=headers).json()
        self.assertEqual(entry["summary"], "v2")
        client.post(f"/v1/assets/{row['id']}/expire", headers=headers)
        names = [a["name"] for a in client.get(
            "/v1/assets?domain=board&state=off", headers=headers)
            .json()["assets"]]
        self.assertIn("重启手册", names)
        client.post(f"/v1/assets/{row['id']}/restore", headers=headers)
        names = [a["name"] for a in client.get(
            "/v1/assets?domain=board&state=on", headers=headers)
            .json()["assets"]]
        self.assertIn("重启手册", names)
        # 文本类资产没有文件可度：file 端点 404
        self.assertEqual(client.get(f"/v1/assets/{row['id']}/file?path=x",
                                    headers=headers).status_code, 404)
        self.assertEqual(client.get("/v1/assets/999999",
                                    headers=headers).status_code, 404)

    async def test_admin_def_read_and_rollback(self):
        """定义读取闭环：三类单条 GET + 任务/策略 history + rollback。"""
        client, headers = self._api_client()
        role = client.get("/v1/admin/roles/data_searcher",
                          headers=headers).json()
        self.assertEqual(role["name"], "data_searcher")
        self.assertGreaterEqual(role["version"], 1)
        task = client.get("/v1/admin/tasks/data-qa", headers=headers).json()
        self.assertEqual(task["role"], "data_searcher")
        self.assertEqual(client.get("/v1/admin/policies/no-such",
                                    headers=headers).status_code, 404)
        # 任务：put 出 v2 → history 两条 → rollback v1 → 内容回到 v1 且版本+1
        client.post("/v1/admin/tasks", headers=headers, json={
            "name": "rb-task", "definition": {"role": "ops_analyst"}})
        client.post("/v1/admin/tasks", headers=headers, json={
            "name": "rb-task",
            "definition": {"role": "ops_analyst", "timeout_s": 600}})
        history = client.get("/v1/admin/tasks/rb-task/history",
                             headers=headers).json()
        self.assertEqual([h["version"] for h in history], [2, 1])
        client.post("/v1/admin/tasks/rb-task/rollback/1", headers=headers)
        cur = client.get("/v1/admin/tasks/rb-task", headers=headers).json()
        self.assertEqual(cur["version"], 3)
        self.assertNotIn("timeout_s", cur)
        self.assertEqual(client.post("/v1/admin/tasks/rb-task/rollback/99",
                                     headers=headers).status_code, 404)
        # 策略同款
        client.post("/v1/admin/policies", headers=headers, json={
            "name": "rb-pol", "definition": {"match_regex": "rm -rf"}})
        client.post("/v1/admin/policies", headers=headers, json={
            "name": "rb-pol", "definition": {"match_regex": "rm -rf",
                                             "action": "require_approval"}})
        history = client.get("/v1/admin/policies/rb-pol/history",
                             headers=headers).json()
        self.assertEqual(len(history), 2)
        client.post("/v1/admin/policies/rb-pol/rollback/1", headers=headers)
        cur = client.get("/v1/admin/policies/rb-pol", headers=headers).json()
        # 存的是原始定义（默认值不落库）：v1 没给 action，评估时默认 deny
        self.assertNotIn("action", cur)
        self.assertEqual(cur["match_regex"], "rm -rf")

    async def test_rerun_and_step_feedback_api(self):
        """/v1/runs/{id}/rerun 与单步反馈（含参数校验）。"""
        from agent_platform.store import feedback as feedback_store

        client, headers = self._api_client()
        run_id = client.post("/v1/tasks", headers=headers, json={
            "task_type": "data-qa",
            "input": {"server": "board", "question": "q"}}).json()["run_id"]
        # 成功 run 重跑 = 同输入新开 run
        resp = client.post(f"/v1/runs/{run_id}/rerun", headers=headers)
        self.assertEqual(resp.status_code, 200)
        self.assertNotEqual(resp.json()["run_id"], run_id)
        # 单步反馈：合法 200；score 非法 422；未知 run 404
        resp = client.post(f"/v1/runs/{run_id}/steps/1/feedback",
                           headers=headers, json={"score": 1})
        self.assertEqual(resp.status_code, 200)
        fb = await feedback_store.for_run(run_id)
        self.assertEqual([(f["kind"], f["step_seq"], f["score"])
                          for f in fb], [("step", 1, 1)])
        self.assertEqual(client.post(f"/v1/runs/{run_id}/steps/1/feedback",
                                     headers=headers,
                                     json={"score": 3}).status_code, 422)
        self.assertEqual(client.post("/v1/runs/nope/steps/1/feedback",
                                     headers=headers,
                                     json={"score": 1}).status_code, 404)

    async def test_stats_api(self):
        """/v1/stats：状态计数 + 任务分布 + 待审批数。"""
        client, headers = self._ops_client()
        await self.submitter.submit("data-qa",
                                    {"server": "board", "question": "q"}, "sdk")
        data = client.get("/v1/stats", headers=headers).json()
        self.assertGreaterEqual(data["by_status"].get("success", 0), 1)
        self.assertEqual(data["hours"], 24)
        for k in ("tasks", "failed", "pending_approvals"):
            self.assertIn(k, data)
        self.assertEqual(client.get("/v1/stats").status_code, 401)

    async def test_viewer_pages_render(self):
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app
        from agent_platform.viewer import make_viewer_router
        app = create_app(self.settings)
        app.include_router(make_viewer_router(self.submitter, self.defs, "test"))
        client = TestClient(app)
        for path in ("/admin", "/memory", "/chat", "/runs"):
            resp = client.get(path)
            self.assertEqual(resp.status_code, 200, path)
        # 未配 target_envs：页面不出现环境选择器（单环境部署无感知）
        self.assertNotIn('id="env"', client.get("/chat").text)

    async def test_viewer_env_selectors(self):
        """配置了 target_envs：对话页/列表页/记忆页带环境选择器与过滤。"""
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app
        from agent_platform.viewer import make_viewer_router
        sub = self._multi_env_submitter()
        await sub.submit("data-qa", {"server": "board", "question": "q"},
                         "sdk", target_env="prod")
        app = create_app(self.settings)
        app.include_router(make_viewer_router(
            sub, self.defs, "test", target_envs=["prod", "test"]))
        client = TestClient(app)

        self.assertIn('id="env"', client.get("/chat").text)
        listed = client.get("/runs", params={"env": "prod"})
        self.assertEqual(listed.status_code, 200)
        self.assertIn("prod", listed.text)
        mem = client.get("/memory", params={"env": "prod"})
        self.assertEqual(mem.status_code, 200)
        self.assertIn('name="env"', mem.text)

    async def test_runs_list_page_filters(self):
        """Runs 列表页：状态/域/关键词过滤 + 分页器 + 可排序表头 + 相对时间。"""
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app
        from agent_platform.store import runs
        from agent_platform.viewer import make_viewer_router
        await runs.create("lf1", "data-qa", "data_searcher", "board",
                          "sdk", "svc-a", {"question": "毛利率口径"})
        await runs.set_status("lf1", "failed", {})
        await runs.create("lf2", "daily-inspection", "ops_analyst", "board",
                          "schedule", "", {"scope": "nightly"})
        await runs.set_status("lf2", "success", {})
        app = create_app(self.settings)
        app.include_router(make_viewer_router(
            self.submitter, self.defs, "test", domains=["board", "dagster"]))
        client = TestClient(app)

        page = client.get("/runs")
        self.assertEqual(page.status_code, 200)
        self.assertIn("fchips", page.text)          # 状态/时间 chips
        self.assertIn("共 2 条", page.text)          # 总数
        self.assertIn("sort=created_at", page.text)  # 可排序表头
        self.assertIn("刚刚", page.text)             # 相对时间
        self.assertIn("svc-a", page.text)            # caller 列
        failed = client.get("/runs", params={"status": "failed"})
        self.assertIn("lf1"[:8], failed.text)
        self.assertNotIn('lf2'[:8] + "<", failed.text)
        self.assertIn("共 1 条", failed.text)
        byq = client.get("/runs", params={"q": "毛利率"})
        self.assertIn("共 1 条", byq.text)
        empty = client.get("/runs", params={"q": "不存在的词"})
        self.assertIn("清除全部过滤", empty.text)    # 过滤后空态

    async def test_approvals_done_tab(self):
        """审批页：待办 SLA 升序 + 已处理历史（结果过滤/操作人/决定时间）。"""
        from fastapi.testclient import TestClient

        from agent_platform.agent import approvals as appr
        from agent_platform.api.app import create_app
        from agent_platform.store import runs
        from agent_platform.viewer import make_viewer_router
        await runs.create("ap1", "daily-inspection", "ops_analyst", "board",
                          "schedule", "", {"scope": "n"})
        aid = await appr.request_approval("ap1", "rm -rf /tmp/x")
        await appr.decide(aid, True, decided_by="张三")
        await runs.create("ap2", "data-qa", "data_searcher", "board",
                          "sdk", "svc-a", {"question": "q"})
        await appr.request_approval("ap2", "systemctl restart x")
        app = create_app(self.settings)
        app.include_router(make_viewer_router(self.submitter, self.defs, "test"))
        client = TestClient(app)

        inbox = client.get("/approvals")
        self.assertEqual(inbox.status_code, 200)
        self.assertIn("待办（1）", inbox.text)
        self.assertIn("systemctl restart x", inbox.text)
        self.assertNotIn("rm -rf /tmp/x", inbox.text)  # 已处理的不混在待办
        done = client.get("/approvals", params={"tab": "done"})
        self.assertIn("rm -rf /tmp/x", done.text)
        self.assertIn("已放行", done.text)
        self.assertIn("张三", done.text)
        rejected = client.get("/approvals",
                              params={"tab": "done", "status": "rejected"})
        self.assertIn("当前过滤下没有记录", rejected.text)  # 过滤后空态
        self.assertNotIn("rm -rf", rejected.text)

    async def test_chat_session_endpoints(self):
        """对话页会话端点：列表按最后活动倒序 + 历史回放 + 配置回填。"""
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app
        from agent_platform.viewer import make_viewer_router
        for q in ("毛利率怎么看", "上季度华东呢"):
            await self.submitter.submit(
                "data-qa", {"server": "board", "question": q}, "web_chat",
                session_id="s-chat")
        await self.submitter.submit(
            "data-qa", {"server": "dagster", "question": "别的会话"}, "web_chat",
            session_id="s-other")
        app = create_app(self.settings)
        app.include_router(make_viewer_router(self.submitter, self.defs, "test"))
        client = TestClient(app)

        sessions = client.get("/chat/sessions.json").json()["sessions"]
        self.assertEqual([s["session_id"] for s in sessions],
                         ["s-other", "s-chat"])  # 最新在前
        self.assertEqual(sessions[1]["first_q"], "毛利率怎么看")
        self.assertEqual(sessions[1]["runs"], 2)

        hist = client.get("/chat/sessions/s-chat/history.json").json()
        self.assertEqual([r["question"] for r in hist["runs"]],
                         ["毛利率怎么看", "上季度华东呢"])
        self.assertEqual(hist["config"]["server"], "board")
        self.assertTrue(all(r["run_id"] for r in hist["runs"]))

    async def test_chat_stream_sse(self):
        """SSE 流式对话：首帧 run 标识 + 事件帧 + final 帧；无令牌 401。"""
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app
        from agent_platform.api.auth import make_auth_dependency
        from agent_platform.triggers import chat as chat_trigger
        app = create_app(self.settings)
        app.include_router(chat_trigger.make_router(
            self.submitter, auth=make_auth_dependency("test-token")))
        client = TestClient(app)

        resp = client.post("/v1/chat/stream", json={
            "server": "board", "role": "data_searcher", "question": "毛利率"})
        self.assertEqual(resp.status_code, 401)

        resp = client.post("/v1/chat/stream",
                           headers={"Authorization": "Bearer test-token"},
                           json={"server": "board", "role": "data_searcher",
                                 "question": "毛利率"})
        self.assertEqual(resp.status_code, 200)
        body = resp.text
        self.assertIn('"type": "run"', body)
        self.assertIn('"type": "final"', body)
        self.assertIn('"status": "success"', body)

    async def test_viewer_bad_params_are_400(self):
        """手改 URL 参数 → 400 而非 500：非法光标/非整数页码/时间范围/非法 since。"""
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app
        from agent_platform.viewer import make_viewer_router
        r = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "q"}, "sdk")
        app = create_app(self.settings)
        app.include_router(make_viewer_router(self.submitter, self.defs, "test"))
        client = TestClient(app)

        self.assertEqual(client.get("/runs?c=garbage").status_code, 400)
        self.assertEqual(client.get("/runs?c=a|b|c").status_code, 400)
        self.assertEqual(client.get("/runs?range=abc").status_code, 400)
        self.assertEqual(client.get("/assets?p=x").status_code, 400)
        self.assertEqual(
            client.get("/approvals?tab=done&p=x").status_code, 400)
        self.assertEqual(
            client.get(f"/runs/{r['run_id']}/state.json?since=abc")
            .status_code, 400)
        # 正常参数不受影响
        self.assertEqual(client.get("/runs").status_code, 200)
        self.assertEqual(
            client.get(f"/runs/{r['run_id']}/state.json").status_code, 200)

    async def test_viewer_approval_cross_run_rejected(self):
        """审批表单与 URL 的 run 不匹配时不落决定（防跨 run 误操作）。"""
        from fastapi.testclient import TestClient

        from agent_platform.agent import approvals
        from agent_platform.api.app import create_app
        from agent_platform.viewer import make_viewer_router
        r = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "q"}, "sdk")
        aid = await approvals.request_approval(r["run_id"], "rm -rf /tmp/x")
        app = create_app(self.settings)
        app.include_router(make_viewer_router(self.submitter, self.defs, "test"))
        client = TestClient(app)

        resp = client.post("/approvals/other-run/decide",
                           data={"decision": "approved", "approval_id": aid})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("没有待审批项", resp.text)
        # 审批单仍未决（未误落决定）
        self.assertIsNotNone(await approvals.find_pending(r["run_id"]))

        # 正常路径：匹配 run 的决定生效
        resp = client.post(f"/approvals/{r['run_id']}/decide",
                           data={"decision": "approved", "approval_id": aid})
        self.assertIn("已放行", resp.text)
        self.assertIsNone(await approvals.find_pending(r["run_id"]))

    async def test_admin_diff_page(self):
        """定义版本对比页：渲染 diff，缺版本 404。"""
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app
        from agent_platform.viewer import make_viewer_router
        await self.defs.put("task", "test", "nightly", {"role": "ops_analyst"})
        await self.defs.put("task", "test", "nightly",
                            {"role": "ops_analyst", "timeout_s": 900})
        app = create_app(self.settings)
        app.include_router(make_viewer_router(self.submitter, self.defs, "test"))
        client = TestClient(app)

        resp = client.get("/admin/diff", params={
            "kind": "task", "name": "nightly", "a": 1, "b": 2})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("timeout_s", resp.text)
        self.assertEqual(client.get("/admin/diff", params={
            "kind": "task", "name": "nightly", "a": 1, "b": 9}).status_code, 404)

    async def test_admin_console_list_and_history(self):
        """管理页双栏：列表带版本/影响面；history.json 版本倒序；diff JSON。"""
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app
        from agent_platform.viewer import make_viewer_router
        await self.defs.put("task", "test", "nightly", {"role": "ops_analyst"})
        await self.defs.put("task", "test", "nightly",
                            {"role": "ops_analyst", "timeout_s": 900})
        # 一个真实 run 让列表出现「N run/24h」影响面
        await self.submitter.submit(
            "data-qa", {"server": "board", "question": "q"}, "sdk")
        app = create_app(self.settings)
        app.include_router(make_viewer_router(self.submitter, self.defs, "test",
                                              tool_names=["bash", "sql_query"]))
        client = TestClient(app)

        page = client.get("/admin")
        self.assertEqual(page.status_code, 200)
        self.assertIn("admin-layout", page.text)          # 双栏布局
        self.assertIn('"nightly": {', page.text)        # defs JSON 供编辑器
        self.assertIn("v2", page.text)                    # 当前版本徽章
        self.assertIn("1 run/24h", page.text)             # 影响面（data-qa 角色）
        self.assertIn("sql_query", page.text)             # 工具目录

        hist = client.get("/admin/defs/task/nightly/history.json")
        self.assertEqual([h["version"] for h in hist.json()["history"]], [2, 1])
        self.assertEqual(client.get(
            "/admin/defs/task/ghost/history.json").status_code, 404)

        diff = client.get("/admin/diff", params={
            "kind": "task", "name": "nightly", "a": 1, "b": 2,
            "format": "json"})
        self.assertIn("timeout_s", diff.json()["diff"])

    async def test_memory_console_full_lifecycle(self):
        """记忆页：域侧栏统计 + 检索试用 + 抽屉明细（演化链/反馈）+ 过期恢复。
        数据/写操作走 /v1/knowledge/*（页面只留 HTML 渲染）。"""
        from fastapi.testclient import TestClient

        from agent_platform.api import create_app, make_ops_router
        from agent_platform.store import cases, feedback, knowledge
        from agent_platform.viewer import make_viewer_router
        r = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "q"}, "sdk")
        await knowledge.upsert("test", "board", "GMV 口径", "GMV 含运费（旧口径）。",
                               source_run=r["run_id"])
        await knowledge.upsert("test", "board", "GMV 口径 v2",
                               "GMV 不含运费（新口径）。",
                               source_run=r["run_id"])
        await knowledge.supersede_keys("test", "board", ["GMV 口径"],
                                       "GMV 口径 v2")
        await feedback.add(r["run_id"], 1, "答得准")
        await cases.add("test", "board", "psycopg.errors.DeadlockDetected x",
                        "infra", "并发冲突，重试即可", r["run_id"])
        # 真实召回一次：recall_block 应写 recall_hits 埋点
        from agent_platform.memory import recall_block
        block = await recall_block("test", "board", "GMV 口径是多少",
                                   run_id=r["run_id"])
        self.assertIn("GMV 口径 v2", block)
        self.assertNotIn("旧口径", block)  # 被取代条目不召回
        app = create_app(self.settings)
        app.include_router(make_viewer_router(self.submitter, self.defs, "test"))
        app.include_router(make_ops_router(self.settings))
        client = TestClient(app)
        headers = {"Authorization": "Bearer test-token"}

        page = client.get("/memory")
        self.assertEqual(page.status_code, 200)
        self.assertIn("mem-layout", page.text)
        self.assertIn("GMV 口径 v2", page.text)       # 条目卡
        self.assertIn("1 生效", page.text)            # 侧栏角标
        self.assertIn("已取代", page.text)            # 失效条目默认列出
        self.assertIn("并发冲突", page.text)          # 案例 tab
        self.assertIn("memory.js", page.text)

        hits = client.get("/v1/knowledge/search", headers=headers,
                          params={"q": "GMV 口径", "domain": "board"})
        self.assertEqual(hits.status_code, 200)
        self.assertEqual(hits.json()["hits"][0]["key"], "GMV 口径 v2")

        det = None
        for it in page.text.split('data-id="')[1:]:
            eid = int(it.split('"')[0])
            d = client.get(f"/v1/knowledge/{eid}", headers=headers)
            if d.json()["key"] == "GMV 口径 v2":
                det = d.json()
                break
        self.assertIsNotNone(det)
        self.assertEqual([c["key"] for c in det["chain"]],
                         ["GMV 口径", "GMV 口径 v2"])  # 演化链时间序
        self.assertTrue(det["chain"][0]["superseded"])
        self.assertEqual(det["feedback"][0]["comment"], "答得准")
        self.assertEqual(det["usage"]["hits"], 1)       # recall 埋点进抽屉
        real = [h for h in det["recent_hits"] if h["source"] == "recall"]
        self.assertEqual(real[0]["run_id"], r["run_id"])
        self.assertTrue(any(h["source"] == "playground"  # 试用也留痕但不计使用
                            for h in det["recent_hits"]))

        # 健康度汇总与零召回过滤：v2 被召回过，手动新增的没有
        page2 = client.get("/memory")
        self.assertIn("近30天命中 1 次", page2.text)
        self.assertIn("<b>0</b> 零召回", page2.text)
        created = client.post("/v1/knowledge", headers=headers, json={
            "domain": "board", "key": "退货口径", "content": "退货冲减 GMV。"})
        self.assertEqual(created.status_code, 201)
        page3 = client.get("/memory", params={"filter": "zero_recall"})
        self.assertIn("退货口径", page3.text)
        self.assertNotIn("GMV 口径 v2", page3.text)

        eid = det["id"]
        self.assertEqual(client.post(f"/v1/knowledge/{eid}/expire",
                                     headers=headers).status_code, 200)
        self.assertTrue((await knowledge.get_entry(eid))["expired"])
        self.assertEqual(client.post(f"/v1/knowledge/{eid}/restore",
                                     headers=headers).status_code, 200)
        self.assertFalse((await knowledge.get_entry(eid))["expired"])

    async def test_assets_page(self):
        """资产页：渲染 + 登记文本资产 + 抽屉明细/编辑 + 过期/恢复退出召回
        + 文件类资产的在线查看。数据/写操作走 /v1/assets/*。"""
        import tempfile

        from fastapi.testclient import TestClient

        from agent_platform.api import create_app, make_ops_router
        from agent_platform.store import assets
        from agent_platform.viewer import make_viewer_router
        await assets.upsert("test", "board", "daily-inspection", "procedure",
                            "ods-巡检方法", "每日巡检 SOP", "先比行数再抽查。")
        await assets.upsert("test", "board", "", "baseline",
                            "ods-orders-基线", "昨日行数基线", "4200 万")
        app = create_app(self.settings)
        app.include_router(make_viewer_router(self.submitter, self.defs, "test"))
        app.include_router(make_ops_router(self.settings))
        client = TestClient(app)
        headers = {"Authorization": "Bearer test-token"}

        page = client.get("/assets", params={"domain": "board"})
        self.assertEqual(page.status_code, 200)
        self.assertIn("资产库", page.text)
        self.assertIn("ods-巡检方法", page.text)
        self.assertIn("任务 daily-inspection", page.text)
        self.assertIn("域级通用", page.text)

        created = client.post("/v1/assets", headers=headers, json={
            "domain": "board", "kind": "query", "name": "行数对比",
            "task": "", "summary": "比上下游行数", "content": "select ..."})
        self.assertEqual(created.status_code, 201)
        bad = client.post("/v1/assets", headers=headers, json={
            "domain": "board", "kind": "bogus", "name": "x", "content": "y"})
        self.assertEqual(bad.status_code, 422)
        empty = client.post("/v1/assets", headers=headers, json={
            "domain": "board", "kind": "query", "name": "x", "content": "  "})
        self.assertEqual(empty.status_code, 422)

        rows = await assets.list_all("test", "board")
        self.assertEqual(len(rows), 3)
        aid = next(r["id"] for r in rows if r["name"] == "ods-巡检方法")
        det = client.get(f"/v1/assets/{aid}", headers=headers)
        self.assertEqual(det.status_code, 200)
        self.assertEqual(det.json()["content"], "先比行数再抽查。")
        self.assertEqual(det.json()["use_count"], 0)
        edited = client.post(f"/v1/assets/{aid}", headers=headers,
                             json={"summary": "新摘要", "content": "步骤 v2"})
        self.assertEqual(edited.status_code, 200)
        self.assertEqual((await assets.get_entry(aid))["content"], "步骤 v2")
        self.assertEqual(
            client.post(f"/v1/assets/{aid}/expire",
                        headers=headers).status_code, 200)
        names = [a["name"] for a in
                 await assets.search_active("test", "board", "daily-inspection")]
        self.assertNotIn("ods-巡检方法", names)
        self.assertEqual(
            client.post(f"/v1/assets/{aid}/restore",
                        headers=headers).status_code, 200)
        self.assertIn("ods-巡检方法", [a["name"] for a in await assets.search_active(
            "test", "board", "daily-inspection")])

        # 文件类资产：元数据在 PG，文件本体落盘，页面上逐文件查看
        with tempfile.TemporaryDirectory() as d:
            with open(f"{d}/run.sql", "w") as fh:
                fh.write("select 1;")
            await assets.upsert("test", "board", "daily-inspection", "script",
                                "行数脚本", "行数对比脚本", "用法说明", path=d)
            fid = next(r["id"] for r in await assets.list_all("test", "board")
                       if r["name"] == "行数脚本")
            fdet = client.get(f"/v1/assets/{fid}", headers=headers).json()
            self.assertEqual([f["name"] for f in fdet["files"]], ["run.sql"])
            fresp = client.get(f"/v1/assets/{fid}/file", headers=headers,
                               params={"path": "run.sql"})
            self.assertEqual(fresp.text, "select 1;")
            self.assertEqual(client.get(
                f"/v1/assets/{fid}/file", headers=headers,
                params={"path": "../x"}).status_code, 404)

    async def test_prepare_injects_assets_and_counts_use(self):
        """prepare_run：任务资产置顶注入 prompt + 记复用 + 事件留痕。"""
        from agent_platform.store import assets, runs
        await assets.upsert("test", "board", "data-qa", "procedure",
                            "口径查询方法", "先查知识库再读代码", "步骤全文。")
        r = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "q"}, "sdk")
        events = await runs.get_events(r["run_id"])
        notes = [e["payload"] for e in events
                 if e["kind"] == "note"
                 and e["payload"].get("stage") == "assets"]
        self.assertEqual(len(notes), 1)
        self.assertIn("procedure:口径查询方法", notes[0]["content"])
        self.assertIn("步骤全文。", notes[0]["content"])
        top = (await assets.search_active("test", "board", "data-qa"))[0]
        self.assertEqual(top["use_count"], 1)  # 注入即记一次复用

    async def test_put_task_triggers_schedule_resync(self):
        """定时任务热生效：保存任务定义后立即重同步 Temporal Schedules。"""
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app, make_api_router
        calls = []

        async def fake_sync():
            calls.append(1)
            return 0
        app = create_app(self.settings)
        app.include_router(make_api_router(self.settings, self.submitter,
                                           self.tasks, self.defs,
                                           schedule_sync=fake_sync))
        client = TestClient(app)
        resp = client.post("/v1/admin/tasks",
                           headers={"Authorization": "Bearer test-token"},
                           json={"name": "nightly-check",
                                 "definition": {"role": "ops_analyst",
                                                "triggers": ["schedule"],
                                                "schedule": "0 3 * * *",
                                                "output_channel": "dingtalk"},
                                 "updated_by": "t"})
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["schedule_resynced"])
        self.assertEqual(len(calls), 1)

    async def test_viewer_auth_login_flow(self):
        """P1 回归：给了 token 后页面 307 跳登录；登录写 cookie 后放行。"""
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app
        from agent_platform.viewer import make_viewer_router
        app = create_app(self.settings)
        app.include_router(make_viewer_router(
            self.submitter, self.defs, "test", token="test-token",
            domains=["board", "dagster"]))
        client = TestClient(app, follow_redirects=False)

        resp = client.get("/chat")
        self.assertEqual(resp.status_code, 307)
        self.assertEqual(resp.headers["location"], "/login")

        resp = client.post("/login", data={"token": "wrong"})
        self.assertIn("令牌不正确", resp.text)

        resp = client.post("/login", data={"token": "test-token"})
        self.assertEqual(resp.status_code, 303)
        resp = client.get("/chat")   # TestClient 保留 cookie
        self.assertEqual(resp.status_code, 200)
        self.assertIn("board", resp.text)  # 业务域从配置注入，不再硬编码

        resp = client.get("/")       # 总览面板：聚合台账，不应因空库报错
        self.assertEqual(resp.status_code, 200)
        self.assertIn("总览", resp.text)

    async def test_hooks_require_auth(self):
        """P1 回归：webhook 端点与 /v1 API 一样要 bearer。"""
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app
        from agent_platform.api.auth import make_auth_dependency
        from agent_platform.triggers import dagster_sensor, gitlab_webhook
        app = create_app(self.settings)
        auth = make_auth_dependency(self.settings.bearer_token)
        app.include_router(dagster_sensor.make_router(
            self.submitter, None, auth=auth))
        app.include_router(gitlab_webhook.make_router(self.submitter, auth=auth))
        client = TestClient(app)

        self.assertEqual(
            client.post("/v1/hooks/dagster", json={}).status_code, 401)
        self.assertEqual(
            client.post("/v1/hooks/gitlab", json={}).status_code, 401)
        resp = client.post("/v1/hooks/gitlab", json={"object_kind": "push"},
                           headers={"Authorization": "Bearer test-token"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "ignored")

    # ---- Dagster 触发端 ----

    async def test_dagster_hook_rule_hit(self):
        from agent_platform.triggers import dagster_sensor

        class _Notifier:
            sent = []

            async def send_alert_card(self, title, content, *, dedup_hash):
                self.sent.append(title)

        router = dagster_sensor.make_router(self.submitter, _Notifier(),
                                            rules=self.dagster_rules)
        route = next(r for r in router.routes if r.path == "/v1/hooks/dagster")
        resp = await route.endpoint(
            {"run_id": "x", "asset_key": "a", "error": "connection refused"})
        self.assertEqual(resp["status"], "rule_resolved")

    async def test_dagster_hook_agent_path(self):
        from agent_platform.triggers import dagster_sensor
        router = dagster_sensor.make_router(self.submitter, None,
                                            rules=self.dagster_rules)
        route = next(r for r in router.routes if r.path == "/v1/hooks/dagster")
        resp = await route.endpoint(
            {"run_id": "x", "asset_key": "orders_daily", "error": "bespoke xyz"})
        self.assertEqual(resp["status"], "queued")
        self.assertTrue(resp["session_id"].startswith("dagster:orders_daily:"))

    # ---- 提交策略链（#2） ----

    async def test_policy_deny(self):
        from agent_platform.orchestration.submitter import TaskRejected
        await self.defs.put("policy", "test", "no-drop", {
            "match_regex": r"drop\s+table", "action": "deny",
            "message": "禁止删表类请求"})
        with self.assertRaises(TaskRejected):
            await self.submitter.submit(
                "data-qa", {"server": "board", "question": "帮我 drop table x"},
                "sdk")
        # 未命中正常放行
        r = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "总量口径"}, "sdk")
        self.assertEqual(r["status"], "queued")

    async def test_policy_order_and_applies_to(self):
        from agent_platform.orchestration.submitter import TaskRejected
        # order 小的先判：deny(10) 在 require_approval(200) 之前短路
        await self.defs.put("policy", "test", "late-approval", {
            "order": 200, "match_regex": "foo", "action": "require_approval"})
        await self.defs.put("policy", "test", "early-deny", {
            "order": 10, "match_regex": "foo", "action": "deny"})
        with self.assertRaises(TaskRejected):
            await self.submitter.submit(
                "data-qa", {"server": "board", "question": "foo"}, "sdk")
        # applies_to 不匹配 → 跳过该策略
        await self.defs.put("policy", "test", "scoped", {
            "order": 1, "applies_to": ["other-task"],
            "match_regex": "bar", "action": "deny"})
        r = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "bar"}, "sdk")
        self.assertEqual(r["status"], "queued")

    async def test_policy_require_approval_flow(self):
        from agent_platform.orchestration import policies
        from agent_platform.store import runs
        await self.defs.put("policy", "test", "delete-gate", {
            "match_regex": "delete", "action": "require_approval",
            "message": "删除类操作需审批"})
        r = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "delete 一批数据"},
            "sdk")
        self.assertEqual(r["status"], "awaiting_approval")
        run = await runs.get(r["run_id"])
        self.assertEqual(run["status"], "queued")
        self.assertEqual(self.temporal.started, [])  # workflow 尚未启动

        ok = await policies.settle_submit_gate(r["run_id"], True,
                                               self.submitter)
        self.assertTrue(ok)
        run = await runs.get(r["run_id"])
        self.assertEqual(run["status"], "success")
        self.assertEqual(self.temporal.started[-1][0], r["run_id"])
        # 已终结的 run 再次 settle 幂等返回 False（不再是闸门挂起状态）
        self.assertFalse(await policies.settle_submit_gate(
            r["run_id"], True, self.submitter))

    async def test_policy_reject_fails_run(self):
        from agent_platform.orchestration import policies
        from agent_platform.store import runs
        await self.defs.put("policy", "test", "delete-gate", {
            "match_regex": "delete", "action": "require_approval"})
        r = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "delete 数据"}, "sdk")
        ok = await policies.settle_submit_gate(r["run_id"], False,
                                               self.submitter)
        self.assertTrue(ok)
        run = await runs.get(r["run_id"])
        self.assertEqual(run["status"], "failed")
        self.assertIn("拒绝", run["output"]["error"])
        self.assertEqual(self.temporal.started, [])  # 拒绝 = 从未启动

    async def test_run_sync_awaiting_approval_returns_immediately(self):
        await self.defs.put("policy", "test", "delete-gate", {
            "match_regex": "delete", "action": "require_approval"})
        r = await self.submitter.run_sync(
            "data-qa", {"server": "board", "question": "delete x"}, "sdk")
        self.assertIsNone(r["output"])
        self.assertIn("approval_id", r)

    async def test_admin_policies_endpoints(self):
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app, make_api_router
        from agent_platform.orchestration.submitter import TaskRejected
        app = create_app(self.settings)
        app.include_router(make_api_router(self.settings, self.submitter,
                                           self.tasks, self.defs))
        client = TestClient(app)
        headers = {"Authorization": "Bearer test-token"}

        resp = client.post("/v1/admin/policies", headers=headers,
                           json={"name": "bad",
                                 "definition": {"action": "deny"}})
        self.assertEqual(resp.status_code, 422)  # 缺 match_regex
        resp = client.post("/v1/admin/policies", headers=headers, json={
            "name": "p1",
            "definition": {"match_regex": "drop", "action": "deny"}})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["version"], 1)
        names = [p["name"] for p in client.get(
            "/v1/admin/policies", headers=headers).json()]
        self.assertIn("p1", names)
        # 写后即时生效
        with self.assertRaises(TaskRejected):
            await self.submitter.submit(
                "data-qa", {"server": "board", "question": "drop it"}, "sdk")

    # ---- 目标环境（单部署多环境） ----

    def _multi_env_submitter(self):
        from agent_platform.orchestration.submitter import Submitter
        return Submitter(self.temporal, self.tasks, "tq", "test",
                         defs=self.defs,
                         target_envs=["prod", "test"],
                         default_target_env="test")

    async def test_target_env_recorded_on_run(self):
        from agent_platform.store import runs
        sub = self._multi_env_submitter()
        r = await sub.submit("data-qa",
                             {"server": "board", "question": "q"}, "sdk",
                             target_env="prod")
        self.assertEqual(r["target_env"], "prod")
        run = await runs.get(r["run_id"])
        self.assertEqual(run["target_env"], "prod")
        # 缺省 → default_target_env
        r2 = await sub.submit("data-qa",
                              {"server": "board", "question": "q2"}, "sdk")
        run2 = await runs.get(r2["run_id"])
        self.assertEqual(run2["target_env"], "test")

    async def test_unknown_target_env_rejected(self):
        from agent_platform.orchestration.submitter import TaskRejected
        sub = self._multi_env_submitter()
        with self.assertRaises(TaskRejected):
            await sub.submit("data-qa",
                             {"server": "board", "question": "q"}, "sdk",
                             target_env="staging")

    async def test_env_gate_uses_target_env(self):
        """env_gate 按目标环境判，不是按实例标签。"""
        from agent_platform.orchestration.submitter import TaskRejected
        await self.defs.put("task", "test", "prod-only", {
            "role": "data_searcher", "triggers": ["sdk"],
            "input_schema": {"question": "str"}, "output_channel": "caller",
            "env_gate": ["prod"]})
        sub = self._multi_env_submitter()
        with self.assertRaises(TaskRejected):
            await sub.submit("prod-only", {"question": "q"}, "sdk",
                             target_env="test")   # 实例标签是 test 也不行
        r = await sub.submit("prod-only", {"question": "q"}, "sdk",
                             target_env="prod")
        self.assertEqual(r["status"], "queued")

    async def test_policy_envs_filter_by_target_env(self):
        """PolicyDef.envs 限定策略生效的目标环境。"""
        from agent_platform.orchestration.submitter import TaskRejected
        await self.defs.put("policy", "test", "prod-no-drop", {
            "match_regex": r"drop\s+table", "action": "deny",
            "envs": ["prod"], "message": "生产禁删表"})
        sub = self._multi_env_submitter()
        with self.assertRaises(TaskRejected):
            await sub.submit(
                "data-qa", {"server": "board", "question": "drop table x"},
                "sdk", target_env="prod")
        # 同一问题打到 test：策略不生效，放行
        r = await sub.submit(
            "data-qa", {"server": "board", "question": "drop table x"},
            "sdk", target_env="test")
        self.assertEqual(r["status"], "queued")

    async def test_memory_partitioned_by_target_env(self):
        """沉淀按目标环境分区：prod 的知识在 test 分区查不到。"""
        from agent_platform.store import knowledge
        sub = self._multi_env_submitter()
        configure_fake_deps(self.settings, self.defs,
                            model_content='[{"kind":"knowledge","key":"k_prod",'
                                          '"content":"生产口径"}]')
        try:
            r = await sub.run_sync(
                "data-qa", {"server": "board", "question": "q"}, "sdk",
                target_env="prod")
            self.assertIsNotNone(r["output"])
        finally:
            configure_fake_deps(self.settings, self.defs)  # 还原空产出
        prod_keys = {i["key"] for i in await knowledge.list_all("prod")}
        test_keys = {i["key"] for i in await knowledge.list_all("test")}
        self.assertIn("k_prod", prod_keys)
        self.assertNotIn("k_prod", test_keys)

    async def test_list_runs_api_filters_by_env(self):
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app, make_api_router
        sub = self._multi_env_submitter()
        settings = _settings(db_dsn=self._pg.get_uri(),
                             target_envs=["prod", "test"],
                             default_target_env="test")
        app = create_app(settings)
        app.include_router(make_api_router(settings, sub, self.tasks,
                                           self.defs))
        client = TestClient(app)
        headers = {"Authorization": "Bearer test-token"}
        await sub.submit("data-qa", {"server": "board", "question": "q"},
                         "sdk", target_env="prod")
        await sub.submit("data-qa", {"server": "board", "question": "q2"},
                         "sdk", target_env="test")
        all_runs = client.get("/v1/runs", headers=headers).json()
        self.assertEqual(all_runs["total"], 2)
        self.assertEqual(len(all_runs["runs"]), 2)
        prod = client.get("/v1/runs?env=prod", headers=headers).json()
        self.assertEqual(len(prod["runs"]), 1)
        self.assertEqual(prod["runs"][0]["target_env"], "prod")

    # ---- 资产化任务图（#1） ----

    async def _register_etl_task(self):
        from agent_platform.orchestration import activities

        @activities.code_node("test_etl.extract")
        def _extract(payload):
            return ["a", "b"]

        @activities.code_node("test_etl.summary")
        def _summary(payload):
            items = payload["deps"]["per"]
            return {"count": len(items), "items": items}

        await self.defs.put("task", "test", "asset-etl", {
            "triggers": ["sdk"],
            "input_schema": {"topic": "str"},
            "artifacts": {
                "extract": {"code": "test_etl.extract"},
                "per": {"agent": {"role": "data_searcher"},
                        "map": "extract", "deps": ["extract"]},
                "verdict": {"route": {"choices": ["ok", "escalate"],
                                      "by": "ops_analyst"},
                            "deps": ["per"]},
                "report": {"agent": {"role": "ops_analyst"},
                           "deps": ["verdict"],
                           "gate": {"when": 'verdict == "escalate"'}},
                "summary": {"code": "test_etl.summary", "deps": ["per"]},
            }})

    async def test_artifact_graph_end_to_end(self):
        from agent_platform.store import artifacts as artifacts_store
        from agent_platform.store import runs
        await self._register_etl_task()
        configure_fake_deps(self.settings, self.defs, model_content='"ok"')
        r = await self.submitter.submit("asset-etl", {"topic": "t"}, "sdk")
        run = await runs.get(r["run_id"])
        self.assertEqual(run["status"], "success")
        # 终末产出 = 没有被依赖的节点；verdict 是中间产物，report 被 gate 跳过
        self.assertEqual(list(run["output"]), ["summary"])
        self.assertEqual(run["output"]["summary"]["count"], 2)  # map 扇出 2 项
        rows = {a["name"]: a
                for a in await artifacts_store.list_by_run(r["run_id"])}
        self.assertEqual(rows["extract"]["status"], "materialized")
        self.assertEqual(rows["report"]["status"], "skipped")
        events = await runs.get_events(r["run_id"])
        self.assertTrue(any(e["kind"] == "graph" for e in events))
        # 资产图任务不解析单角色：role_version 为空、task_version 固定
        self.assertIsNone(run["role_version"])
        self.assertGreaterEqual(run["task_version"], 1)

    async def test_artifact_reuse_across_runs(self):
        from agent_platform.store import artifacts as artifacts_store
        await self._register_etl_task()
        configure_fake_deps(self.settings, self.defs, model_content='"ok"')
        r1 = await self.submitter.submit("asset-etl", {"topic": "t"}, "sdk")
        r2 = await self.submitter.submit("asset-etl", {"topic": "t"}, "sdk")
        self.assertNotEqual(r1["run_id"], r2["run_id"])
        rows = {a["name"]: a
                for a in await artifacts_store.list_by_run(r2["run_id"])}
        # 输入指纹未变：第二跑节点全部复用（零模型调用）
        self.assertEqual(rows["extract"]["status"], "reused")
        self.assertEqual(rows["summary"]["status"], "reused")
        # 输入变了 → 根节点指纹变 → 重新物化
        r3 = await self.submitter.submit("asset-etl", {"topic": "t3"}, "sdk")
        rows3 = {a["name"]: a
                 for a in await artifacts_store.list_by_run(r3["run_id"])}
        self.assertEqual(rows3["extract"]["status"], "materialized")

    async def test_artifact_reuse_partitioned_by_env(self):
        """产物复用限定同一目标环境：test 物化的产物不能被 prod 的 run 复用。"""
        from agent_platform.store import artifacts as artifacts_store
        await self._register_etl_task()
        configure_fake_deps(self.settings, self.defs, model_content='"ok"')
        sub = self._multi_env_submitter()
        await sub.submit("asset-etl", {"topic": "t"}, "sdk",
                         target_env="test")
        r2 = await sub.submit("asset-etl", {"topic": "t"}, "sdk",
                              target_env="prod")
        rows2 = {a["name"]: a
                 for a in await artifacts_store.list_by_run(r2["run_id"])}
        # 同样的输入指纹，但跨环境 → 不复用，重新物化
        self.assertEqual(rows2["extract"]["status"], "materialized")
        # 同环境再跑 → 复用本环境（prod）的产物
        r3 = await sub.submit("asset-etl", {"topic": "t"}, "sdk",
                              target_env="prod")
        rows3 = {a["name"]: a
                 for a in await artifacts_store.list_by_run(r3["run_id"])}
        self.assertEqual(rows3["extract"]["status"], "reused")

    async def test_artifact_gate_approval_paths(self):
        from unittest.mock import patch

        from agent_platform.agent import approvals as approval_store
        from agent_platform.store import artifacts as artifacts_store
        from agent_platform.store import runs
        await self._register_etl_task()
        configure_fake_deps(self.settings, self.defs,
                            model_content='"escalate"')

        async def _approved(approval_id, timeout_s=1800):
            return None

        with patch.object(approval_store, "wait_decision", _approved):
            r = await self.submitter.submit("asset-etl", {"topic": "t"}, "sdk")
        run = await runs.get(r["run_id"])
        self.assertEqual(run["status"], "success")
        self.assertIn("report", run["output"])      # 审批通过 → 物化
        rows = {a["name"]: a
                for a in await artifacts_store.list_by_run(r["run_id"])}
        self.assertEqual(rows["report"]["status"], "materialized")

        async def _rejected(approval_id, timeout_s=1800):
            raise TimeoutError("审批超时")

        with patch.object(approval_store, "wait_decision", _rejected):
            r2 = await self.submitter.submit("asset-etl", {"topic": "t2"},
                                             "sdk")
        run2 = await runs.get(r2["run_id"])
        # 拒绝 = 节点跳过（安全侧默认），不是整个 run 失败
        self.assertEqual(run2["status"], "success")
        self.assertNotIn("report", run2["output"])
        rows2 = {a["name"]: a
                 for a in await artifacts_store.list_by_run(r2["run_id"])}
        self.assertEqual(rows2["report"]["status"], "rejected")

    # ---- 记忆园丁（#5 口子） ----

    async def test_gardener_drift_sweep(self):
        import subprocess

        from agent_platform.config import DomainConfig
        from agent_platform.memory.gardener import run_gardener
        from agent_platform.store import knowledge

        repo = tempfile.mkdtemp()

        def git(*args):
            subprocess.run(["git", "-C", repo, *args], check=True,
                           capture_output=True)

        def head():
            return subprocess.run(
                ["git", "-C", repo, "rev-parse", "HEAD"],
                check=True, capture_output=True, text=True).stdout.strip()

        git("init")
        git("config", "user.email", "t@t")
        git("config", "user.name", "t")
        Path(repo, "a.py").write_text("v1")
        git("add", ".")
        git("commit", "-m", "c1")
        stale_commit = head()
        Path(repo, "a.py").write_text("v2")
        git("commit", "-am", "c2")

        await knowledge.upsert("test", "dagster", "k_stale", "旧结论",
                               code_ref={"path": f"{repo}/a.py",
                                         "commit": stale_commit})
        await knowledge.upsert("test", "dagster", "k_fresh", "新结论",
                               code_ref={"path": f"{repo}/a.py",
                                         "commit": head()})
        await knowledge.upsert("test", "dagster", "k_plain", "无代码引用")

        result = await run_gardener(
            "test", {"dagster": DomainConfig(code_paths=[repo])})
        self.assertEqual(result["drift_expired"], 1)
        self.assertIsNone(result["decay"])       # 口子占位：夜间衰减
        self.assertIsNone(result["conflicts"])   # 口子占位：矛盾仲裁

        rows = {r["key"]: r
                for r in await knowledge.list_all("test",
                                                  include_inactive=True)}
        self.assertTrue(rows["k_stale"]["expired"])    # commit 漂移 → 过期
        self.assertFalse(rows["k_fresh"]["expired"])   # 与 HEAD 一致 → 保留
        self.assertFalse(rows["k_plain"]["expired"])   # 无 code_ref → 不动

    async def test_builtin_gardener_task(self):
        from agent_platform.store import runs
        r = await self.submitter.submit("memory-gardener", {}, "sdk")
        run = await runs.get(r["run_id"])
        self.assertEqual(run["status"], "success")
        # 多目标环境：园丁逐环境巡检，输出按环境分组；单环境实例只有实例标签一档
        self.assertEqual(run["output"]["test"]["drift_expired"], 0)
        self.assertIsNone(run["output"]["test"]["decay"])


if __name__ == "__main__":
    unittest.main()
