"""回归重放的运行不沉淀方法、不发通知；内核满了先等空位，等不到再报错。"""

import asyncio
import tempfile
import unittest
from types import SimpleNamespace

from agent_platform.agent import scope as run_scope
from agent_platform.agent.tools.catalog import Toolbox
from agent_platform.domain import RunTrigger
from agent_platform.orchestration.spec import RunSpec
from agent_platform.services import kernel as kernel_mod


class _Settings:
    scratch_dir = assets_dir = "."
    limits = None
    require_sandbox = False


class ReplayGuardTest(unittest.TestCase):
    def test_replay_of(self):
        spec = RunSpec(run_id="n", session_id="n", task="t", form="agent", env="test",
                       trigger=RunTrigger(type="replay", id="o", caller="me"))
        self.assertEqual(spec.replay_of, "o")
        self.assertIsNone(RunSpec(run_id="n", session_id="n", task="t", form="agent", env="test").replay_of)

    def test_replay_runs_do_not_save_or_notify(self):
        tb = Toolbox(_Settings(), notifier=None)
        sc = run_scope.RunScope(run_id="n", session_id="n", task="t", env="test", protected=False, service="svc",
                                replay_of="o")

        async def go():
            with run_scope.bind(sc):
                return (await tb._fns["save_asset"](name="a", kind="procedure", summary="s", content="c"),
                        await tb._fns["notify"](title="t", content="c"))
        saved, sent = asyncio.run(go())
        self.assertTrue(saved.startswith("[回归重放]"), saved)
        self.assertTrue(sent.startswith("[回归重放]"), sent)


class KernelRoomTest(unittest.TestCase):
    def test_full_and_busy_waits_then_fails(self):
        old = kernel_mod.ROOM_WAIT_S
        kernel_mod.ROOM_WAIT_S = 0
        self.addCleanup(setattr, kernel_mod, "ROOM_WAIT_S", old)

        async def go():
            km = kernel_mod.KernelManager(tempfile.gettempdir(), max_kernels=1, require_sandbox=False)
            busy = asyncio.Lock()
            await busy.acquire()                     # 唯一的内核正在执行代码
            km._kernels["other"] = SimpleNamespace(key="other", lock=busy, alive=True, digest="", last_used=0)
            with self.assertRaises(kernel_mod.KernelError) as e:
                await km.execute("mine", {"python": "python", "service": "s", "env": "test", "digest": ""}, "1")
            return str(e.exception)
        self.assertIn("项目内核已满", asyncio.run(go()))


if __name__ == "__main__":
    unittest.main()
