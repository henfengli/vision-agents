"""任务定义与钉钉封装的纯逻辑测试。"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from agent_platform.notify.dingtalk import _clip
from agent_platform.tasks.registry import TaskDef


class TestTaskDef(unittest.TestCase):
    def test_dedup_key_single_field(self):
        t = TaskDef(name="failure-analysis", role="ops", dedup_key="run_id")
        self.assertEqual(t.compute_dedup_key({"run_id": "abc"}), "abc")

    def test_dedup_key_composite(self):
        t = TaskDef(name="frontend-smoke", role="qa", dedup_key="service+version")
        self.assertEqual(
            t.compute_dedup_key({"service": "board", "version": "v1.2"}),
            "board|v1.2")

    def test_no_dedup_key_returns_none(self):
        t = TaskDef(name="x", role="r")
        self.assertIsNone(t.compute_dedup_key({"a": 1}))

    def test_env_gate(self):
        t = TaskDef(name="x", role="r", env_gate=["prod", "test"])
        self.assertTrue(t.enabled_in("prod"))
        self.assertFalse(t.enabled_in("dev"))
        self.assertTrue(TaskDef(name="y", role="r").enabled_in("dev"))  # 空=全启用


class TestDingTalkClip(unittest.TestCase):
    def test_short_untouched(self):
        self.assertEqual(_clip("短文本"), "短文本")

    def test_long_clipped_with_hint(self):
        text = _clip("x" * 5000)
        self.assertLess(len(text), 4100)
        self.assertIn("已省略", text)


class TestSettingsLoad(unittest.TestCase):
    def test_load_with_interpolation(self):
        import os
        import tempfile

        from agent_platform.settings import load_settings

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "base").mkdir()
            (root / "env").mkdir()
            (root / "base" / "domains.yaml").write_text(
                "domains:\n  board:\n    code_paths: [/srv/board]\n", encoding="utf-8")
            (root / "env" / "test.yaml").write_text(
                "model:\n  url: http://llm/v1\n  name: m\n  tokens: [\"${TK}\"]\n"
                "db:\n  dsn: postgresql://x\n"
                "dingtalk:\n  relay_url: http://relay\n  access_token: \"${DT}\"\n"
                "viewer_base_url: http://viewer\n"
                "bearer_token: \"${BT}\"\n", encoding="utf-8")
            os.environ.update({"TK": "t1", "DT": "d1", "BT": "b1"})
            s = load_settings("test", conf_root=root)
            self.assertEqual(s.env, "test")
            self.assertEqual(s.model.tokens, ["t1"])
            self.assertEqual(s.dingtalk.access_token, "d1")
            self.assertEqual(list(s.domains), ["board"])

    def test_missing_env_var_refused(self):
        import os
        import tempfile

        from agent_platform.settings import load_settings

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "base").mkdir()
            (root / "env").mkdir()
            (root / "env" / "test.yaml").write_text(
                "model:\n  url: u\n  name: m\n  tokens: [\"${NOT_SET_VAR}\"]\n"
                "db:\n  dsn: x\n"
                "dingtalk:\n  relay_url: x\n  access_token: x\n"
                "viewer_base_url: x\nbearer_token: x\n", encoding="utf-8")
            os.environ.pop("NOT_SET_VAR", None)
            with self.assertRaises(KeyError):
                load_settings("test", conf_root=root)


if __name__ == "__main__":
    unittest.main()
