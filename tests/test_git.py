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

    def sync(self, env, ref=None, svc=None):
        return asyncio.run(codesync.pull((svc or self.svc).view("b", env), ref, str(self.root / "backups")))

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

    def test_follows_branch_after_new_commits(self):
        self.sync("test")
        newer = commit(self.origin, {"app.py": "v = 3\n", "requirements.txt": "x\n"})
        out = self.sync("test")
        self.assertEqual((out["before"], out["after"]), (self.new, newer))
        self.assertEqual(sorted(out["files"]), ["app.py", "requirements.txt"])
        self.assertEqual(git(self.root / "code" / "test", "rev-parse", "--abbrev-ref", "HEAD"), "main")

    def test_local_changes_are_backed_up_then_discarded(self):
        self.sync("test")
        (self.root / "code" / "test" / "app.py").write_text("hacked\n")
        out = self.sync("test")
        self.assertEqual(out["discarded"], ["app.py"])
        self.assertIn("hacked", Path(out["backup"]).read_text())
        self.assertEqual((self.root / "code" / "test" / "app.py").read_text(), "v = 2\n")

    def test_config_edited_in_place_is_adopted(self):
        svc = ServiceDef.model_validate({**self.svc.model_dump(), "configs": [
            {"canonical": f"{self.root}/code/{{env}}/app.py", "template": f"{self.root}/conf/{{env}}/app.py"}]})
        self.sync("test", svc=svc)
        (self.root / "code" / "test" / "app.py").write_text("v = 'test'\n")
        out = self.sync("test", svc=svc)
        self.assertEqual(out["adopted"], [f"{self.root}/conf/test/app.py"])
        self.assertEqual((self.root / "conf" / "test" / "app.py").read_text(), "v = 'test'\n")
        self.assertEqual(svc.view("b", "test").config_files[0]["upstream"], "app.py")   # 上游默认是它自己

    def test_files_digest_tracks_content(self):
        self.sync("test")
        path = str(self.root / "code" / "test")
        before = asyncio.run(codesync.files_digest(path, ["app.py"]))
        self.assertIsNone(asyncio.run(codesync.files_digest(path, ["requirements.txt"])))
        commit(self.origin, {"app.py": "v = 9\n"})
        self.sync("test")
        self.assertNotEqual(before, asyncio.run(codesync.files_digest(path, ["**/app.py"])))

    def test_refuses_non_git_dir_and_missing_repo(self):
        (self.root / "code" / "dev").mkdir(parents=True)
        (self.root / "code" / "dev" / "keep.txt").write_text("x")
        with self.assertRaises(codesync.SyncError):
            self.sync("dev")
        with self.assertRaises(codesync.SyncError):
            asyncio.run(codesync.pull(ServiceDef(root="/x").view("b", "test"), None, str(self.root / "backups")))


if __name__ == "__main__":
    unittest.main()
