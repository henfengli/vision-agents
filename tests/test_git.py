"""git 实测：知识按引用文件判过期；服务页上报的代码目录状态。"""

import tempfile
import unittest
from pathlib import Path

from support import commit, git

from agent_platform.services import inspect
from agent_platform.store.knowledge import retrieval


class FreshnessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        git(self.repo, "init", "-q")
        self.first = commit(self.repo, {"a.py": "a = 1\n", "b.py": "b = 1\n"})
        self.ref = {"path": f"{self.repo}/a.py", "commit": self.first}

    def tearDown(self):
        self.tmp.cleanup()

    def fresh(self, ref):
        retrieval._head_cache.clear()
        return retrieval.is_entry_fresh(ref, [str(self.repo)])

    def test_other_files_changing_keeps_entry_fresh(self):
        commit(self.repo, {"b.py": "b = 2\n"})
        self.assertTrue(self.fresh(self.ref))

    def test_referenced_file_changing_expires_entry(self):
        commit(self.repo, {"a.py": "a = 2\n"})
        self.assertFalse(self.fresh(self.ref))

    def test_unknown_commit_expires_entry(self):
        commit(self.repo, {"b.py": "b = 3\n"})
        self.assertFalse(self.fresh({**self.ref, "commit": "0" * 40}))

    def test_outside_code_paths_is_not_checked(self):
        self.assertTrue(self.fresh({"path": "/elsewhere/a.py", "commit": "0" * 40}))

    def test_git_state_reports_commit_subject_and_dirty(self):
        commit(self.repo, {"b.py": "b = 4\n"}, message="feat: 改 b")
        state = inspect.git_state(str(self.repo))
        self.assertEqual(state["subject"], "feat: 改 b")
        self.assertFalse(state["dirty"])
        (self.repo / "a.py").write_text("a = 9\n")
        self.assertTrue(inspect.git_state(str(self.repo))["dirty"])


if __name__ == "__main__":
    unittest.main()
