"""测试共享桩：FakeTemporalClient 把 workflow 的三步 activities 内联顺序执行。

不依赖 Temporal server：Temporal 的编排语义（重试/恢复/调度）由集成环境验证，
单测聚焦业务逻辑。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))


class FakeCompletions:
    """模型桩：distill/summary 调用返回空 JSON 数组（可被子类覆盖）。"""

    content = "[]"

    async def create(self, model=None, messages=None, **kw):
        msg = type("M", (), {"content": self.content})()
        return type("R", (), {"choices": [type("C", (), {"message": msg})()]})()


class FakePool:
    embed = None  # 与 ModelPool 接口对齐：未配置嵌入模型时为 None

    def __init__(self, content: str = "[]"):
        self.chat = type("C", (FakeCompletions,), {"content": content})().create


class FakeAgent:
    async def ainvoke(self, payload, config):
        from langchain_core.messages import AIMessage
        if payload is None:  # resume：真实 LangGraph 续 thread，桩给个续跑答案
            return {"messages": [AIMessage(content="answer: resumed")]}
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
    def __init__(self, result=None, error: Exception | None = None):
        self._result = result
        self._error = error

    async def result(self):
        if self._error is not None:
            raise self._error
        return self._result


class FakeTemporalClient:
    """start_workflow 时内联执行三步 activity（业务逻辑真实走 PG）。

    对齐真实 Temporal 语义：提交永远成功；失败在 handle.result() 时才抛出。
    """

    def __init__(self, execute: bool = True):
        self.started: list[tuple] = []   # (id, spec, kwargs) 供断言 resume 策略等
        self._handles: dict = {}
        self._execute = execute          # False=只记录不执行（纯提交语义测试）

    async def start_workflow(self, wf, spec, *, id, task_queue, **kw):
        self.started.append((id, spec, kw))
        if not self._execute:
            handle = FakeHandle({"answer": "stub"})
            self._handles[id] = handle
            return handle
        from agent_platform.orchestration import activities
        from agent_platform.orchestration.artgraph import run_graph

        async def call(fn, *args):  # prod 里是 workflow.execute_activity
            return await fn(*args)

        try:
            if spec.get("handler"):
                # 内建任务：单 activity 完成整个作业
                handle = FakeHandle(
                    await activities.run_builtin_task(dict(spec)))
            elif spec.get("artifacts"):
                # 资产图：prepare → 解释执行（层内并行）→ finalize
                prepared = await activities.prepare_run(dict(spec))
                merged = {**spec, **prepared}
                try:
                    output = await run_graph(merged, call)
                    output = await activities.finalize_run(merged, output)
                    handle = FakeHandle(output)
                except Exception as e:
                    await activities.mark_failed(merged, str(e))
                    handle = FakeHandle(error=e)
            else:
                prepared = await activities.prepare_run(dict(spec))
                merged = {**spec, **prepared}
                try:
                    output = await activities.run_agent(merged)
                    output = await activities.finalize_run(merged, output)
                    handle = FakeHandle(output)
                except Exception as e:
                    await activities.mark_failed(merged, str(e))
                    handle = FakeHandle(error=e)
        except Exception as e:
            handle = FakeHandle(error=e)
        self._handles[id] = handle
        return handle

    def get_workflow_handle(self, run_id):
        return self._handles.get(run_id, FakeHandle(None))


def configure_fake_deps(settings, defs, model_content: str = "[]"):
    """把 fake 依赖注入 activities（worker 进程里由 configure() 做同样的事）。"""
    from agent_platform.agent.roles import parse_defs
    from agent_platform.orchestration import activities

    class _Engine(FakeEngine):
        async def roles(self):
            return parse_defs(await defs.list_active("role", settings.env))

    activities.configure(activities.Deps(
        settings=settings, engine=_Engine({}), model_pool=FakePool(model_content),
        notifier=None, langfuse=None))
