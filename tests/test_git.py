"""git 实测：知识按引用文件判过期；代码同步按环境切版本。"""

import asyncio
import tempfile
import unittest
from pathlib import Path

from support import commit, git

from agent_platform.domain import ServiceDef
from agent_platform.services import codesync
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


class CodeSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.origin = root / "origin"
        self.origin.mkdir()
        git(self.origin, "init", "-q", "-b", "main")
        self.old = commit(self.origin, {"app.py": "v = 1\n"})
        git(self.origin, "branch", "release")
        self.new = commit(self.origin, {"app.py": "v = 2\n"})
        self.svc = ServiceDef.model_validate({"root": f"{root}/code/{{env}}", "repo": str(self.origin), "ref": "main",
                                              "envs": {"prod": {"ref": "release"}}})
        self.root = root

    def tearDown(self):
        self.tmp.cleanup()

    def sync(self, env, ref=None):
        return asyncio.run(codesync.sync(self.svc.view("b", env), ref))

    def test_each_env_follows_its_own_ref(self):
        prod, test = self.sync("prod"), self.sync("test")
        self.assertTrue(prod["cloned"])
        self.assertEqual((prod["after"], test["after"]), (self.old, self.new))
        self.assertEqual((self.root / "code" / "prod" / "app.py").read_text(), "v = 1\n")

    def test_explicit_ref_and_noop(self):
        self.sync("test")
        out = self.sync("test", self.old)
        self.assertTrue(out["changed"])
        self.assertEqual(out["after"], self.old)
        self.assertFalse(self.sync("test", self.old)["changed"])

    def test_refuses_to_discard_local_changes(self):
        self.sync("test")
        (self.root / "code" / "test" / "app.py").write_text("hacked\n")
        with self.assertRaises(codesync.SyncError):
            self.sync("test", self.old)

    def test_refuses_non_git_dir_and_missing_repo(self):
        (self.root / "code" / "dev").mkdir(parents=True)
        (self.root / "code" / "dev" / "keep.txt").write_text("x")
        with self.assertRaises(codesync.SyncError):
            self.sync("dev")
        with self.assertRaises(codesync.SyncError):
            asyncio.run(codesync.sync(ServiceDef(root="/x").view("b", "test")))


if __name__ == "__main__":
    unittest.main()
