"""控制台接口的形状：服务列表的任务数与环境开关、概览的即将触发、提示词默认值、方法搜索、全局搜索。不需要 Postgres。"""

import asyncio
import unittest
from types import SimpleNamespace
from unittest import mock

from support import seeded_registry

from agent_platform.api.routes import definitions, meta
from agent_platform.api.routes import settings as settings_routes
from agent_platform.domain.prompts import PromptsConfig
from agent_platform.orchestration.scheduler import Scheduler
from agent_platform.store import assets

run = asyncio.run


def runtime():
    reg = seeded_registry()
    return SimpleNamespace(registry=reg, scheduler=Scheduler(reg))


class ServiceSummaryTest(unittest.TestCase):
    def test_own_and_generic_task_counts(self):
        rt = runtime()
        with mock.patch.object(definitions.runs, "service_health", mock.AsyncMock(return_value={})):
            board = run(definitions._service_summaries(rt, {"vision-board"}))[0]
        self.assertEqual(board["task_count"], 2)                 # frontend-smoke、daily-inspection
        self.assertEqual(board["generic_task_count"], 3)         # ask、data-qa、memory-gardener

    def test_env_enabled_is_the_env_switch_only(self):
        rt = runtime()
        run(rt.registry.update("service", "vision-board", {"enabled": False, "envs": {"test": {"enabled": False}}}, "t"))
        with mock.patch.object(definitions.runs, "service_health", mock.AsyncMock(return_value={})):
            board = run(definitions._service_summaries(rt, {"vision-board"}))[0]
        prod, test = board["health"]["prod"], board["health"]["test"]
        self.assertEqual((prod["enabled"], prod["env_enabled"]), (False, True))    # 服务停用：实际不收，环境开关还开着
        self.assertEqual((test["enabled"], test["env_enabled"]), (False, False))


class UpcomingTest(unittest.TestCase):
    def stats(self, **kw):
        rt = runtime()
        with mock.patch.object(meta.runs, "stats", mock.AsyncMock(return_value={"hours": 24})):
            return run(meta.stats(hours=24, service=kw.get("service"), env=kw.get("env"), rt=rt, _=None))

    def test_builtin_tasks_are_left_out(self):
        data = self.stats()
        tasks = {f["task"] for f in data["upcoming"]}
        self.assertNotIn("memory-gardener", tasks)
        self.assertIn("daily-inspection", tasks)
        self.assertEqual(data["upcoming_total"], len(data["upcoming"]))   # 只剩巡检的两个环境，不到上限
        self.assertTrue(all(f["task_title"] == "Board 日常巡检" for f in data["upcoming"]))

    def test_env_filter_and_total(self):
        data = self.stats(env="prod")
        self.assertEqual([(f["task"], f["env"]) for f in data["upcoming"]], [("daily-inspection", "prod")])
        self.assertEqual(data["upcoming_total"], 1)


class PromptDefaultsTest(unittest.TestCase):
    def test_defaults_are_the_builtin_texts(self):
        out = run(settings_routes.prompts_defaults(_=None))
        self.assertEqual(out, PromptsConfig().model_dump())
        self.assertIn("{messages}", out["compaction"])


class _Cursor:
    def __init__(self, rows):
        self.rows = rows

    async def fetchall(self):
        return self.rows


class _Conn:
    def __init__(self, calls):
        self.calls = calls

    async def execute(self, sql, params=()):
        self.calls.append((sql, tuple(params)))
        return _Cursor([])

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class AssetSearchTest(unittest.TestCase):
    def query(self, **kw):
        calls = []
        fake_pool = SimpleNamespace(connection=lambda: _Conn(calls))
        with mock.patch.object(assets, "pool", return_value=fake_pool):
            run(assets.list_entries(**kw))
        return calls[0]

    def test_q_matches_name_summary_content_case_insensitively(self):
        sql, params = self.query(service="vision-board", q=" Smoke ")
        self.assertIn("name ILIKE %s OR summary ILIKE %s OR content ILIKE %s", sql)
        self.assertEqual(params[:4], ("vision-board", "%Smoke%", "%Smoke%", "%Smoke%"))

    def test_blank_q_adds_no_condition(self):
        sql, _ = self.query(q="  ")
        self.assertNotIn("ILIKE", sql)


class SearchTest(unittest.TestCase):
    def test_lessons_read_as_conclusions_and_assets_are_found(self):
        rt = runtime()
        lesson = {"id": 7, "kind": "lesson", "key": "lesson:a3f19c2e", "service": "vision-dagster", "env": "prod",
                  "content": "上游分区没物化完导致级联失败\n（报错：…）"}
        asset = {"id": 3, "name": "上游分区行数", "service": "vision-dagster", "env": "prod", "summary": "查行数"}
        with mock.patch.object(meta.runs, "search", mock.AsyncMock(return_value=[])), \
                mock.patch.object(meta.knowledge_store, "list_entries", mock.AsyncMock(return_value=[lesson])), \
                mock.patch.object(meta.assets_store, "list_entries", mock.AsyncMock(return_value=[asset])) as found:
            hits = run(meta.search(q="上游", rt=rt, _=None))
        by_type = {h["type"]: h for h in hits}
        self.assertEqual(by_type["knowledge"]["title"], "教训：上游分区没物化完导致级联失败")
        self.assertEqual(by_type["asset"]["href"], "/memory?tab=assets&id=3")
        self.assertEqual(found.call_args.kwargs["status"], "active")

    def test_services_match_description(self):
        rt = runtime()
        with mock.patch.object(meta.runs, "search", mock.AsyncMock(return_value=[])), \
                mock.patch.object(meta.knowledge_store, "list_entries", mock.AsyncMock(return_value=[])), \
                mock.patch.object(meta.assets_store, "list_entries", mock.AsyncMock(return_value=[])):
            hits = run(meta.search(q="报表展示", rt=rt, _=None))
        self.assertEqual([h["id"] for h in hits if h["type"] == "service"], ["vision-board"])


if __name__ == "__main__":
    unittest.main()
