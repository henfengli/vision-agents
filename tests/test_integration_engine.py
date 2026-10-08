"""真实 DeepAgents 集成测试：engine.create_agent 装配 + bash 工具真实执行。

用 GenericFakeChatModel 驱动（固定脚本：先调 bash 工具，再给最终答案），
验证装配链路：角色 → subagents → 工具注册 → 工具真实执行 → 最终回答。
需要 deepagents 依赖（PYTHONPATH 指向依赖目录）。
"""

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

try:
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration, ChatResult

    class ScriptedModel(BaseChatModel):
        """按脚本吐消息的假模型。

        不实现 _stream（astream 自动退回 ainvoke，保证 tool_calls 完整），
        bind_tools 直接返回 self（脚本驱动，无需真实工具绑定）。
        """

        script: list = []

        @property
        def _llm_type(self):
            return "scripted"

        def bind_tools(self, tools, **kwargs):
            return self

        def _generate(self, messages, stop=None, run_manager=None, **kw):
            nxt = self.script.pop(0)
            if isinstance(nxt, Exception):
                raise nxt
            msg = nxt if not isinstance(nxt, str) else AIMessage(content=nxt)
            return ChatResult(generations=[ChatGeneration(message=msg)])

    HAS_DEPS = True
except ImportError:
    HAS_DEPS = False

from agent_platform.roles.loader import RoleDef, resolve_all
from agent_platform.tools.registry import ToolRegistry


@unittest.skipUnless(HAS_DEPS, "缺少 langchain/deepagents 依赖")
class TestEngineIntegration(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.mkdtemp()

    def _build(self):
        from agent_platform.runtime.engine import create_agent

        defs = {
            "ops": RoleDef(name="ops", description="运维分析",
                           domains=["board"], tools=["bash"],
                           prompt="你是运维助手。"),
        }
        resolved = list(resolve_all(defs).values())
        registry = ToolRegistry(self.scratch)
        fake_model = ScriptedModel(script=[
            AIMessage(content="", tool_calls=[{
                "name": "bash",
                "args": {"command": "echo platform-integration-ok"},
                "id": "call_1",
            }]),
            AIMessage(content="最终答案：bash 已执行"),
        ])
        return create_agent(resolved, registry, fake_model)

    def test_agent_executes_bash_and_answers(self):
        agent = self._build()
        result = asyncio.run(agent.ainvoke(
            {"messages": [{"role": "user", "content": "跑个命令看看"}]},
            config={"configurable": {"thread_id": "it-1"}},
        ))
        texts = [getattr(m, "content", "") for m in result["messages"]]
        joined = "\n".join(str(t) for t in texts)
        self.assertIn("platform-integration-ok", joined)   # 工具真实执行了
        self.assertIn("最终答案", str(texts[-1]))           # 走完了 react 循环

    def test_subagent_registered(self):
        # 装配不抛错即证明 subagent spec 合法（spec 校验在 create 时完成），
        # 图内部结构是框架私有实现，不做断言。
        self.assertIsNotNone(self._build())

    def test_graph_nodes_match_event_node_names(self):
        """运行图高亮的前提：事件里的 langgraph_node 名必须是图拓扑里的节点 id。"""
        agent = self._build()
        executed: set[str] = set()

        async def collect():
            async for ev in agent.astream_events(
                    {"messages": [{"role": "user", "content": "跑个命令"}]},
                    config={"configurable": {"thread_id": "it-graph"}},
                    version="v2"):
                node = (ev.get("metadata") or {}).get("langgraph_node")
                if node:
                    executed.add(node)

        asyncio.run(collect())
        graph = agent.get_graph()
        graph_node_ids = {n.id for n in graph.nodes.values()}
        matched = executed & graph_node_ids
        # 至少有真实节点能命中图拓扑（前端节点高亮依赖这个一致性）
        self.assertTrue(matched, f"无任何事件节点命中图拓扑：{executed} vs {graph_node_ids}")
        # graph_json 需要的结构：nodes(id/label) + edges(source/target)
        self.assertTrue(graph.edges)
        self.assertTrue(all(hasattr(e, "source") and hasattr(e, "target")
                            for e in graph.edges))


@unittest.skipUnless(HAS_DEPS, "缺少 langchain/deepagents 依赖")
class TestCheckpointerIntegration(unittest.TestCase):
    """真实 Postgres checkpointer：会话状态跨 ainvoke 持久化（session 续上下文的根基）。"""

    def test_checkpointer_persists_thread(self):
        try:
            import pgserver
        except ImportError:
            self.skipTest("pgserver 不可用")
        pg = pgserver.get_server(tempfile.mkdtemp())
        self.addCleanup(pg.cleanup)
        asyncio.run(self._run(pg.get_uri()))

    async def _run(self, dsn: str):
        from agent_platform.runtime.engine import create_agent

        async_cm = await self._make_saver(dsn)
        saver, cm = async_cm
        try:
            defs = {"ops": RoleDef(name="ops", description="运维",
                                   domains=[], tools=["bash"], prompt="你是助手。")}
            resolved = list(resolve_all(defs).values())
            registry = ToolRegistry(tempfile.mkdtemp())
            model = ScriptedModel(script=[
                AIMessage(content="第一轮回答"),
                AIMessage(content="第二轮回答"),
            ])
            agent = create_agent(resolved, registry, model, checkpointer=saver)
            cfg = {"configurable": {"thread_id": "session-1"}}
            r1 = await agent.ainvoke({"messages": [{"role": "user", "content": "Q1"}]},
                                     config=cfg)
            r2 = await agent.ainvoke({"messages": [{"role": "user", "content": "Q2"}]},
                                     config=cfg)
            # 同 thread 第二轮应带着第一轮的历史（checkpointer 生效）
            self.assertGreater(len(r2["messages"]), len(r1["messages"]))
            self.assertIn("第二轮回答", str(r2["messages"][-1].content))
        finally:
            await cm.__aexit__(None, None, None)

    async def _make_saver(self, dsn: str):
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
        cm = AsyncPostgresSaver.from_conn_string(dsn)
        saver = await cm.__aenter__()
        await saver.setup()
        return saver, cm


if __name__ == "__main__":
    unittest.main()
