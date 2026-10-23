"""定义里的口令：用时取值、接口回显打码、*** 原样传回表示不改。"""

import os
import unittest
from unittest import mock

from agent_platform import credentials as c

REAL = "postgresql://ro:s3cret@db:5432/board"
MASKED = "postgresql://ro:***@db:5432/board"
CK = "clickhouse://ro:pw1@172.24.17.66:8123/default"


class CredentialsTest(unittest.TestCase):
    def test_redact(self):
        self.assertEqual(c.redact_dsn(REAL), MASKED)
        self.assertEqual(c.redact_dsn("postgresql://ro:p@ss@db/x"), "postgresql://ro:***@db/x")
        self.assertEqual(c.redact_dsn("mongodb://u:pw@h1:27017,h2:27017/db?replicaSet=rs0"),
                         "mongodb://u:***@h1:27017,h2:27017/db?replicaSet=rs0")
        for untouched in ("postgresql://ro:${PW}@db/x", "postgresql://ro@db/x", "postgresql://db/x", None, ""):
            self.assertEqual(c.redact_dsn(untouched), untouched)

    def test_mask_round_trip_keeps_current_value(self):
        self.assertEqual(c.restore_dsn(MASKED, REAL), REAL)
        moved = "postgresql://ro:***@other:5432/board"
        self.assertEqual(c.restore_dsn(moved, REAL), moved)
        self.assertIsNotNone(c.unresolved_mask({"databases": {"main": moved}}))

    def test_restore_service_per_env(self):
        current = {"databases": {"main": REAL, "ck": CK}, "envs": {"prod": {"databases": {"main": REAL}}, "test": {}}}
        body = {"databases": {"main": MASKED, "ck": c.redact_dsn(CK)},
                "envs": {"prod": {"databases": {"main": MASKED}}, "test": {"databases": {"main": "postgresql://ro:${PW}@t/x"}}}}
        out = c.restore_service(body, current)
        self.assertEqual(out["databases"], {"main": REAL, "ck": CK})
        self.assertEqual(out["envs"]["prod"]["databases"]["main"], REAL)
        self.assertEqual(out["envs"]["test"]["databases"]["main"], "postgresql://ro:${PW}@t/x")
        self.assertIsNone(c.unresolved_mask(out))
        self.assertEqual(c.redact_service(current)["envs"]["prod"]["databases"]["main"], MASKED)
        self.assertEqual(current["envs"]["prod"]["databases"]["main"], REAL)

    def test_expand(self):
        with mock.patch.dict(os.environ, {"PW": "x1"}):
            self.assertEqual(c.expand("postgresql://ro:${PW}@db/x"), "postgresql://ro:x1@db/x")
        with mock.patch.dict(os.environ, {}, clear=True), self.assertRaises(c.MissingSecret):
            c.expand("${NOPE}")


if __name__ == "__main__":
    unittest.main()
