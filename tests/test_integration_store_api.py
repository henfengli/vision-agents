"""真实 Postgres + FastAPI 全链路集成测试。

用 pgserver 起内嵌 Postgres（无需 root），覆盖：
- 建表迁移幂等
- 版本化定义：put/get/list/history/rollback + 缓存热生效
- 台账生命周期 + dedup 命中
- 知识库 upsert/search + code_ref commit 失效校验（真实 git 仓库）
- 案例库指纹去重 + 反馈计数
- 审批流：请求 → 放行/拒绝
- API：/v1/ask 端到端（fake agent）、admin CRUD、viewer 页面、鉴权 401
"""

import asyncio
import re
import subprocess
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


def _settings(**over):
    from agent_platform.settings import Settings
    base = dict(
        env="test",
        model={"url": "http://llm/v1", "name": "m", "tokens": ["t"]},
        db={"dsn": "postgresql://placeholder"},
        dingtalk={"relay_url": "http://relay", "access_token": "x"},
        viewer_base_url="http://viewer",
        bearer_token="test-token",
        scratch_dir=tempfile.mkdtemp(),
        domains={"board": {"code_paths": ["/tmp/board"]}},
    )
    base.update(over)
    return Settings.model_validate(base)


class FakeCompletions:
    async def create(self, model, messages, **kw):
        msg = type("M", (), {"content": "[]"})()
        return type("R", (), {"choices": [type("C", (), {"message": msg})()]})()


class FakePool:
    def __init__(self):
        self.chat = FakeCompletions().create


class FakeAgent:
    async def ainvoke(self, payload, config):
        from langchain_core.messages import AIMessage
        q = payload["messages"][-1]["content"]
        return {"messages": [AIMessage(content=f"answer: {q[:60]}")]}


class FakeEngine:
    def __init__(self, role_defs):
        self._defs = role_defs

    async def roles(self):
        return self._defs

    async def agent(self):
        return FakeAgent()


@unittest.skipUnless(HAS_PG, "pgserver 不可用")
class TestStoreAndApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._pg_dir = tempfile.mkdtemp()
        cls._pg = pgserver.get_server(cls._pg_dir)
        cls.dsn = cls._pg.get_uri()

    @classmethod
    def tearDownClass(cls):
        cls._pg.cleanup()

    def run_with_db(self, coro):
        """psycopg 异步连接池绑定创建它的 loop，跨 asyncio.run 复用会死锁。

        因此每个用例在单个事件循环内完成 开池→业务→关池。
        """
        from agent_platform.store.db import close_pool, open_and_migrate

        async def _wrap():
            await open_and_migrate(self.dsn)
            try:
                return await coro
            finally:
                await close_pool()

        return asyncio.run(_wrap())

    def test_migrate_idempotent(self):
        self.run_with_db(self._migrate_twice())

    async def _migrate_twice(self):
        from agent_platform.store.db import open_and_migrate
        await open_and_migrate(self.dsn)  # 第二次不报错即幂等

    def test_definitions_lifecycle(self):
        self.run_with_db(self._definitions())

    async def _definitions(self):
        from agent_platform.store.definitions import DefinitionStore
        store = DefinitionStore()
        v1 = await store.put("role", "test", "r1", {"description": "v1"})
        v2 = await store.put("role", "test", "r1", {"description": "v2"})
        self.assertEqual((v1, v2), (1, 2))
        active = await store.get_active("role", "test", "r1")
        self.assertEqual(active["description"], "v2")
        history = await store.history("role", "test", "r1")
        self.assertEqual(len(history), 2)
        await store.rollback("role", "test", "r1", version=1)
        active = await store.get_active("role", "test", "r1")
        self.assertEqual(active["description"], "v1")
        # 缓存热生效：短 TTL 内连续读不穿透（无断言，覆盖缓存路径即可）
        await store.get_active("role", "test", "r1")

    def test_ledger_and_dedup(self):
        self.run_with_db(self._ledger())

    async def _ledger(self):
        from agent_platform.store import ledger
        await ledger.create_run("r-1", "failure-analysis", "ops", "dagster",
                                "sensor", "dagster", {"x": 1}, "dk-1")
        hit = await ledger.find_recent_by_dedup("dk-1", 600)
        self.assertEqual(hit, "r-1")
        await ledger.set_status("r-1", "done", output={"answer": "ok"},
                                tokens=100, duration_ms=50)
        await ledger.append_event("r-1", 1, "tool_call", {"cmd": "echo hi"})
        run = await ledger.get_run("r-1")
        self.assertEqual(run["status"], "done")
        self.assertEqual(run["output"]["answer"], "ok")
        events = await ledger.get_events("r-1")
        self.assertEqual(len(events), 1)

    def test_knowledge_commit_invalidation(self):
        self.run_with_db(self._knowledge())

    async def _knowledge(self):
        from agent_platform.store import knowledge

        repo = tempfile.mkdtemp()
        subprocess.run(["git", "init", "-q", repo], check=True)
        subprocess.run(["git", "-C", repo, "commit", "-q", "--allow-empty",
                        "-m", "c1"], check=True,
                       env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                            "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
                            "PATH": "/usr/bin:/bin"})
        commit1 = knowledge.current_commit(repo)
        self.assertIsNotNone(commit1)

        code_ref = {"path": f"{repo}/metrics.sql", "commit": commit1}
        await knowledge.upsert("test", "board", "metric:total_fee",
                               "sum(fee)", code_ref=code_ref)
        hits = await knowledge.search("test", "board", "total_fee 是多少")
        self.assertEqual(len(hits), 1)
        # commit 未变 → 新鲜
        self.assertTrue(knowledge.is_entry_fresh(hits[0]["code_ref"], [repo]))
        # 代码前进一个 commit → 失效
        subprocess.run(["git", "-C", repo, "commit", "-q", "--allow-empty",
                        "-m", "c2"], check=True,
                       env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                            "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
                            "PATH": "/usr/bin:/bin"})
        self.assertFalse(knowledge.is_entry_fresh(hits[0]["code_ref"], [repo]))

    def test_cases_dedup_and_feedback(self):
        self.run_with_db(self._cases())

    async def _cases(self):
        from agent_platform.store import cases
        err = 'psycopg.errors.UniqueViolation: duplicate key "pk_1"\nKey (id)=(1) exists.'
        await cases.add("test", "dagster", err, "data", "主键冲突", "run-1")
        await cases.add("test", "dagster", err.replace("(1)", "(2)"), "data",
                        "主键冲突", "run-2")  # 同指纹应合并而非新建
        hit = await cases.search_by_error("test", err)
        self.assertEqual(hit["category"], "data")
        # 反馈闭环：run 的 👍 通过 propagate_to_memory 回写到它沉淀的案例
        # （同指纹合并后 source_run 为最后一次写入的 run-2）
        from agent_platform.store import feedback
        await feedback.propagate_to_memory("test", "run-2", 1)
        hit = await cases.search_by_error("test", err)
        self.assertEqual(hit["thumbs_up"], 1)

    def test_approval_flow(self):
        self.run_with_db(self._approvals())

    async def _approvals(self):
        from agent_platform.runtime import approvals
        from agent_platform.store import ledger
        await ledger.create_run("r-appr", "t", "ops", None, "sdk", None, {}, None)
        aid = await approvals.request_approval("r-appr", "rm -rf /tmp/x")
        waiter = asyncio.create_task(approvals.wait_decision(aid, timeout_s=10,
                                                             poll_s=0.05))
        await asyncio.sleep(0.1)
        await approvals.decide(aid, approved=True, decided_by="admin")
        await waiter  # 放行：不抛异常

        aid2 = await approvals.request_approval("r-appr", "drop table t")
        waiter2 = asyncio.create_task(approvals.wait_decision(aid2, timeout_s=10,
                                                              poll_s=0.05))
        await asyncio.sleep(0.1)
        await approvals.decide(aid2, approved=False)
        with self.assertRaises(approvals.ApprovalRejected):
            await waiter2

    def test_knowledge_trgm_ranking(self):
        self.run_with_db(self._trgm())

    async def _trgm(self):
        from agent_platform.store import knowledge
        await knowledge.upsert("test", "board", "metric:total_fee",
                               "total_fee = sum(order.fee)，口径见 metrics.sql")
        await knowledge.upsert("test", "board", "metric:uv",
                               "uv = count(distinct user_id)")
        hits = await knowledge.search("test", "board", "total_fee 怎么算")
        self.assertGreaterEqual(len(hits), 1)
        self.assertEqual(hits[0]["key"], "metric:total_fee")  # 相似度最高的排第一



    def test_chat_stream_sse(self):
        self.run_with_db(self._sse())

    async def _sse(self):
        import httpx
        from agent_platform.gateway import create_app, make_gateway_router
        from agent_platform.store.definitions import DefinitionStore
        from agent_platform.tasks import Submitter, TaskRegistry
        from agent_platform.tasks.triggers import chat as chat_trigger
        from fakes import FakeTemporalClient, configure_fake_deps

        settings = _settings()
        defs = DefinitionStore()
        await defs.put("role", "test", "data_searcher",
                       {"description": "查询", "tools": [], "prompt": "助手"})
        await defs.put("task", "test", "data-qa",
                       {"role": "data_searcher", "triggers": ["web_chat"],
                        "output_channel": "caller", "timeout_s": 30})
        configure_fake_deps(settings, defs)
        submitter = Submitter(FakeTemporalClient(), TaskRegistry(defs, "test"),
                              "tq", "test")
        app = create_app(settings)
        app.include_router(make_gateway_router(settings, submitter,
                                               TaskRegistry(defs, "test"), defs))
        app.include_router(chat_trigger.make_router(submitter))
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport,
                                     base_url="http://t") as c:
            events = []
            async with c.stream("POST", "/v1/chat/stream", json={
                    "server": "board", "role": "data_searcher",
                    "question": "q"}) as resp:
                self.assertEqual(resp.status_code, 200)
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        import json
                        events.append(json.loads(line[6:]))
            types = [e["type"] for e in events]
            self.assertEqual(types[0], "run")
            self.assertIn("final", types)
            final = events[types.index("final")]
            self.assertEqual(final["status"], "done")

    def test_api_end_to_end(self):
        self.run_with_db(self._api())

    async def _api(self):
        import httpx
        from agent_platform.gateway import create_app, make_gateway_router
        from agent_platform.store import ledger
        from agent_platform.store.definitions import DefinitionStore
        from agent_platform.tasks import Submitter, TaskRegistry
        from agent_platform.viewer import make_viewer_router
        from fakes import FakeTemporalClient, configure_fake_deps

        settings = _settings()
        defs = DefinitionStore()
        await defs.put("role", "test", "data_searcher",
                       {"description": "查询", "tools": [], "prompt": "助手"})
        await defs.put("task", "test", "data-qa",
                       {"role": "data_searcher", "triggers": ["sdk"],
                        "output_channel": "caller", "timeout_s": 30})
        configure_fake_deps(settings, defs)
        submitter = Submitter(FakeTemporalClient(), TaskRegistry(defs, "test"),
                              "tq", "test")
        app = create_app(settings)
        app.include_router(make_gateway_router(settings, submitter,
                                               TaskRegistry(defs, "test"), defs))
        app.include_router(make_viewer_router(submitter, defs, "test"))
        auth = {"Authorization": "Bearer test-token"}
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport,
                                     base_url="http://t") as c:
            r = await c.get("/v1/tasks/x")
            self.assertEqual(r.status_code, 401)
            r = await c.post("/v1/ask",
                             json={"server": "board", "question": "total_fee"},
                             headers=auth)
            self.assertEqual(r.status_code, 200, r.text)
            data = r.json()
            self.assertIn("run_id", data)
            run = await ledger.get_run(data["run_id"])
            self.assertEqual(run["status"], "done")
            # 角色定义非法被拒
            r = await c.post("/v1/admin/roles", json={
                "name": "bad", "definition": {"tools": "notalist"},
                "updated_by": "t"}, headers=auth)
            self.assertEqual(r.status_code, 422)
            r = await c.get("/admin")
            self.assertEqual(r.status_code, 200)
            r = await c.get("/memory")
            self.assertEqual(r.status_code, 200)
