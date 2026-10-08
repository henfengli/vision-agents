"""MCP servers 测试：DataHub 解析纯函数 + 浏览器真 Chromium 冒烟。

mcp_servers/ 是独立 stdio 脚本（不进 src 包），测试把仓库根目录加进 path。
工具逻辑与 mcp 包解耦（build_server 延迟导入），无 fastmcp 也能测逻辑。
"""

import re
import sys
import unittest
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).parents[1]))

from mcp_servers import datahub_mcp  # noqa: E402

try:
    from mcp_servers import browser_mcp
    HAS_BROWSER = True
except ImportError:
    HAS_BROWSER = False

try:
    import fastmcp  # noqa: F401
    HAS_FASTMCP = True
except ImportError:
    HAS_FASTMCP = False


class TestDataHubParsers(unittest.TestCase):
    def test_parse_search(self):
        data = {"searchAcrossEntities": {"total": 2, "searchResults": [
            {"urn": "urn:li:dataset:1", "type": "DATASET", "name": "orders",
             "properties": {"description": "订单事实表"}},
            {"urn": "urn:li:domain:2", "type": "DOMAIN",
             "properties": {"name": "交易域", "description": ""}}]}}
        out = datahub_mcp._parse_search(data)
        self.assertEqual(out["total"], 2)
        self.assertEqual(out["entities"][0]["name"], "orders")
        self.assertEqual(out["entities"][0]["description"], "订单事实表")
        self.assertEqual(out["entities"][1]["name"], "交易域")
        self.assertNotIn("description", out["entities"][1])  # 空描述不出字段

    def test_parse_dataset(self):
        d = {"urn": "u1", "name": "orders", "platform": {"name": "hive"},
             "properties": {"description": "订单表"},
             "schemaMetadata": {"fields": [
                 {"fieldPath": "order_id", "type": "BIGINT", "nullable": False,
                  "description": "订单号"},
                 {"fieldPath": "fee", "type": "DOUBLE", "nullable": True,
                  "description": None}]},
             "owners": {"owners": [
                 {"owner": {"__typename": "CorpUser", "urn": "u", "username": "zhang"}},
                 {"owner": {"__typename": "CorpGroup", "urn": "g", "name": "dw"}}]},
             "globalTags": {"tags": [{"tag": {"urn": "t", "name": "核心"}}]},
             "glossaryTerms": {"terms": [{"urn": "gt", "name": "订单"}]},
             "domain": {"domain": {"urn": "d", "properties": {"name": "交易域"}}}}
        out = datahub_mcp._parse_dataset(d, "u1")
        self.assertEqual(out["owners"], ["zhang", "dw"])
        self.assertEqual(out["tags"], ["核心"])
        self.assertEqual(out["fields"][1]["description"], "")  # None 归一成 ""
        self.assertEqual(out["domain"], "交易域")
        with self.assertRaises(RuntimeError):
            datahub_mcp._parse_dataset(None, "u-x")  # 不存在要报错

    def test_parse_lineage(self):
        data = {"searchAcrossLineage": {"total": 1, "searchResults": [
            {"degree": 1, "entity": {"urn": "u9", "type": "DATASET",
                                     "name": "stg_orders"}}]}}
        out = datahub_mcp._parse_lineage(data)
        self.assertEqual(out["entities"][0]["degree"], 1)
        self.assertEqual(out["entities"][0]["name"], "stg_orders")


class TestDataHubTools(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._orig = datahub_mcp._gql

    async def asyncTearDown(self):
        datahub_mcp._gql = self._orig

    async def test_search_builds_input(self):
        seen = {}

        async def fake_gql(query, variables):
            seen.update(variables["input"])
            return {"searchAcrossEntities": {"total": 0, "searchResults": []}}

        datahub_mcp._gql = fake_gql
        out = await datahub_mcp.datahub_search("订单", limit=5)
        self.assertEqual(seen["query"], "订单")
        self.assertEqual(seen["count"], 5)
        self.assertIn("DATASET", seen["types"])
        self.assertEqual(out["total"], 0)

    async def test_lineage_direction_validation(self):
        with self.assertRaises(ValueError):
            await datahub_mcp.datahub_get_lineage("u1", direction="SIDEWAYS")


@unittest.skipUnless(HAS_BROWSER, "playwright 不可用")
class TestBrowserMcp(unittest.IsolatedAsyncioTestCase):
    """真 Chromium 冒烟：导航 → 快照拿 ref → 点击/输入 → JS 验证。"""

    _HTML = "data:text/html;charset=utf-8," + quote(
        "<html><head><title>orig</title></head><body>"
        "<h1>冒烟页</h1>"
        "<button onclick=\"document.title='clicked'\">Go</button>"
        "<input id='kw' placeholder='关键词'>"
        "<a href='#'>详情</a></body></html>")

    async def asyncSetUp(self):
        try:
            await browser_mcp._S.page()          # 浏览器可启动才继续
        except Exception as e:
            self.skipTest(f"Chromium 不可用：{e}")

    async def asyncTearDown(self):
        await browser_mcp._S.reset()

    def _ref_of(self, snapshot: str, role: str, name: str) -> str:
        m = re.search(rf'{role} "{re.escape(name)}" \[ref=(e\d+)\]', snapshot)
        self.assertIsNotNone(m, f"快照里找不到 {role} {name}：\n{snapshot}")
        return m.group(1)

    async def test_navigate_snapshot_click_type(self):
        snap = await browser_mcp.browser_navigate(self._HTML)
        self.assertIn('heading "冒烟页"', snap)
        btn = self._ref_of(snap, "button", "Go")
        box = self._ref_of(snap, "textbox", "关键词")

        await browser_mcp.browser_click(btn)
        title = await browser_mcp.browser_evaluate("document.title")
        self.assertEqual(title, "clicked")       # 点击真的生效了

        await browser_mcp.browser_type(box, "total_fee")
        val = await browser_mcp.browser_evaluate(
            "document.getElementById('kw').value")
        self.assertEqual(val, "total_fee")       # 输入真的生效了

        tabs = await browser_mcp.browser_tabs("list")
        self.assertIn("[0]", tabs)
        self.assertEqual(await browser_mcp.browser_close(), "浏览器已关闭")

    async def test_stale_ref_gets_recoverable_message(self):
        await browser_mcp.browser_navigate(self._HTML)
        out = await browser_mcp.browser_click("e999")  # 不存在的 ref
        self.assertIn("操作失败", out)
        self.assertIn("browser_snapshot", out)          # 提示模型如何恢复


@unittest.skipUnless(HAS_FASTMCP, "fastmcp 不可用")
class TestBuildServer(unittest.TestCase):
    def test_tools_registered(self):
        for mod, name, count in (
                (datahub_mcp, "datahub", 4),):
            server = mod.build_server()
            self.assertEqual(server.name, name)
        if HAS_BROWSER:
            self.assertEqual(browser_mcp.build_server().name, "browser")


if __name__ == "__main__":
    unittest.main()
