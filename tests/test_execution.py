"""执行层：取消时停得住（内核、命令）、大输出落盘、执行中的进度、read 的可见性、防打转与修剪旧输出。"""

import asyncio
import os
import sys
import tempfile
import threading
import time
import unittest

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from agent_platform.agent import factory
from agent_platform.agent.tools import bash as bash_mod
from agent_platform.agent.tools import files as files_mod
from agent_platform.agent.tools import outputs
from agent_platform.agent.tools.sandbox import invisible_reason
from agent_platform.orchestration.pipeline import now_block
from agent_platform.services import kernel as kernel_mod


def _py(code: str) -> list[str]:
    return [sys.executable, "-c", code]


class CommandTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def run_argv(self, code, timeout=30, **kw):
        return bash_mod._execute(_py(code), "cmd", timeout, workdir=self.dir.name, env=None,
                                 stop=kw.get("stop"), on_progress=kw.get("on_progress"),
                                 spill_path=kw.get("spill_path"))

    def test_stop_kills_process(self):
        stop = threading.Event()
        threading.Timer(0.5, stop.set).start()
        t0 = time.monotonic()
        r = self.run_argv("import time; print('start', flush=True); time.sleep(30)", stop=stop)
        self.assertLess(time.monotonic() - t0, 5)
        self.assertEqual(r.exit_code, 130)
        self.assertIn("已取消", r.output)

    def test_timeout(self):
        r = self.run_argv("import time; time.sleep(30)", timeout=1)
        self.assertEqual(r.exit_code, 124)
        self.assertIn("超时", r.output)

    def test_big_output_spilled(self):
        path = os.path.join(self.dir.name, "outputs", "bash-x.txt")
        r = self.run_argv("print('\\n'.join('line %d' % i for i in range(60000)))", spill_path=path)
        self.assertTrue(r.truncated)
        self.assertEqual(r.spilled, path)
        with open(path, encoding="utf-8") as f:
            data = f.read()
        self.assertIn("line 0\n", data)
        self.assertIn("line 59999", data)            # 全文都在
        self.assertIn(path, bash_mod.format_result(r))
        self.assertLessEqual(len(r.output), bash_mod.MAX_OUTPUT_CHARS + 200)

    def test_medium_output_spilled_from_memory(self):
        path = os.path.join(self.dir.name, "outputs", "bash-y.txt")
        r = self.run_argv("print('x' * 20000)", spill_path=path)      # 超过预览上限，但内存里放得下
        self.assertTrue(r.truncated)
        self.assertEqual(r.spilled, path)
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read().strip(), "x" * 20000)

    def test_progress(self):
        seen = []
        old = bash_mod.PROGRESS_S
        bash_mod.PROGRESS_S = 0.3
        self.addCleanup(setattr, bash_mod, "PROGRESS_S", old)
        self.run_argv("import time\nfor i in range(4):\n    print('tick', i, flush=True); time.sleep(0.4)",
                      on_progress=lambda text, ms: seen.append(text))
        self.assertTrue(seen)
        self.assertIn("tick", seen[-1])


class KernelTest(unittest.TestCase):
    """真起一个内核（本机没有 bwrap：require_sandbox=False 直接跑）。"""

    def spec(self):
        return {"python": sys.executable, "service": "s", "env": "test", "digest": "d", "workdir": None}

    def test_cancel_kills_kernel_and_next_call_is_clean(self):
        async def go():
            km = kernel_mod.KernelManager(tempfile.mkdtemp(), require_sandbox=False)
            try:
                first = asyncio.ensure_future(km.execute("k", self.spec(), "import time; time.sleep(20); 'late'"))
                await asyncio.sleep(1.5)
                first.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await first
                gone = not km.alive("k")
                out = await km.execute("k", self.spec(), "1 + 1")
                return gone, out
            finally:
                await km.close()
        gone, out = asyncio.run(go())
        self.assertTrue(gone, "被取消的调用应该把内核结束掉")
        self.assertIn("[值] 2", out)
        self.assertNotIn("late", out)

    def test_progress_and_spill(self):
        async def go():
            scratch = tempfile.mkdtemp()
            km = kernel_mod.KernelManager(scratch, require_sandbox=False)
            seen = []

            async def progress(text, ms):
                seen.append(text)
            try:
                out = await km.execute("k", self.spec(),
                                       "import time\nfor i in range(3):\n    print('step', i, flush=True)\n"
                                       "    time.sleep(1.6)\nprint('y' * 30000)", progress=progress, timeout=60)
            finally:
                await km.close()
            return out, seen
        out, seen = asyncio.run(go())
        self.assertTrue(any("step" in s for s in seen), seen)
        self.assertIn("全文在", out)
        path = out.split("全文在 ", 1)[1].split("：", 1)[0]
        self.assertTrue(os.path.exists(path), path)


class ReadTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.file = os.path.join(self.dir, "a.py")
        with open(self.file, "w", encoding="utf-8") as f:
            f.write("".join(f"line {i}\n" for i in range(1, 3001)))

    def test_numbers_and_paging(self):
        out = files_mod.read_text(self.file)
        self.assertIn("共 3000 行", out)
        self.assertIn("\n1: line 1\n", out)
        self.assertIn("2000: line 2000", out)
        self.assertNotIn("2001: line 2001", out)
        self.assertIn("offset=2001", out)
        out = files_mod.read_text(self.file, offset=2995, limit=10)
        self.assertIn("3000: line 3000", out)
        self.assertNotIn("offset=", out)

    def test_binary_and_dir(self):
        b = os.path.join(self.dir, "b.bin")
        with open(b, "wb") as f:
            f.write(b"\0\1\2")
        self.assertTrue(files_mod.read_text(b).startswith("[二进制文件]"))
        self.assertIn("a.py", files_mod.read_text(self.dir))

    def test_visibility_mirrors_sandbox(self):
        home = os.path.join(self.dir, "home")
        code = os.path.join(home, "deploy", "app")
        os.makedirs(os.path.join(code, "conf"))
        secret = os.path.join(code, "conf", "settings-prod.py")
        open(secret, "w").close()
        kw = {"hidden": [secret], "allow": [code], "scratch": os.path.join(home, "scratch"), "home": home}
        self.assertIsNone(invisible_reason(os.path.join(code, "main.py"), **kw))
        self.assertIn("遮蔽", invisible_reason(secret, **kw))
        self.assertIn("home", invisible_reason(os.path.join(home, ".ssh", "id_rsa"), **kw))
        self.assertIsNone(invisible_reason(os.path.join(home, "scratch", "work", "x"), **kw))
        # home 本身挂回等于没遮：不算数
        self.assertIn("home", invisible_reason(os.path.join(home, ".config", "x"), **{**kw, "allow": [home]}))

    def test_huge_single_line_is_cut_without_loading(self):
        big = os.path.join(self.dir, "one.txt")
        with open(big, "w", encoding="utf-8") as f:
            f.write("a" * 3_000_000 + "\nsecond\n")
        out = files_mod.read_text(big)
        self.assertIn("截断", out)
        self.assertIn("2: second", out)
        self.assertLess(len(out), 10_000)

    def test_check_runs_on_opened_file(self):
        out = files_mod.read_text(self.file, check=lambda real: "不给看")
        self.assertTrue(out.startswith("[看不到]"), out)

    @unittest.skipUnless(os.name == "posix" and hasattr(os, "mkfifo"), "需要 POSIX")
    def test_fifo_not_read(self):
        fifo = os.path.join(self.dir, "p")
        os.mkfifo(fifo)
        self.assertTrue(files_mod.read_text(fifo).startswith("[不是普通文件]"))

    @unittest.skipUnless(os.name == "posix", "需要 POSIX 软链接")
    def test_symlinked_root_and_mask(self):
        home = os.path.join(self.dir, "home")
        release = os.path.join(home, "releases", "v3")
        os.makedirs(os.path.join(release, "conf"))
        os.makedirs(os.path.join(home, "deploy"))
        root = os.path.join(home, "deploy", "app")
        os.symlink(release, root)                        # 代码目录是软链接
        shared = os.path.join(home, "shared")
        os.makedirs(shared)
        real_secret = os.path.join(shared, "settings-prod.py")
        open(real_secret, "w").close()
        os.symlink(real_secret, os.path.join(release, "conf", "settings-prod.py"))
        kw = {"hidden": [os.path.join(root, "conf", "settings-prod.py")], "allow": [root], "scratch": "", "home": home}
        self.assertIsNone(invisible_reason(os.path.join(root, "main.py"), **kw))
        self.assertIn("遮蔽", invisible_reason(os.path.join(root, "conf", "settings-prod.py"), **kw))
        self.assertIn("遮蔽", invisible_reason(real_secret, **kw))


class GuardTest(unittest.TestCase):
    def test_repeated_calls(self):
        call = {"name": "logs", "args": {"name": "app"}, "id": "c3"}
        msgs = [HumanMessage("q")]
        for i in (1, 2):
            msgs += [AIMessage("", tool_calls=[{"name": "logs", "args": {"name": "app"}, "id": f"c{i}"}]),
                     ToolMessage("same", tool_call_id=f"c{i}", name="logs")]
        msgs.append(AIMessage("", tool_calls=[call]))
        self.assertEqual(factory.repeated_calls(msgs, call), (2, True))
        msgs[4] = ToolMessage("changed", tool_call_id="c2", name="logs")
        self.assertEqual(factory.repeated_calls(msgs, call), (2, False))
        other = {"name": "logs", "args": {"name": "nginx"}, "id": "c4"}
        self.assertEqual(factory.repeated_calls([*msgs, AIMessage("", tool_calls=[other])], other)[0], 0)

    def test_repeat_block_stays_and_new_turn_resets(self):
        def calls(results):
            msgs = [HumanMessage("q")]
            for i, r in enumerate(results):
                msgs += [AIMessage("", tool_calls=[{"name": "logs", "args": {}, "id": f"c{i}"}]),
                         ToolMessage(r, tool_call_id=f"c{i}", name="logs")]
            return msgs
        call = {"name": "logs", "args": {}, "id": "next"}
        blocked = factory._BLOCKED + "不再执行"
        msgs = calls(["same"] * 4 + [blocked])
        self.assertEqual(factory.repeated_calls([*msgs, AIMessage("", tool_calls=[call])], call), (5, True))
        # 同会话的下一次运行：上一轮的不连着算
        msgs.append(HumanMessage("新问题"))
        self.assertEqual(factory.repeated_calls([*msgs, AIMessage("", tool_calls=[call])], call)[0], 0)
        # 同一条消息里并发的同样调用（还没有结果）不算重复
        par = [{"name": "logs", "args": {}, "id": f"p{i}"} for i in range(3)]
        self.assertEqual(factory.repeated_calls([HumanMessage("q"), AIMessage("", tool_calls=par)], par[2])[0], 0)

    def test_prune_batches_keep_prefix_stable(self):
        msgs, seen = [HumanMessage("q")], set()
        snapshots = []
        for i in range(20):
            msgs += [AIMessage("", tool_calls=[{"name": "bash", "args": {"i": i}, "id": f"t{i}"}]),
                     ToolMessage("o" * 8000, tool_call_id=f"t{i}", name="bash")]
            out = factory.prune_tool_outputs(msgs, seen)
            snapshots.append(sum(1 for m in out if m.type == "tool" and m.content.startswith("[较早")))
        changes = sum(1 for a, b in zip(snapshots, snapshots[1:]) if a != b)
        self.assertGreater(snapshots[-1], 0)
        self.assertLess(changes, 6, snapshots)           # 成批修剪，不是每轮都动一条

    def test_last_todo(self):
        from agent_platform.api.views import _last_todo

        def ev(kind, **p):
            return {"kind": kind, "payload": {"tool": "todo", **p}}
        good = {"items": [{"content": "a", "status": "completed"}]}
        events = [ev("tool_call", args=good), ev("tool_result", output="待办已更新"),
                  ev("tool_call", args={"items": [{"content": "b", "status": "doing"}]}), ev("tool_result", output="[参数] …"),
                  ev("tool_call", agent="sub", args={"items": [{"content": "sub"}]}), ev("tool_result", agent="sub", output="ok")]
        self.assertEqual(_last_todo(events), good["items"])
        self.assertIsNone(_last_todo([ev("tool_call", args={"items": [{"content": {"x": 1}}]})]))

    def test_prune_keeps_recent_and_small(self):
        msgs = [HumanMessage("q")]
        for i in range(12):
            msgs += [AIMessage("", tool_calls=[{"name": "bash", "args": {"command": str(i)}, "id": f"t{i}"}]),
                     ToolMessage(f"out{i} " + "x" * 9000, tool_call_id=f"t{i}", name="bash")]
        pruned = factory.prune_tool_outputs(msgs)
        tools = [m for m in pruned if m.type == "tool"]
        self.assertTrue(tools[0].content.startswith("[较早的工具输出已省略"))
        self.assertTrue(tools[-1].content.startswith("out11"))
        self.assertTrue(all(m.content.startswith("out") for m in tools[-factory.PRUNE_KEEP_LAST:]))
        self.assertTrue(msgs[2].content.startswith("out0"), "状态里的原文不动")
        small = [HumanMessage("q"), AIMessage("", tool_calls=[{"name": "bash", "args": {}, "id": "a"}]),
                 ToolMessage("tiny", tool_call_id="a", name="bash")]
        self.assertIs(factory.prune_tool_outputs(small), small)

    def test_prune_keeps_spill_path(self):
        text = "head\n" + outputs.note("/s/work/k/outputs/bash-1.txt", 99999, "字节") + "\n" + "z" * 9000
        msgs = [HumanMessage("q")]
        for i in range(12):
            msgs += [AIMessage("", tool_calls=[{"name": "bash", "args": {"i": i}, "id": f"t{i}"}]),
                     ToolMessage(text, tool_call_id=f"t{i}", name="bash")]
        first = [m for m in factory.prune_tool_outputs(msgs) if m.type == "tool"][0]
        self.assertIn("/s/work/k/outputs/bash-1.txt", first.content)


class _Scripted:
    """按剧本出消息的假模型，记下每次收到的消息和 tool_choice。"""

    @staticmethod
    def make(script):
        from langchain_core.language_models import BaseChatModel
        from langchain_core.outputs import ChatGeneration, ChatResult

        class Scripted(BaseChatModel):
            @property
            def _llm_type(self) -> str:
                return "scripted"

            def _generate(self, messages, stop=None, run_manager=None, **kw):
                seen.append((messages, kw.get("tool_choice")))
                return ChatResult(generations=[ChatGeneration(message=script.pop(0))])

            def bind_tools(self, tools, **kw):
                return self.bind(**({"tool_choice": kw["tool_choice"]} if kw.get("tool_choice") else {}))

        seen: list = []
        return Scripted(), seen


class GuardIntegrationTest(unittest.TestCase):
    """真用 create_agent 跑：重复调用的提醒 / 拦截，调用次数到上限时收尾。"""

    def agent(self, script, changing=False):
        from langchain.agents import create_agent
        from langchain_core.tools import tool

        calls = []

        @tool
        def probe(x: int) -> str:
            """测试工具"""
            calls.append(x)
            return f"status {len(calls)}" if changing else "same"

        model, seen = _Scripted.make(script)
        return create_agent(model, tools=[probe], middleware=[factory._guard_middleware()]), seen, calls

    def test_repeats_warned_then_blocked(self):
        script = [AIMessage("", tool_calls=[{"name": "probe", "args": {"x": 1}, "id": f"c{i}"}]) for i in range(5)]
        agent, seen, calls = self.agent([*script, AIMessage("done")])
        result = asyncio.run(agent.ainvoke({"messages": [HumanMessage("go")]}))
        tools = [m for m in result["messages"] if m.type == "tool"]
        self.assertNotIn("[注意]", tools[1].content)
        self.assertIn("[注意]", tools[2].content)            # 第 3 次：执行了，但提醒
        self.assertIn("[重复调用]", tools[4].content)         # 第 5 次：不再执行
        self.assertEqual(len(calls), 4)

    def test_polling_not_blocked(self):
        """同样的参数、结果在变（轮询）：不提醒也不拦"""
        script = [AIMessage("", tool_calls=[{"name": "probe", "args": {"x": 1}, "id": f"c{i}"}]) for i in range(6)]
        agent, seen, calls = self.agent([*script, AIMessage("done")], changing=True)
        result = asyncio.run(agent.ainvoke({"messages": [HumanMessage("go")]}))
        tools = [m for m in result["messages"] if m.type == "tool"]
        self.assertEqual(len(calls), 6)
        self.assertFalse(any("[注意]" in t.content or "[重复调用]" in t.content for t in tools))

    def test_wrap_up_when_budget_used(self):
        script = [AIMessage("", tool_calls=[{"name": "probe", "args": {"x": i}, "id": f"c{i}"}]) for i in range(2)]
        agent, seen, calls = self.agent([*script, AIMessage("总结")])

        async def go():
            token = factory._BUDGET.set({"calls": 0, "max": 2})
            try:
                return await agent.ainvoke({"messages": [HumanMessage("go")]}), factory._BUDGET.get()
            finally:
                factory._BUDGET.reset(token)
        result, budget = asyncio.run(go())
        self.assertTrue(budget["wrapped"])
        last_messages, choice = seen[-1]
        self.assertEqual(choice, "none")                       # 第 3 次调用不许再用工具
        self.assertIn("[步数用完]", last_messages[-1].content)
        self.assertEqual(result["messages"][-1].content, "总结")


class NowTest(unittest.TestCase):
    def test_now_block(self):
        from datetime import datetime, timedelta, timezone
        block = now_block(datetime(2026, 10, 27, 14, 5, tzinfo=timezone(timedelta(hours=8))))
        self.assertIn("2026-10-27 14:05", block)
        self.assertIn("UTC+08:00", block)
        self.assertIn("星期二", block)


if __name__ == "__main__":
    unittest.main()
