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
                " cases, definitions, runs, assets CASCADE")

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

    async def test_caller_fallback(self):
        """caller 约定：身份缺失时回退 trigger_source，永不落空串/空白。"""
        from agent_platform.store import runs
        await runs.create("rc1", "t", "r", None, "schedule", "", {})
        self.assertEqual((await runs.get("rc1"))["caller"], "schedule")
        await runs.create("rc2", "t", "r", None, "sensor", "  ", {})
        self.assertEqual((await runs.get("rc2"))["caller"], "sensor")
        await runs.create("rc3", "t", "r", None, "sdk", " board-svc ", {})
        self.assertEqual((await runs.get("rc3"))["caller"], "board-svc")

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

    async def test_update_content_recomputes_embedding(self):
        """网页编辑必须重算向量：只改文本不改向量会让语义召回按旧内容匹配。"""
        from agent_platform.store import knowledge
        calls = []

        async def fake_embed(texts):
            calls.append(texts)
            return [[0.01] * 1024]

        await knowledge.upsert("test", "board", "k_embed", "旧内容")
        entries = await knowledge.list_all("test", "board")
        eid = next(e["id"] for e in entries if e["key"] == "k_embed")
        await knowledge.update_content(eid, "新内容", embedder=fake_embed)
        self.assertEqual(calls, [["新内容"]])
        entry = await knowledge.get_entry(eid)
        self.assertEqual(entry["content"], "新内容")

        # 无 pgvector 环境：向量写失败也要退化为纯文本更新，不报错
        calls.clear()
        await knowledge.update_content(eid, "再次编辑", embedder=fake_embed)
        self.assertEqual((await knowledge.get_entry(eid))["content"], "再次编辑")

    async def test_recall_hits_usage_map(self):
        """召回埋点 → 使用统计：命中次数/去重 run/最后命中；playground 不算。"""
        from agent_platform.store import knowledge
        await knowledge.upsert("test", "board", "k_used", "被用到的知识")
        entries = await knowledge.list_all("test", "board")
        eid = next(e["id"] for e in entries if e["key"] == "k_used")
        await knowledge.record_hits("test", "board", [{"id": eid}],
                                    run_id="r1")
        await knowledge.record_hits("test", "board", [{"id": eid}],
                                    run_id="r2")
        await knowledge.record_hits("test", "board", [{"id": eid}],
                                    source="playground")  # 试用不算使用
        usage = await knowledge.usage_map("test")
        self.assertEqual(usage[eid]["hits"], 2)
        self.assertEqual(usage[eid]["runs"], 2)
        self.assertIsNotNone(usage[eid]["last_hit"])
        recent = await knowledge.recent_hits(eid)
        self.assertEqual(len(recent), 3)  # recent_hits 全量含试用
        self.assertEqual(recent[0]["source"], "playground")

    async def test_search_feedback_weighting(self):
        """反馈加权：同候选里负反馈条目排到最后（trgm 路径统一公式）。"""
        from agent_platform.store import knowledge
        from agent_platform.store.db import pool
        await knowledge.upsert("test", "board", "权重A", "加权实验锚点甲")
        await knowledge.upsert("test", "board", "权重B", "加权实验锚点乙")
        entries = await knowledge.list_all("test", "board")
        id_a = next(e["id"] for e in entries if e["key"] == "权重A")
        id_b = next(e["id"] for e in entries if e["key"] == "权重B")
        async with pool().connection() as conn:
            await conn.execute(
                "UPDATE knowledge SET feedback_score=-5 WHERE id=%s", (id_a,))
            await conn.execute(
                "UPDATE knowledge SET feedback_score=5 WHERE id=%s", (id_b,))
        hits = await knowledge.search("test", "board", "加权实验锚点")
        keys = [h["key"] for h in hits]
        self.assertLess(keys.index("权重B"), keys.index("权重A"))

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
        from agent_platform.store import assets, cases, feedback, knowledge, runs
        await runs.create("r1", "t", "r", None, "sdk", "", {})
        await knowledge.upsert("test", "board", "k1", "内容", source_run="r1")
        await cases.add("test", "dagster", "fp error", "code", "c", "r1")
        await assets.upsert("test", "board", "t", "procedure", "方法A",
                            "s", "c", source_run="r1")
        await feedback.add("r1", 1)
        await feedback.propagate_to_memory("test", "r1", 1)
        case = await cases.search_by_error("test", "fp error")
        self.assertEqual(case["thumbs_up"], 1)
        entries = await knowledge.list_all("test")
        self.assertEqual(entries[0]["feedback_score"], 1)
        # run 的 👍 同样回写它沉淀的任务资产（feedback_score 参与召回排序）
        asset_rows = await assets.list_all("test", "board")
        self.assertEqual(asset_rows[0]["feedback_score"], 1)
        await feedback.propagate_to_memory("test", "r1", -1)  # 反向可冲销
        self.assertEqual(
            (await assets.list_all("test", "board"))[0]["feedback_score"], 0)

    async def test_correction_counts(self):
        from agent_platform.store import feedback
        for i in range(3):
            await feedback.add_correction("s1", f"纠正{i}", by="u")
        rows = await feedback.correction_counts(min_count=3)
        self.assertEqual(rows[0]["count"], 3)

    # ---- 任务资产 ----

    async def test_assets_lifecycle(self):
        from agent_platform.store import assets
        # upsert 幂等：同 (env,domain,task,kind,name) 整替换刷新
        await assets.upsert("test", "board", "daily-inspection", "procedure",
                            "ods-巡检方法", "每日 ods 表异常巡检 SOP", "步骤 v1")
        await assets.upsert("test", "board", "daily-inspection", "procedure",
                            "ods-巡检方法", "每日 ods 表异常巡检 SOP", "步骤 v2")
        found = await assets.search_active("test", "board", "daily-inspection")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["content"], "步骤 v2")
        # 排序：任务级优先于域级通用；同范围 procedure 先于 script
        await assets.upsert("test", "board", "", "script",
                            "通用清理脚本", "清 scratch", "rm ...")
        await assets.upsert("test", "board", "daily-inspection", "script",
                            "行数对比", "比上下游行数", "select ...")
        found = await assets.search_active("test", "board", "daily-inspection")
        self.assertEqual([(a["kind"], a["name"]) for a in found], [
            ("procedure", "ods-巡检方法"),
            ("script", "行数对比"),
            ("script", "通用清理脚本")])
        # 复用统计直接记行上
        ids = [a["id"] for a in found]
        await assets.mark_used([ids[0]])
        top = (await assets.search_active("test", "board",
                                          "daily-inspection"))[0]
        self.assertEqual(top["use_count"], 1)
        # 过期即退出召回；恢复即回来
        await assets.mark_expired(ids[0])
        names = [a["name"] for a in
                 await assets.search_active("test", "board", "daily-inspection")]
        self.assertNotIn("ods-巡检方法", names)
        await assets.restore(ids[0])
        entry = await assets.get_entry(ids[0])
        self.assertIsNone(entry["valid_to"])
        # 网页编辑：改摘要/内容并重新生效
        await assets.update(ids[0], "新摘要", "步骤 v3")
        entry = await assets.get_entry(ids[0])
        self.assertEqual((entry["summary"], entry["content"]),
                         ("新摘要", "步骤 v3"))
        all_rows = await assets.list_all("test", "board")
        self.assertEqual(len(all_rows), 3)
        stats = await assets.kind_stats("test")
        self.assertEqual(stats, {"procedure": 1, "script": 2})

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
