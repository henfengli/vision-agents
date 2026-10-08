"""案例库指纹测试：同类报错归一化后指纹一致，不同类报错指纹不同。"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from agent_platform.store.cases import fingerprint


class TestFingerprint(unittest.TestCase):
    def test_same_error_pattern_same_fingerprint(self):
        e1 = 'psycopg.errors.UniqueViolation: duplicate key value violates "pk_order_123"\nDETAIL: Key (id)=(1001) already exists.'
        e2 = 'psycopg.errors.UniqueViolation: duplicate key value violates "pk_order_456"\nDETAIL: Key (id)=(9999) already exists.'
        self.assertEqual(fingerprint(e1), fingerprint(e2))

    def test_different_errors_differ(self):
        e1 = "ConnectionRefusedError: [Errno 111] Connection refused"
        e2 = "KeyError: 'total_fee'"
        self.assertNotEqual(fingerprint(e1), fingerprint(e2))

    def test_file_line_normalized(self):
        e1 = "Traceback ...\n  File /srv/board/etl/daily.py, line 42, in run\nValueError: bad"
        e2 = "Traceback ...\n  File /srv/board/etl/daily.py, line 87, in run\nValueError: bad"
        self.assertEqual(fingerprint(e1), fingerprint(e2))


if __name__ == "__main__":
    unittest.main()
