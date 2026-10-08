"""v2 测试共享桩：FakeTemporalClient 把 workflow 的三步 activities 内联顺序执行。

不依赖 Temporal server： Temporal 的编排语义（重试/恢复/调度）由集成环境验证，
单测聚焦业务逻辑。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))


class FakeCompletions:
    async def create(self, model, messages, **kw):
        msg = type("M", (), {"content": "[]"})()
        return type("R", (), {"choices": [type("C", (), {"message": msg})()]})()


class FakePool:
    embed = None  # 与 ModelPool 接口对齐：未配置嵌入模型时为 None

    def __init__(self):
        self.chat = FakeCompletions().create


class FakeAgent:
    async def ainvoke(self, payload, config):
        from langchain_core.messages import AIMessage
        q = payload["messages"][-1]["content"]
        return {"messages": [AIMessage(content=f"answer: {q[:60]}")]}


class FakeEngine:
    def __init__(self, role_defs):
        self._defs = role_defs

    async def roles(self):
        return self._defs

    async def agent(self):
        return FakeAgent()


class FakeHandle:
    def __init__(self, result):
        self._result = result

    async def result(self):
        return self._result


class FakeTemporalClient:
    """start_workflow 时内联执行三步 activity（业务逻辑真实走 PG）。"""

    def __init__(self, execute: bool = True):
        self.started: list[tuple] = []   # (id, spec, kwargs) 供断言 resume 策略等
        self._results: dict = {}
        self._execute = execute          # False=只记录不执行（纯提交语义测试）

    async def start_workflow(self, wf, spec, *, id, task_queue, **kw):
        self.started.append((id, spec, kw))
        if not self._execute:
            self._results[id] = {"answer": "stub"}
            return FakeHandle(self._results[id])
        from agent_platform.orchestration import activities
        prepared = await activities.prepare_run(dict(spec))
        merged = {**spec, **prepared}
        try:
            output = await activities.run_agent(merged)
            output = await activities.finalize_run(merged, output)
        except Exception as e:
            await activities.mark_failed(merged, str(e))
            raise
        self._results[id] = output
        return FakeHandle(output)

    def get_workflow_handle(self, run_id):
        return FakeHandle(self._results.get(run_id))


def configure_fake_deps(settings, defs):
    """把 fake 依赖注入 activities（worker 进程里由 configure() 做同样的事）。"""
    from agent_platform.orchestration import activities
    from agent_platform.roles.loader import parse_defs

    class _Engine(FakeEngine):
        async def roles(self):
            return parse_defs(await defs.list_active("role", settings.env))

    activities.configure(activities.Deps(
        settings=settings, engine=_Engine({}), model_pool=FakePool(),
        notifier=None, langfuse=None))
