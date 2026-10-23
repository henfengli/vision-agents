"""db_query：只读校验、结果写文件按需读、连接串类型与各环境覆盖。真实库的连通性在部署机上验。"""

import csv
import tempfile
import unittest
from pathlib import Path

from agent_platform.agent.tools import db
from agent_platform.domain import ServiceDef
from agent_platform.domain.services import db_kind


class CheckSqlTest(unittest.TestCase):
    def ok(self, sql, kind="mysql"):
        return db.check_sql(sql, kind)

    def bad(self, sql, kind="mysql"):
        with self.assertRaises(db.QueryError):
            db.check_sql(sql, kind)

    def test_reads_pass(self):
        self.ok("SELECT 1;")
        self.ok("  with t as (select 1) select * from t")
        self.ok("SHOW TABLES")
        self.ok("DESCRIBE orders", "clickhouse")
        self.ok("SELECT * FROM system.tables", "clickhouse")
        self.ok("select replace(name, 'a', 'b'), update_time from t where action = 'delete'")
        self.ok("EXPLAIN ANALYZE SELECT 1", "postgres")
        self.ok("SELECT 1 FOR UPDATE", "postgres")          # PG 由只读事务挡

    def test_writes_and_multi_statements_rejected(self):
        self.bad("DELETE FROM t")
        self.bad("select 1; drop table t")
        self.bad("WITH x AS (SELECT 1) UPDATE t SET a = 1")
        self.bad("SELECT * FROM t INTO OUTFILE '/tmp/x'")
        self.bad("INSERT INTO t SELECT 1", "clickhouse")
        self.bad("SET max_threads = 1", "clickhouse")
        self.bad("")
        self.ok("select ';' as semi")                       # 字符串里的分号不算


class SinkTest(unittest.TestCase):
    def test_small_result_stays_inline(self):
        with tempfile.TemporaryDirectory() as d:
            s = db.Sink(d, "q", ["a"])
            for i in range(5):
                s.add([i])
            r = s.close()
        self.assertEqual((r.count, r.path, len(r.rows)), (5, None, 5))
        text = db.render(r, "main", "postgres", 12)
        self.assertIn("5 行 × 1 列", text)
        self.assertNotIn("全部结果在", text)

    def test_large_result_goes_to_file(self):
        with tempfile.TemporaryDirectory() as d:
            s = db.Sink(d, "q", ["id", "note"])
            for i in range(250):
                s.add([i, "x\ny" if i == 0 else f"n{i}"])
            r = s.close()
            rows = list(csv.reader(Path(r.path).open(encoding="utf-8")))
            text = db.render(r, "ck", "clickhouse", 30)
        self.assertEqual((r.count, len(r.rows), len(rows)), (250, db.PREVIEW_ROWS, 251))
        self.assertEqual(rows[0], ["id", "note"])
        self.assertEqual(rows[1], ["0", "x\ny"])            # 文件里是原样，预览里换行压成一行
        self.assertIn("全部结果在", text)
        self.assertIn("x⏎y", text)
        self.assertLessEqual(len(text), db.OUTPUT_CHARS + 60)

    def test_row_cap(self):
        old = db.MAX_ROWS
        db.MAX_ROWS = 30
        try:
            with tempfile.TemporaryDirectory() as d:
                s = db.Sink(d, "q", ["a"])
                added = sum(1 for i in range(50) if s.add([i]))
                r = s.close()
        finally:
            db.MAX_ROWS = old
        self.assertEqual((added, r.count), (30, 30))
        self.assertIn("只取了前 30 行", r.capped)


class DatabasesDefTest(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual([db_kind(u) for u in ("postgres://a/b", "mariadb://a/b", "doris://a:9030/b", "clickhouses://a",
                                               "mongodb+srv://c/d", "redis://x", "nope")],
                         ["postgres", "mysql", "doris", "clickhouse", "mongo", None, None])

    def test_env_override_by_name(self):
        svc = ServiceDef.model_validate({"databases": {"ck": "clickhouse://u:p@test:8123/default", "pg": "postgresql://u@h/x"},
                                         "envs": {"prod": {"databases": {"ck": "clickhouse://u:p@prod:8123/default",
                                                                         "pg": ""}}}})
        self.assertEqual(svc.view("s", "prod").databases, {"ck": "clickhouse://u:p@prod:8123/default"})
        self.assertEqual(set(svc.view("s", "test").databases), {"ck", "pg"})
        self.assertIn("ck（ClickHouse，test/default）", svc.view("s", "test").prompt_block())

    def test_bad_definitions_rejected(self):
        for bad in ({"databases": {"Main": "postgresql://h/x"}}, {"databases": {"m": "redis://h"}}):
            with self.assertRaises(ValueError):
                ServiceDef.model_validate(bad)


class MongoSpecTest(unittest.TestCase):
    def test_bad_specs_are_explained(self):
        for q in ("db.c.find()", '["x"]', '{"filter": {}}', '{"collection": "c", "pipeline": [{"$out": "x"}]}'):
            with self.assertRaises(db.QueryError):
                db._mongo("mongodb://127.0.0.1:1/x", q, lambda cols, jsonl=False: None)


if __name__ == "__main__":
    unittest.main()
