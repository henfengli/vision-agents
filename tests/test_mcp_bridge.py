"""MCP 工具绑定 服务×环境：每个环境一份连接，调用按运行路由；同一会话的调用共用一条常驻会话。"""

import asyncio
import unittest
from types import SimpleNamespace

from agent_platform.agent import scope as run_scope
from agent_platform.agent.tools import mcp_bridge
from agent_platform.agent.tools.catalog import Toolbox
from agent_platform.agent.tools.mcp_bridge import Endpoint, McpSessions, connections, result_text, route


class FakeSample:
    name, description = "get_run", "查 Dagster run"
    args_schema = {"type": "object", "properties": {"run_id": {"type": "string"}}, "required": ["run_id"]}


class FakeSessions:
    def __init__(self):
        self.calls = []

    async def call(self, owner, ep, tool, args):
        self.calls.append((owner, ep.key))
        return f"{ep.key}:{args['run_id']}"


def scope(service, env, session="s"):
    return run_scope.RunScope(run_id="r", session_id=session, task="t", env=env, protected=False, service=service)


def ep(key):
    return Endpoint(key, {"transport": "stdio", "command": "x", "args": []})


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
        sessions = FakeSessions()
        tool = route("get_run", "dagster", {"prod": ep("dagster@prod"), "test": ep("dagster@test")}, FakeSample(),
                     sessions=sessions)
        call = lambda: asyncio.run(tool.coroutine(run_id="42"))  # noqa: E731
        with run_scope.bind(scope("dagster", "test", session="s1")):
            self.assertEqual(call(), "dagster@test:42")
        self.assertEqual(sessions.calls, [("s1", "dagster@test")])     # 会话 id 决定用哪条常驻会话
        with run_scope.bind(scope("dagster", "dev")):
            self.assertIn("没有配置 dev", call())
        with run_scope.bind(scope("board", "test")):
            self.assertIn("只用于服务 dagster", call())
        self.assertIn("只能在运行里调用", call())

    def test_kernel_host_tool_uses_routed_tool(self):
        tool = route("get_run", None, {None: ep("any")}, FakeSample(), sessions=FakeSessions())
        stub = Toolbox(_Settings(), notifier=None, mcp_tools=[tool]).host_tools(["get_run"])["get_run"]
        with run_scope.bind(scope("board", "prod")):
            self.assertEqual(asyncio.run(stub(run_id="7")), "any:7")

    def test_session_reused_within_owner_and_reopened_when_dead(self):
        opened = []

        class FakeHeld:
            def __init__(self, conn):
                self.conn, self.busy, self.used, self.dead = conn, 0, 0.0, False
                self.session = SimpleNamespace(call_tool=self.call_tool)

            @property
            def alive(self):
                return not self.dead

            async def open(self, timeout):
                opened.append(self)

            async def close(self):
                self.dead = True

            async def call_tool(self, tool, args):
                return SimpleNamespace(content=[SimpleNamespace(type="text", text=f"{len(opened)}")], isError=False)

        async def scenario():
            pool = McpSessions()
            orig, mcp_bridge._Held = mcp_bridge._Held, FakeHeld
            try:
                a = [await pool.call("s1", ep("browser"), "nav", {}) for _ in range(2)]
                b = await pool.call("s2", ep("browser"), "nav", {})
                opened[0].dead = True                       # s1 的连接断了：下次调用重连
                c = await pool.call("s1", ep("browser"), "nav", {})
                await pool.close()
            finally:
                mcp_bridge._Held = orig
            return a, b, c

        a, b, c = asyncio.run(scenario())
        self.assertEqual(a, ["1", "1"])
        self.assertEqual((b, c, len(opened)), ("2", "3", 3))

    def test_result_text(self):
        r = SimpleNamespace(content=[SimpleNamespace(type="text", text="ok"),
                                     SimpleNamespace(type="image", mimeType="image/png")], isError=True)
        self.assertEqual(result_text(r), "[MCP 报错] ok\n[image 内容（image/png），未展示]")


class _Settings:
    scratch_dir = assets_dir = "."


if __name__ == "__main__":
    unittest.main()
