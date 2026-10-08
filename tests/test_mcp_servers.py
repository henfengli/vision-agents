"""MCP servers 测试：官方 server 工具清单冒烟（npx/uvx 缺失自动跳过）。

browser / datahub 直接用官方实现（@playwright/mcp、mcp-server-datahub），
不随仓库维护代码，这里的职责是验证配置里写的命令在这台机器上真的能
起来并列出工具——避免"配置漂移"（官方包改名/参数变了而示例没跟上）。
datahub server 启动即校验 GMS 连通，无 GMS 时只验证包可拉取、进程可启动。
"""

import asyncio
import shutil
import unittest

try:
    from fastmcp import Client
    from fastmcp.client.transports import StdioTransport
    HAS_FASTMCP = True
except ImportError:
    HAS_FASTMCP = False

HAS_NPX = shutil.which("npx") is not None
HAS_UVX = shutil.which("uvx") is not None


async def _list_tools(command, args, env=None):
    async with Client(StdioTransport(command, args, env=env or {})) as c:
        return [t.name for t in await c.list_tools()]


@unittest.skipUnless(HAS_FASTMCP and HAS_NPX, "fastmcp 或 npx 不可用")
class TestOfficialBrowserMcp(unittest.TestCase):
    def test_playwright_mcp_lists_tools(self):
        # 与 conf/env/prod.yaml 的 browser 示例同包同版本
        tools = asyncio.run(_list_tools(
            "npx", ["-y", "@playwright/mcp@0.0.83", "--headless", "--isolated"]))
        self.assertIn("browser_navigate", tools)
        self.assertIn("browser_click", tools)
        self.assertIn("browser_evaluate", tools)


@unittest.skipUnless(HAS_FASTMCP and HAS_UVX, "fastmcp 或 uvx 不可用")
class TestOfficialDatahubMcp(unittest.TestCase):
    def test_server_package_starts(self):
        # 无 GMS 时进程应启动后报连接错误，而不是 ImportError/命令不存在
        try:
            asyncio.run(_list_tools(
                "uvx", ["--from", "mcp-server-datahub==0.7.1", "mcp-server-datahub"],
                env={"DATAHUB_GMS_URL": "http://127.0.0.1:1"}))
        except Exception as e:  # 连接失败是预期；包/命令问题会抛别的
            self.assertNotIsInstance(e, (FileNotFoundError, ImportError))
        else:
            pass  # 有 GMS 可连时直接算过


if __name__ == "__main__":
    unittest.main()
