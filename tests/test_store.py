"""PG 存储层测试：pgserver 内嵌 Postgres（不可用时整文件跳过）。"""

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


@unittest.skipUnless(HAS_PG, "pgserver 不可用")
class TestStore(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls._pg = pgserver.get_server(tempfile.mkdtemp())

    @classmethod
    def tearDownClass(cls):
        cls._pg.cleanup()

    async def asyncSetUp(self):
        from agent_platform.store import db
        self.dsn = self._pg.get_uri()
        await db.open_db(self.dsn)
        await self._truncate()

    async def asyncTearDown(self):
        from agent_platform.store import db
        await db.close_db()

    async def _truncate(self):
        from agent_platform.store import db
        async with db.pool().connection() as conn:
            await conn.execute(
                "TRUNCATE run_events, feedback, approvals, knowledge,"
                " cases, definitions, runs CASCADE")

    async def test_schema_idempotent(self):
        from agent_platform.store import db
        await db.open_db(self.dsn)  # 重复 open 不报错即幂等（先关再开会重建池）
        await db.close_db()
        await db.open_db(self.dsn)

    # ---- runs ----

    async def test_run_lifecycle(self):
        from agent_platform.store import runs
        await runs.create("r1", "data-qa", "data_searcher", "board",
                          "sdk", "tester", {"question": "q"}, dedup_key="k1")
        run = await runs.get("r1")
        self.assertEqual(run["status"], "queued")
        self.assertEqual(run["session_id"], "r1")  # 无会话时自会话
        await runs.set_status("r1", "success", {"answer": "a"}, tokens=10)
        run = await runs.get("r1")
        self.assertEqual(run["status"], "success")
        self.assertEqual(run["output"], {"answer": "a"})

    async def test_dedup_hit(self):
        from agent_platform.store import runs
        await runs.create("r1", "t", "r", None, "sdk", "", {}, dedup_key="dk")
        await runs.set_status("r1", "success", {})
        hit = await runs.find_by_dedup("dk", 600)
        self.assertEqual(hit["run_id"], "r1")
        self.assertIsNone(await runs.find_by_dedup("dk", 0))  # 窗口外
        self.assertIsNone(await runs.find_by_dedup("", 600))  # 空键不查

    async def test_latest_of_session(self):
        from agent_platform.store import runs
        await runs.create("r1", "t", "r", "dagster", "sdk", "", {"i": 1},
                          session_id="s1")
        await runs.create("r2", "t2", "r2", "dagster", "sdk", "", {"i": 2},
                          session_id="s1")
        last = await runs.latest_of_session("s1", exclude="r2")
        self.assertEqual(last["run_id"], "r1")
        self.assertEqual(last["task_type"], "t")
        self.assertTrue(await runs.session_exists("s1"))
        self.assertFalse(await runs.session_exists("nope"))

    async def test_log_event_seq_monotonic(self):
        from agent_platform.store import runs
        await runs.create("r1", "t", "r", None, "sdk", "", {})
        await runs.log_event("r1", "note", {"n": 1})
        await runs.log_event("r1", "note", {"n": 2})
        events = await runs.get_events("r1")
        self.assertEqual([e["seq"] for e in events], [1, 2])

    # ---- definitions ----

    async def test_definitions_versioning_and_rollback(self):
        from agent_platform.store.definitions import DefinitionStore
        defs = DefinitionStore()
        v1 = await defs.put("role", "test", "r1", {"prompt": "v1"}, updated_by="a")
        v2 = await defs.put("role", "test", "r1", {"prompt": "v2"}, updated_by="b")
        self.assertEqual((v1, v2), (1, 2))
        self.assertEqual((await defs.get_active("role", "test", "r1"))["prompt"], "v2")
        history = await defs.history("role", "test", "r1")
        self.assertEqual([h["version"] for h in history], [2, 1])
        await defs.rollback("role", "test", "r1", 1)
        self.assertEqual((await defs.get_active("role", "test", "r1"))["prompt"], "v1")

    async def test_definitions_cache_put_idempotent(self):
        from agent_platform.store.definitions import DefinitionStore
        defs = DefinitionStore()
        await defs.put("role", "test", "r1", {"prompt": "p"})
        await defs.cache_put("role", "test", "r1", {"prompt": "p"})  # 内容一致
        self.assertEqual(len(await defs.history("role", "test", "r1")), 1)
        await defs.cache_put("role", "test", "r1", {"prompt": "p2"})
        self.assertEqual(len(await defs.history("role", "test", "r1")), 2)

    # ---- knowledge ----

    async def test_knowledge_upsert_replaces(self):
        from agent_platform.store import knowledge
        await knowledge.upsert("test", "board", "metric:fee", "口径v1")
        await knowledge.upsert("test", "board", "metric:fee", "口径v2")
        entries = await knowledge.search("test", "board", "口径")
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["content"], "口径v2")

    async def test_knowledge_supersede_hides_from_search(self):
        from agent_platform.store import knowledge
        await knowledge.upsert("test", "board", "k1", "旧结论", source_run="r1")
        n = await knowledge.supersede_by_runs("test", ["r1"], superseded_by="r2")
        self.assertEqual(n, 1)
        self.assertEqual(await knowledge.search("test", "board", "旧结论"), [])
        # 历史保留可审计
        all_rows = await knowledge.list_all("test", include_inactive=True)
        self.assertEqual(len(all_rows), 1)
        self.assertTrue(all_rows[0]["superseded"])

    async def test_knowledge_search_ilike_fallback(self):
        from agent_platform.store import knowledge
        await knowledge.upsert("test", "board", "metric:total_fee",
                               "total_fee 是含税总金额")
        hits = await knowledge.search("test", "board", "total_fee 口径")
        self.assertTrue(any(h["key"] == "metric:total_fee" for h in hits))

    async def test_session_summaries_and_profiles(self):
        from agent_platform.store import knowledge
        await knowledge.upsert("test", "dagster", "session:dagster:a:infra:2026-10-07:summary",
                               "## 结论\n旧摘要")
        await knowledge.upsert("test", "dagster", "session:dagster:a:infra:2026-10-08:summary",
                               "## 结论\n新摘要")
        sums = await knowledge.latest_session_summaries("test", "dagster:a:infra")
        self.assertEqual(len(sums), 2)
        self.assertIn("新摘要", sums[0]["content"])  # 最新在前

        await knowledge.upsert("test", "dagster", "asset:orders_daily:profile",
                               "负责人张三，上游 crm.orders")
        profiles = await knowledge.asset_profiles("test", "dagster",
                                                  "orders_daily 报错")
        self.assertEqual(len(profiles), 1)
        self.assertEqual(await knowledge.asset_profiles("test", "dagster",
                                                        "别的资产"), [])

    # ---- cases ----

    async def test_cases_upsert_and_search(self):
        from agent_platform.store import cases
        err = 'psycopg.errors.UniqueViolation: duplicate key "42"'
        await cases.add("test", "dagster", err, "data", "上游重复投递", "r1")
        case = await cases.search_by_error(  # 同指纹：仅数字不同
            "test", 'psycopg.errors.UniqueViolation: duplicate key "9999"')
        self.assertIsNotNone(case)
        self.assertEqual(case["category"], "data")

    async def test_cases_supersede(self):
        from agent_platform.store import cases
        await cases.add("test", "dagster", "some error xyz", "code", "结论", "r1")
        n = await cases.supersede_by_runs("test", ["r1"], "r2")
        self.assertEqual(n, 1)
        self.assertIsNone(await cases.search_by_error("test", "some error xyz"))

    # ---- feedback ----

    async def test_feedback_propagates_to_memory(self):
        from agent_platform.store import cases, feedback, knowledge, runs
        await runs.create("r1", "t", "r", None, "sdk", "", {})
        await knowledge.upsert("test", "board", "k1", "内容", source_run="r1")
        await cases.add("test", "dagster", "fp error", "code", "c", "r1")
        await feedback.add("r1", 1)
        await feedback.propagate_to_memory("test", "r1", 1)
        case = await cases.search_by_error("test", "fp error")
        self.assertEqual(case["thumbs_up"], 1)
        entries = await knowledge.list_all("test")
        self.assertEqual(entries[0]["feedback_score"], 1)

    async def test_correction_counts(self):
        from agent_platform.store import feedback
        for i in range(3):
            await feedback.add_correction("s1", f"纠正{i}", by="u")
        rows = await feedback.correction_counts(min_count=3)
        self.assertEqual(rows[0]["count"], 3)

    # ---- approvals ----

    async def test_approval_flow(self):
        from agent_platform.agent import approvals
        aid = await approvals.request_approval("r1", "rm -rf /tmp/x")
        pending = await approvals.find_pending("r1")
        self.assertEqual(pending["id"], aid)
        await approvals.decide(aid, True, decided_by="ops")
        self.assertIsNone(await approvals.find_pending("r1"))


if __name__ == "__main__":
    unittest.main()
