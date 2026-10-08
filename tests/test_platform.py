"""v2 新能力测试：Langfuse 客户端 / Submitter（Temporal 语义）/ 纠正式反馈 / 记忆时序化。"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).parent))

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


def _fake_httpx(handler):
    """注入假 httpx：handler(method, url, json, headers) -> (status, body)。"""
    class FakeResp:
        def __init__(self, status, body):
            self.status_code, self._body = status, body
            self.text = str(body)

        def json(self):
            return self._body

        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError(f"http {self.status_code}")

    class FakeClient:
        def __init__(self, timeout=None): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, headers=None):
            st, body = handler("GET", url, None, headers)
            return FakeResp(st, body)
        async def post(self, url, json=None, headers=None):
            st, body = handler("POST", url, json, headers)
            return FakeResp(st, body)

    fake = types.ModuleType("httpx")
    fake.AsyncClient = FakeClient
    orig = sys.modules.get("httpx")
    sys.modules["httpx"] = fake
    return orig


class TestLangfuseClient(unittest.TestCase):
    def tearDown(self):
        # 恢复真 httpx
        pass

    def _client(self, enabled=True):
        from agent_platform.langfuse_client import LangfuseClient
        from agent_platform.settings import LangfuseConfig
        return LangfuseClient(LangfuseConfig(
            enabled=enabled, host="http://lf", public_key="pk", secret_key="sk",
            prompt_cache_ttl_s=60))

    def test_fetch_remote_success(self):
        client = self._client()

        def handler(method, url, json, headers):
            assert "role:ops" in url and "label=production" in url
            assert headers["Authorization"].startswith("Basic ")
            return 200, {"prompt": "你是运维", "config": {"tools": ["bash"]}}

        orig = _fake_httpx(handler)
        try:
            d = asyncio.run(client.fetch_role("ops", _NullPg()))
        finally:
            sys.modules["httpx"] = orig
        self.assertEqual(d, {"prompt": "你是运维", "tools": ["bash"]})

    def test_fetch_fallback_chain(self):
        """远端 404 → MAP 过期缓存 → PG 持久缓存。"""
        client = self._client()

        class Pg:
            async def get_cache(self, name): return {"prompt": "pg 里的"}
            async def put_cache(self, name, d): pass

        orig = _fake_httpx(lambda *a: (404, {}))
        try:
            d = asyncio.run(client.fetch_role("ops", Pg()))
        finally:
            sys.modules["httpx"] = orig
        self.assertEqual(d, {"prompt": "pg 里的"})

    def test_disabled_reads_pg_only(self):
        client = self._client(enabled=False)

        class Pg:
            async def get_cache(self, name): return {"prompt": "pg"}
            async def put_cache(self, name, d): pass

        d = asyncio.run(client.fetch_role("ops", Pg()))
        self.assertEqual(d["prompt"], "pg")

    def test_put_role_body(self):
        client = self._client()
        captured = {}

        def handler(method, url, json, headers):
            captured.update(json or {})
            return 200, {}

        orig = _fake_httpx(handler)
        try:
            asyncio.run(client.put_role("ops",
                                        {"prompt": "你是运维", "tools": ["bash"]}))
        finally:
            sys.modules["httpx"] = orig
        self.assertEqual(captured["name"], "role:ops")
        self.assertEqual(captured["prompt"], "你是运维")
        self.assertEqual(captured["config"], {"tools": ["bash"]})
        self.assertEqual(captured["labels"], ["production"])

    def test_score(self):
        client = self._client()
        captured = {}

        def handler(method, url, json, headers):
            captured.update(json or {})
            return 200, {}

        orig = _fake_httpx(handler)
        try:
            ok = asyncio.run(client.score("t" * 32, "user_feedback", 0.0,
                                          comment="答非所问"))
        finally:
            sys.modules["httpx"] = orig
        self.assertTrue(ok)
        self.assertEqual(captured["traceId"], "t" * 32)
        self.assertEqual(captured["value"], 0.0)


class _NullPg:
    async def get_cache(self, name): return None
    async def put_cache(self, name, d): pass


class TestSubmitter(unittest.TestCase):
    """Submitter 的 Temporal 语义：resume 的 ID 复用策略、dedup、未知任务拒绝。"""

    def test_resume_uses_failed_only_reuse_policy(self):
        from agent_platform.orchestration.submitter import Submitter
        from fakes import FakeTemporalClient

        client = FakeTemporalClient(execute=False)
        sub = Submitter(client, _FakeTasks(), "tq", "test")

        async def scenario():
            from agent_platform.store import ledger
            await ledger.create_run("r-x", "data-qa", "assistant", None,
                                    "sdk", None, {"question": "q"}, None)
            await ledger.set_status("r-x", "failed", output={"error": "boom"})
            return await sub.resume_run("r-x")

        _run_with_pg(scenario)
        id_, spec, kw = client.started[-1]
        self.assertEqual(id_, "r-x")
        from temporalio.common import WorkflowIDReusePolicy
        self.assertEqual(kw["id_reuse_policy"],
                         WorkflowIDReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY)

    def test_resume_done_rejected(self):
        from agent_platform.orchestration.submitter import (Submitter,
                                                            TaskRejected)
        from fakes import FakeTemporalClient

        sub = Submitter(FakeTemporalClient(execute=False), _FakeTasks(), "tq", "test")

        async def scenario():
            from agent_platform.store import ledger
            await ledger.create_run("r-done", "data-qa", "assistant", None,
                                    "sdk", None, {}, None)
            await ledger.set_status("r-done", "done", output={})
            with self.assertRaises(TaskRejected):
                await sub.resume_run("r-done")

        _run_with_pg(scenario)

    def test_unknown_task_rejected(self):
        from agent_platform.orchestration.submitter import (Submitter,
                                                            TaskRejected)
        from fakes import FakeTemporalClient

        sub = Submitter(FakeTemporalClient(execute=False), _FakeTasks(), "tq", "test")

        async def scenario():
            with self.assertRaises(TaskRejected):
                await sub.submit("nope", {}, trigger_source="sdk")

        _run_with_pg(scenario)

    def test_correct_inherits_session_context(self):
        """纠正重判继承 session 最近 run 的 task_type/role/domain，不写死。"""
        from agent_platform.orchestration.submitter import Submitter
        from fakes import FakeTemporalClient

        client = FakeTemporalClient(execute=False)
        sub = Submitter(client, _FakeTasks(), "tq", "test")
        sid = "dagster:a.x:infra:2026-10-07"

        async def scenario():
            from agent_platform.store import ledger
            await ledger.create_run("r-orig", "failure-analysis", "ops_analyst",
                                    "dagster", "sensor", None,
                                    {"error": "oom", "asset_key": "a.x"}, None,
                                    session_id=sid)
            result = await sub.correct(sid, "漏看了上游分区缺失", by="me")
            new_run = await ledger.get_run(result["run_id"])
            return result, new_run

        result, new_run = _run_with_pg(scenario)
        self.assertEqual(result["session_id"], sid)
        self.assertNotEqual(result["run_id"], "r-orig")
        self.assertEqual(new_run["task_type"], "failure-analysis")
        self.assertEqual(new_run["role"], "ops_analyst")
        self.assertEqual(new_run["domain"], "dagster")
        self.assertEqual(new_run["input"]["correction"], "漏看了上游分区缺失")
        # spec 里带 correction 标记
        _, spec, _ = client.started[-1]
        self.assertTrue(spec["correction"])
        self.assertEqual(spec["session_id"], sid)

    def test_correct_unknown_session_rejected(self):
        from agent_platform.orchestration.submitter import (Submitter,
                                                            TaskRejected)
        from fakes import FakeTemporalClient

        sub = Submitter(FakeTemporalClient(execute=False), _FakeTasks(), "tq", "test")

        async def scenario():
            with self.assertRaises(TaskRejected):
                await sub.correct("sess-nothing", "纠正")

        _run_with_pg(scenario)


class _FakeTasks:
    async def get(self, name):
        from agent_platform.tasks import TaskDef
        if name == "data-qa":
            return TaskDef(name="data-qa", role="assistant", timeout_s=30)
        if name == "failure-analysis":
            return TaskDef(name="failure-analysis", role="ops_analyst",
                           timeout_s=300)
        return None




@unittest.skipUnless(HAS_PG, "pgserver 不可用")
class TestCorrectiveFeedback(unittest.TestCase):
    """纠正式反馈闭环：旧记忆被取代（valid_to）、新结论沉淀。"""

    @classmethod
    def setUpClass(cls):
        cls._pg = pgserver.get_server(tempfile.mkdtemp())
        cls.dsn = cls._pg.get_uri()

    @classmethod
    def tearDownClass(cls):
        cls._pg.cleanup()

    def test_correction_supersedes_old_memory(self):
        _run_with_pg(self._scenario, dsn=self.dsn)

    async def _scenario(self):
        from agent_platform.orchestration import activities
        from agent_platform.store import cases, knowledge, ledger
        from fakes import configure_fake_deps

        settings = _settings(db={"dsn": self.dsn})
        from agent_platform.store.definitions import DefinitionStore
        defs = DefinitionStore()
        await defs.put("role", "test", "assistant",
                       {"description": "", "tools": [], "prompt": "助手"})
        configure_fake_deps(settings, defs)

        # 旧 run 沉淀了知识
        await ledger.create_run("r-old", "data-qa", "assistant", None,
                                "sdk", None, {}, None, session_id="sess-1")
        await knowledge.upsert("test", "board", "metric:total_fee",
                               "错误口径：sum(fee)", source_run="r-old")
        # 纠正 run 到来
        await ledger.create_run("r-new", "data-qa", "assistant", None,
                                "feedback", None, {}, None, session_id="sess-1")
        spec = {"run_id": "r-new", "task_type": "data-qa", "role": "assistant",
                "question": "纠正：total_fee 还要乘汇率", "domain": "board",
                "session_id": "sess-1", "correction": True}
        await activities.finalize_run(spec, {"answer": "修正后：sum(fee*rate)"})

        # 旧知识被取代，不再召回
        hits = await knowledge.search("test", "board", "total_fee")
        for h in hits:
            entry = await knowledge.get_entry(h["id"])
            self.assertIsNone(entry["valid_to"])
        superseded = await knowledge.list_all("test", "board",
                                              include_inactive=True)
        old = [i for i in superseded if i["content"] == "错误口径：sum(fee)"]
        self.assertEqual(len(old), 1)
        self.assertTrue(old[0]["superseded"])

    def test_correction_supersedes_only_latest_run(self):
        _run_with_pg(self._latest_only, dsn=self.dsn)

    async def _latest_only(self):
        from agent_platform.orchestration import activities
        from agent_platform.store import knowledge, ledger
        from fakes import configure_fake_deps

        settings = _settings(db={"dsn": self.dsn})
        from agent_platform.store.definitions import DefinitionStore
        defs = DefinitionStore()
        await defs.put("role", "test", "assistant",
                       {"description": "", "tools": [], "prompt": "助手"})
        configure_fake_deps(settings, defs)

        # 同 session 两个旧 run 各自沉淀了知识
        await ledger.create_run("r-old1", "data-qa", "assistant", None,
                                "sdk", None, {}, None, session_id="sess-2")
        await knowledge.upsert("test", "board", "metric:a",
                               "更早的结论（正确）", source_run="r-old1")
        await ledger.create_run("r-old2", "data-qa", "assistant", None,
                                "sdk", None, {}, None, session_id="sess-2")
        await knowledge.upsert("test", "board", "metric:b",
                               "最近的结论（错误）", source_run="r-old2")
        await ledger.create_run("r-new2", "data-qa", "assistant", None,
                                "feedback", None, {}, None, session_id="sess-2")
        spec = {"run_id": "r-new2", "task_type": "data-qa", "role": "assistant",
                "question": "纠正：metric:b 口径错了", "domain": "board",
                "session_id": "sess-2", "correction": True}
        await activities.finalize_run(spec, {"answer": "修正"})

        all_items = await knowledge.list_all("test", "board",
                                             include_inactive=True)
        older = [i for i in all_items if i["content"] == "更早的结论（正确）"]
        latest = [i for i in all_items if i["content"] == "最近的结论（错误）"]
        # 只杀最近一次：更早的正确历史不受影响
        self.assertFalse(older[0]["superseded"])
        self.assertTrue(latest[0]["superseded"])

    def test_definitions_cache_put_idempotent(self):
        _run_with_pg(self._cache, dsn=self.dsn)

    async def _cache(self):
        from agent_platform.store.definitions import DefinitionStore
        store = DefinitionStore()
        await store.put("role", "test", "r1", {"prompt": "v1"})
        n = len(await store.history("role", "test", "r1"))
        await store.cache_put("role", "test", "r1", {"prompt": "v1"})  # 同内容
        self.assertEqual(len(await store.history("role", "test", "r1")), n)
        await store.cache_put("role", "test", "r1", {"prompt": "v2"})  # 变了
        self.assertEqual(len(await store.history("role", "test", "r1")), n + 1)


def _run_with_pg(coro_factory, dsn=None):
    """单事件循环内 开池→业务→关池（池绑 loop）。"""
    from agent_platform.store.db import close_pool, open_and_migrate

    if dsn is None:
        if not HAS_PG:
            raise unittest.SkipTest("pgserver 不可用")
        pg = pgserver.get_server(tempfile.mkdtemp())
        dsn = pg.get_uri()

    async def _wrap():
        await open_and_migrate(dsn)
        try:
            return await coro_factory()
        finally:
            await close_pool()

    return asyncio.run(_wrap())


class TestDagsterSessionId(unittest.TestCase):
    """session_id = dagster:{asset}:{error_class}:{episode}：同类连续，跨类分线。"""

    def test_format_and_episode(self):
        from agent_platform.tasks.triggers.dagster_sensor import session_id_for
        sid = session_id_for("my_schema.my_asset",
                             "duplicate key value violates unique constraint",
                             day="2026-10-07")
        self.assertEqual(sid, "dagster:my_schema.my_asset:data:2026-10-07")

    def test_class_changes_line(self):
        from agent_platform.tasks.triggers.dagster_sensor import session_id_for
        a = session_id_for("a.x", "out of memory", day="2026-10-07")
        b = session_id_for("a.x", "duplicate key", day="2026-10-07")
        self.assertNotEqual(a, b)
        c = session_id_for("a.x", "out of memory", day="2026-10-07")
        self.assertEqual(a, c)  # 同类同天复用

    def test_unknown_class(self):
        from agent_platform.tasks.triggers.dagster_sensor import session_id_for
        sid = session_id_for("a.x", "某种奇怪报错", day="2026-10-07")
        self.assertIn(":unknown:", sid)


@unittest.skipUnless(HAS_PG, "pgserver 不可用")
class TestMemoryContinuity(unittest.TestCase):
    """交接摘要跨 episode 召回置顶 + asset profile 逐字保留 + 升舱计数。"""

    @classmethod
    def setUpClass(cls):
        cls._pg = pgserver.get_server(tempfile.mkdtemp())
        cls.dsn = cls._pg.get_uri()

    @classmethod
    def tearDownClass(cls):
        cls._pg.cleanup()

    def test_summary_and_profile_recalled_first(self):
        _run_with_pg(self._recall, dsn=self.dsn)

    async def _recall(self):
        from agent_platform.memory import recall_block
        from agent_platform.store import knowledge

        await knowledge.upsert("test", "board", "asset:a.x:profile",
                               "负责人：张三；上游：b.y；口径含退款")
        await knowledge.upsert("test", "board",
                               "session:dagster:a.x:data:2026-10-06:summary",
                               "## 结论\n根因是上游分区缺失\n\n## 被否方案\n已排除网络问题")
        await knowledge.upsert("test", "board", "metric:total_fee",
                               "sum(fee) 排除退款单")

        block = await recall_block(
            "test", "board", "分析 a.x 的 total_fee 报错",
            session_id="dagster:a.x:data:2026-10-07")
        self.assertIn("[资产档案——逐字保留的事实，优先级最高]", block)
        self.assertIn("[前序会话交接摘要]", block)
        self.assertIn("根因是上游分区缺失", block)
        self.assertIn("负责人：张三", block)
        # 档案置顶：profile 出现在交接摘要之前
        self.assertLess(block.index("资产档案"), block.index("前序会话"))

    def test_distill_writes_handoff_summary(self):
        _run_with_pg(self._distill, dsn=self.dsn)

    async def _distill(self):
        from agent_platform.memory import distill
        from agent_platform.store import knowledge

        class _Pool:  # 第一次返回提炼 JSON，第二次返回四节摘要
            embed = None

            def __init__(self):
                self._responses = ["[]", "## 结论\n修好了\n\n## 被否方案\n无"]

            async def chat(self, messages, **kw):
                text = self._responses.pop(0)
                msg = type("M", (), {"content": text})()
                return type("R", (),
                            {"choices": [type("C", (), {"message": msg})()]})()

        await distill(_Pool(), "test", "board", "r-sum", "failure-analysis",
                      {"question": "a.x 报错"}, {"answer": "上游缺分区"}, [],
                      session_id="dagster:a.x:data:2026-10-07")
        summaries = await knowledge.latest_session_summaries(
            "test", "dagster:a.x:data")
        self.assertEqual(len(summaries), 1)
        self.assertTrue(summaries[0]["content"].startswith("## 结论"))

    def test_correction_escalation_counts(self):
        _run_with_pg(self._counts, dsn=self.dsn)

    async def _counts(self):
        from agent_platform.store import feedback
        for i in range(3):
            await feedback.add_correction("sess-hot", f"纠正{i}")
        await feedback.add_correction("sess-cold", "只纠正一次")
        hot = await feedback.correction_counts(min_count=3)
        self.assertEqual([h["session_id"] for h in hot], ["sess-hot"])


if __name__ == "__main__":
    unittest.main()
