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
                " cases, definitions, artifacts, runs CASCADE")

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

    async def test_console_meta_and_overview(self):
        """SPA 引导与总览数据：meta 给环境/域/版本，overview 给聚合。"""
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app
        from agent_platform.api.auth import make_auth_dependency
        from agent_platform.api.console import make_console_router
        app = create_app(self.settings)
        app.include_router(make_console_router(
            self.settings, self.submitter,
            auth=make_auth_dependency("test-token")))
        client = TestClient(app)
        h = {"Authorization": "Bearer test-token"}

        meta = client.get("/v1/console/meta", headers=h).json()
        self.assertEqual(meta["env"], "test")
        self.assertIn("board", meta["domains"])
        self.assertEqual(meta["target_envs"], [])

        ov = client.get("/v1/console/overview", headers=h).json()
        self.assertIn("by_status", ov)

    async def test_console_run_detail_and_rerun(self):
        """详情一整屏数据：run+事件；终态 run 可经 console 重跑。"""
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app
        from agent_platform.api.auth import make_auth_dependency
        from agent_platform.api.console import make_console_router
        r = await self.submitter.submit(
            "data-qa", {"server": "board", "question": "q"}, "sdk")
        app = create_app(self.settings)
        app.include_router(make_console_router(
            self.settings, self.submitter,
            auth=make_auth_dependency("test-token")))
        client = TestClient(app)
        h = {"Authorization": "Bearer test-token"}

        detail = client.get(f"/v1/console/runs/{r['run_id']}", headers=h).json()
        self.assertEqual(detail["run"]["status"], "success")
        self.assertTrue(detail["events"])
        # 普通 agent run 不再有自研轨迹图（观测归 Langfuse iframe；
        # graph 只留给资产图 run 的 graph 事件）
        self.assertIsNone(detail["graph"])
        self.assertEqual(client.get(
            "/v1/console/runs/nope", headers=h).status_code, 404)

        # 成功 run → 重跑新开 run 并跳过去重
        rr = client.post(f"/v1/console/runs/{r['run_id']}/rerun", headers=h)
        self.assertEqual(rr.status_code, 200)
        self.assertNotEqual(rr.json()["run_id"], r["run_id"])

        # 节点级反馈
        seq = detail["events"][0]["seq"]
        fb = client.post(f"/v1/console/runs/{r['run_id']}/steps/{seq}/feedback",
                         headers=h, json={"score": 1})
        self.assertEqual(fb.status_code, 200)

    async def test_console_requires_auth(self):
        """P1 回归：console 端点与 /v1 一样要 bearer。"""
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app
        from agent_platform.api.auth import make_auth_dependency
        from agent_platform.api.console import make_console_router
        app = create_app(self.settings)
        app.include_router(make_console_router(
            self.settings, self.submitter,
            auth=make_auth_dependency("test-token")))
        client = TestClient(app)
        self.assertEqual(client.get("/v1/console/meta").status_code, 401)
        self.assertEqual(client.get("/v1/console/meta", headers={
            "Authorization": "Bearer test-token"}).status_code, 200)

    async def test_legacy_deep_links_redirect(self):
        """旧 viewer 深链（钉钉卡片）301 到 hash 路由，不死链。"""
        from fastapi.testclient import TestClient

        from agent_platform.api.app import create_app
        from agent_platform.web_static import mount_spa
        app = create_app(self.settings)
        mount_spa(app)
        client = TestClient(app, follow_redirects=False)
        resp = client.get("/approvals/abc123")
        self.assertEqual(resp.status_code, 301)
        self.assertEqual(resp.headers["location"], "/#/approvals/abc123")
        resp = client.get("/runs/abc123")
        self.assertEqual(resp.headers["location"], "/#/runs/abc123")

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
        self.assertEqual(len(all_runs), 2)
        prod_runs = client.get("/v1/runs?env=prod", headers=headers).json()
        self.assertEqual(len(prod_runs), 1)
        self.assertEqual(prod_runs[0]["target_env"], "prod")

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
