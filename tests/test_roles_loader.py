"""角色继承解析的单元测试：交集收敛、prompt 拼接、循环检测、多级继承。"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from agent_platform.roles.loader import RoleDef, RoleError, resolve, resolve_all


def _defs(*roles: RoleDef) -> dict[str, RoleDef]:
    return {r.name: r for r in roles}


BASE = RoleDef(
    name="data_searcher",
    description="数据口径查询",
    domains=["board", "config-center"],
    tools=["bash", "read_file", "grep"],
    prompt="你是数据查询助手。",
)


class TestInheritance(unittest.TestCase):
    def test_child_narrows_domains_and_appends_prompt(self):
        child = RoleDef(name="order_fee_searcher", extends="data_searcher",
                        domains=["board"], prompt_append="只负责订单域。")
        r = resolve("order_fee_searcher", _defs(BASE, child))
        self.assertEqual(r.domains, ["board"])
        self.assertEqual(r.tools, ["bash", "grep", "read_file"])  # 继承父级（交集）
        self.assertIn("你是数据查询助手。", r.prompt)
        self.assertIn("只负责订单域。", r.prompt)
        self.assertEqual(r.lineage, ["data_searcher", "order_fee_searcher"])

    def test_child_cannot_escalate_tools(self):
        """子角色声明超出父级的工具会被交集丢弃（收敛而非提权）。"""
        child = RoleDef(name="evil_child", extends="data_searcher",
                        tools=["bash", "read_file", "grep", "admin_shell"])
        r = resolve("evil_child", _defs(BASE, child))
        self.assertNotIn("admin_shell", r.tools)

    def test_child_cannot_escalate_domains(self):
        child = RoleDef(name="wide", extends="data_searcher",
                        domains=["board", "secret-domain"])
        r = resolve("wide", _defs(BASE, child))
        self.assertEqual(r.domains, ["board"])

    def test_multi_level_inheritance(self):
        mid = RoleDef(name="board_searcher", extends="data_searcher",
                      domains=["board"], prompt_append="board 域。")
        leaf = RoleDef(name="order_searcher", extends="board_searcher",
                       prompt_append="订单子域。")
        r = resolve("order_searcher", _defs(BASE, mid, leaf))
        self.assertEqual(r.lineage, ["data_searcher", "board_searcher", "order_searcher"])
        self.assertEqual(r.domains, ["board"])
        self.assertEqual(r.prompt.count("。") >= 3, True)

    def test_cycle_detected(self):
        a = RoleDef(name="a", extends="b")
        b = RoleDef(name="b", extends="a")
        with self.assertRaises(RoleError):
            resolve("a", _defs(a, b))

    def test_missing_parent_detected(self):
        orphan = RoleDef(name="orphan", extends="ghost")
        with self.assertRaises(RoleError):
            resolve("orphan", _defs(orphan))

    def test_resolve_all(self):
        child = RoleDef(name="c", extends="data_searcher")
        all_roles = resolve_all(_defs(BASE, child))
        self.assertEqual(set(all_roles), {"data_searcher", "c"})


if __name__ == "__main__":
    unittest.main()
