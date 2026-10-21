"""MCP 工具绑定 服务×环境：每个环境一份连接，调用按运行路由。"""

import asyncio
import unittest

from agent_platform.agent import scope as run_scope
from agent_platform.agent.tools.catalog import Toolbox
from agent_platform.agent.tools.mcp_bridge import connections, route


class FakeTool:
    def __init__(self, env):
        self.name, self.description, self.env = "get_run", "查 Dagster run", env
        self.args_schema = {"type": "object", "properties": {"run_id": {"type": "string"}}, "required": ["run_id"]}

    async def ainvoke(self, kwargs):
        return [{"type": "text", "text": f"{self.env}:{kwargs['run_id']}"}]


def scope(service, env):
    return run_scope.RunScope(run_id="r", session_id="s", task="t", env=env, protected=False, service=service)


class McpBridgeTest(unittest.TestCase):
    def test_connections_split_per_env(self):
        conns, owners = connections({
            "dagster": {"transport": "stdio", "command": "python", "env": {"A": "1"}, "service": "dagster",
                        "envs": {"prod": {"env": {"URL": "p"}}, "test": {"env": {"URL": "t"}}}},
            "plain": {"transport": "stdio", "command": "x"}})
        self.assertEqual(set(conns), {"dagster@prod", "dagster@test", "plain"})
        self.assertEqual(conns["dagster@prod"],
                         {"transport": "stdio", "command": "python", "env": {"A": "1", "URL": "p"}})
        self.assertEqual(owners["dagster@test"], ("dagster", "dagster", "test"))
        self.assertEqual(owners["plain"], ("plain", None, None))

    def test_calls_route_by_run_scope(self):
        tool = route("get_run", "dagster", {"prod": FakeTool("prod"), "test": FakeTool("test")}, FakeTool("prod"))
        call = lambda: asyncio.run(tool.coroutine(run_id="42"))  # noqa: E731
        with run_scope.bind(scope("dagster", "test")):
            self.assertEqual(call(), "test:42")
        with run_scope.bind(scope("dagster", "dev")):
            self.assertIn("没有配置 dev", call())
        with run_scope.bind(scope("board", "test")):
            self.assertIn("只用于服务 dagster", call())
        self.assertIn("只能在运行里调用", call())

    def test_run_code_stub_uses_routed_tool(self):
        tool = route("get_run", None, {None: FakeTool("any")}, FakeTool("any"))
        stub = Toolbox(_Settings(), gate=None, notifier=None, mcp_tools=[tool]).host_tools(["get_run"])["get_run"]
        with run_scope.bind(scope("board", "prod")):
            self.assertEqual(asyncio.run(stub(run_id="7")), "any:7")


class _Settings:
    grafana = None
    scratch_dir = assets_dir = "."


if __name__ == "__main__":
    unittest.main()
