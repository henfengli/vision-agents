"""调度：上游联动（after 触发）的定义检查与触发、成环检查、点名等上游的运行、自动重试、暂停自动触发、Dagster 事件。
不需要 Postgres：runs / ticks 的读写换成替身。"""

import asyncio
import unittest
from types import SimpleNamespace
from unittest import mock

from support import seeded_registry

from agent_platform.domain import Rejected, RunRequest, RunTrigger, TaskDef, consistency_error, run_fields
from agent_platform.orchestration import chain as chain_mod
from agent_platform.orchestration import gates
from agent_platform.orchestration import pipeline as pipeline_mod
from agent_platform.orchestration import submitter as submitter_mod
from agent_platform.orchestration.chain import Chainer
from agent_platform.orchestration.pipeline import Deps, Pipeline
from agent_platform.orchestration.spec import RunSpec
from agent_platform.orchestration.submitter import Accepted, Submitter
from agent_platform.registry import after_graph, find_cycle
from agent_platform.triggers.sources import SOURCES

run = asyncio.run


def after(**kw) -> dict:
    return {"id": "after-x", "type": "after", "tasks": ["frontend-smoke"], **kw}


def task(**kw) -> TaskDef:
    return TaskDef.model_validate({"role": "r", "input": {"version": {"type": "str"}}, **kw})


def a_run(**kw) -> dict:
    base = {"run_id": "up1", "task": "frontend-smoke", "env": "test", "service": "vision-board", "status": "success",
            "input": {"version": "abc"}, "output": {"answer": "ok", "data": {"category": "data", "n": 3}},
            "trigger": {"type": "event", "id": "on-deploy", "source": "gitlab", "caller": "gitlab"},
            "retry_at": None, "error_code": None, "attempt": 1}
    return {**base, **kw}


class AfterDefinitionTest(unittest.TestCase):
    def test_valid(self):
        self.assertIsNone(consistency_error(task(triggers=[after(map={"version": "input.version"},
                                                                 filter={"output.data.category": "^data$"})])))

    def test_bad_paths_and_regex(self):
        self.assertIn("写法不对", consistency_error(task(triggers=[after(map={"version": "inputs.version"})])))
        self.assertIn("正则不合法", consistency_error(task(triggers=[after(filter={"status": "("})])))
        self.assertIn("不是输入字段", consistency_error(task(triggers=[after(map={"nope": "run_id"})])))
        self.assertIn("至少要选", consistency_error(task(triggers=[after(on=[])])))
        self.assertIn("重复", consistency_error(task(triggers=[after(tasks=["a-b", "a-b"])])))

    def test_prefixed_refs_only_in_all_mode(self):
        self.assertIn("不用带上游任务名", consistency_error(task(triggers=[after(map={"version": "frontend-smoke.input.version"})])))
        ok = task(triggers=[after(mode="all", tasks=["frontend-smoke", "daily-inspection"],
                                  map={"version": "frontend-smoke.input.version"})])
        self.assertIsNone(consistency_error(ok))
        alien = task(triggers=[after(mode="all", tasks=["frontend-smoke", "daily-inspection"],
                                     map={"version": "ask.input.question"})])
        self.assertIn("不在上游里", consistency_error(alien))

    def test_run_fields(self):
        f = run_fields(a_run())
        self.assertEqual((f["input.version"], f["output.answer"], f["output.data.category"], f["status"]),
                         ("abc", "ok", "data", "success"))
        self.assertEqual(run_fields(a_run(), prefix="x.")["x.run_id"], "up1")

    def test_retry_bounds_and_builtin(self):
        self.assertIsNone(consistency_error(task(retry={"max": 2, "delay_s": 30})))
        with self.assertRaises(ValueError):
            task(retry={"max": 9})
        self.assertIn("不支持自动重试", consistency_error(TaskDef(form="builtin", handler="memory-gardener",
                                                             retry={"max": 1})))
        with self.assertRaises(ValueError):
            task(concurrency=0)


class AfterRegistryTest(unittest.TestCase):
    def setUp(self):
        self.reg = seeded_registry()

    def test_upstream_must_exist_and_not_be_self(self):
        with self.assertRaises(Rejected) as cm:
            run(self.reg.update("task", "failure-analysis", {"triggers": [after(tasks=["nope"])]}, "liyd"))
        self.assertIn("不存在", cm.exception.message)
        with self.assertRaises(Rejected) as cm:
            run(self.reg.update("task", "frontend-smoke", {"triggers": [after(tasks=["frontend-smoke"])]}, "liyd"))
        self.assertIn("自己", cm.exception.message)

    def test_cycle_rejected(self):
        run(self.reg.update("task", "daily-inspection", {"triggers": [after(tasks=["frontend-smoke"])]}, "liyd"))
        with self.assertRaises(Rejected) as cm:
            run(self.reg.update("task", "frontend-smoke", {"triggers": [
                {"id": "api", "type": "api"}, after(id="back", tasks=["daily-inspection"])]}, "liyd"))
        self.assertIn("成环", cm.exception.message)
        self.assertEqual(find_cycle({"a": {"b"}, "b": {"c"}, "c": {"a"}}), ["a", "b", "c", "a"])
        self.assertIsNone(find_cycle(after_graph({"x": task(triggers=[after(tasks=["y"])])})))

    def test_upstream_in_use(self):
        run(self.reg.update("task", "daily-inspection", {"triggers": [after(tasks=["frontend-smoke"])]}, "liyd"))
        with self.assertRaises(Rejected) as cm:
            run(self.reg.delete("task", "frontend-smoke", "liyd"))
        self.assertEqual(cm.exception.code, "in_use")


class ChainTest(unittest.TestCase):
    """上游运行结束 → 下游提交（替身记下提交了什么）。"""

    def setUp(self):
        self.reg = seeded_registry()
        self.sub = mock.MagicMock()
        self.sub.submit = mock.AsyncMock(return_value=Accepted("down1", "down1", "queued"))
        self.chain = Chainer(self.reg, self.sub)
        self.runs = mock.MagicMock()
        for f in ("has_waiting_dependents", "wake", "last_after_fire", "latest_finished", "log_event"):
            setattr(self.runs, f, mock.AsyncMock(return_value=None))
        self.runs.fail_dependents = mock.AsyncMock(return_value=[])
        self.ticks = mock.MagicMock()
        self.ticks.record = mock.AsyncMock()
        for target, value in ((chain_mod, "runs"), (chain_mod, "ticks")):
            p = mock.patch.object(target, value, getattr(self, value))
            p.start()
            self.addCleanup(p.stop)

    def declare(self, **kw):
        run(self.reg.update("task", "daily-inspection", {"triggers": [after(**kw)]}, "liyd"))

    def finish(self, upstream: dict):
        self.runs.get = mock.AsyncMock(return_value=upstream)
        run(self.chain.on_finished(upstream["run_id"]))

    def test_success_fires_downstream_in_same_env(self):
        self.declare(map={})
        self.finish(a_run())
        req, kw = self.sub.submit.await_args.args[0], self.sub.submit.await_args.kwargs
        self.assertEqual((req.task, req.env), ("daily-inspection", "test"))
        self.assertEqual((kw["trigger"].type, kw["trigger"].source, kw["trigger"].id), ("after", "up1", "after-x"))
        self.assertEqual(kw["idempotency_key"], "after:up1:success:daily-inspection:after-x")
        self.assertEqual(self.ticks.record.await_args.kwargs["outcome"], "fired")

    def test_map_and_filter(self):
        self.declare(map={}, filter={"output.data.category": "^infra$"})
        self.finish(a_run())
        self.sub.submit.assert_not_awaited()
        self.assertEqual(self.ticks.record.await_args.kwargs["outcome"], "filtered")

    def test_status_not_listened_is_silent(self):
        self.declare(on=["failed"])
        self.finish(a_run())
        self.sub.submit.assert_not_awaited()
        self.ticks.record.assert_not_awaited()

    def test_pending_retry_is_not_the_end(self):
        self.declare(on=["failed"])
        self.finish(a_run(status="failed", retry_at="2026-10-21T10:00:00+00:00"))
        self.sub.submit.assert_not_awaited()
        self.runs.fail_dependents.assert_not_awaited()

    def test_replay_runs_never_chain(self):
        self.declare()
        self.finish(a_run(trigger={"type": "replay", "id": "x", "source": None, "caller": "me"}))
        self.sub.submit.assert_not_awaited()

    def test_failed_upstream_fails_dependents(self):
        self.finish(a_run(status="failed"))
        self.runs.fail_dependents.assert_awaited()

    def test_all_mode_waits_then_fires(self):
        self.declare(mode="all", tasks=["frontend-smoke", "failure-analysis"],
                     map={"scope": "failure-analysis.input.version"})
        self.finish(a_run())
        self.assertEqual(self.ticks.record.await_args.kwargs["outcome"], "waiting")
        self.sub.submit.assert_not_awaited()
        other = a_run(run_id="up2", task="failure-analysis:x", input={"version": "from-fa"})
        self.runs.latest_finished = mock.AsyncMock(return_value=other)
        self.finish(a_run())
        req = self.sub.submit.await_args.args[0]
        self.assertEqual(req.input, {"scope": "from-fa"})       # 带前缀的引用取那一个上游的值

    def test_depth_limit(self):
        self.declare()
        chained = a_run(trigger={"type": "after", "id": "t", "source": "p0", "caller": "x"})
        parents = {f"p{i}": a_run(run_id=f"p{i}", trigger={"type": "after", "id": "t", "source": f"p{i + 1}", "caller": "x"})
                   for i in range(6)}
        self.runs.get = mock.AsyncMock(side_effect=lambda rid: chained if rid == "up1" else parents.get(rid))
        run(self.chain.on_finished("up1"))
        self.sub.submit.assert_not_awaited()
        self.assertEqual(self.ticks.record.await_args.kwargs["outcome"], "rejected")

    def test_rejected_submit_is_recorded(self):
        self.declare()
        self.sub.submit = mock.AsyncMock(side_effect=Rejected("triggers_paused", "暂停了", 409))
        self.finish(a_run())
        kw = self.ticks.record.await_args.kwargs
        self.assertEqual((kw["outcome"], kw["reason"]), ("rejected", "暂停了"))

    def test_all_mode_uses_round_key(self):
        """全部模式按「轮」幂等：两个上游几乎同时结束、各自判定齐了，读到的上一次触发相同，提交的是同一把键"""
        self.declare(mode="all", tasks=["frontend-smoke", "failure-analysis"])
        self.runs.latest_finished = mock.AsyncMock(return_value=a_run(run_id="up2", task="failure-analysis"))
        self.runs.last_after_fire = mock.AsyncMock(return_value="2026-10-21T08:00:00+00:00")
        self.finish(a_run())
        first = self.sub.submit.await_args.kwargs["idempotency_key"]
        self.runs.latest_finished = mock.AsyncMock(return_value=a_run())
        self.finish(a_run(run_id="up2", task="failure-analysis"))
        second = self.sub.submit.await_args.kwargs["idempotency_key"]
        self.assertEqual(first, second)
        self.assertEqual(first, "after-all:daily-inspection:after-x:test:2026-10-21T08:00:00+00:00")


class RunDependencyTest(unittest.TestCase):
    def setUp(self):
        self.reg = seeded_registry()
        self.sub = Submitter(self.reg)
        self.runs = mock.MagicMock()
        for f in ("find_idempotent", "find_dedup", "live_in_session", "create"):
            setattr(self.runs, f, mock.AsyncMock(return_value=None))
        p = mock.patch.object(submitter_mod, "runs", self.runs)
        p.start()
        self.addCleanup(p.stop)

    def submit(self, after_ids, trigger="api"):
        req = RunRequest(task="ask", service="vision-board", env="test", input={"question": "q"}, after=after_ids)
        return run(self.sub.submit(req, trigger=RunTrigger(type=trigger, caller="t")))

    def test_missing_and_dead_upstream(self):
        self.runs.statuses = mock.AsyncMock(return_value={})
        with self.assertRaises(Rejected) as cm:
            self.submit(["nope"])
        self.assertEqual(cm.exception.status, 404)
        self.runs.statuses = mock.AsyncMock(return_value={"u1": {"status": "failed", "retry_at": None}})
        with self.assertRaises(Rejected) as cm:
            self.submit(["u1"])
        self.assertEqual(cm.exception.code, "upstream_failed")

    def test_queue_fields(self):
        self.runs.statuses = mock.AsyncMock(return_value={"u1": {"status": "running", "retry_at": None}})
        self.submit(["u1", "u1"], trigger="chat")
        kw = self.runs.create.await_args.kwargs
        self.assertEqual((kw["depends_on"], kw["priority"], kw["concurrency_limit"]), (["u1"], 0, None))

    def test_concurrency_key(self):
        run(self.reg.update("task", "failure-analysis", {"concurrency": 2}, "liyd"))
        req = RunRequest(task="failure-analysis", env="test", input={"run_id": "r", "asset_key": "a/b"})
        run(self.sub.submit(req, trigger=RunTrigger(type="event", caller="dagster")))
        kw = self.runs.create.await_args.kwargs
        self.assertEqual((kw["concurrency_key"], kw["concurrency_limit"], kw["priority"]), ("failure-analysis@test", 2, 2))


class RetryTest(unittest.TestCase):
    def setUp(self):
        self.reg = seeded_registry()
        run(self.reg.update("task", "data-qa", {"retry": {"max": 2, "delay_s": 30}}, "liyd"))
        self.notifier = mock.MagicMock()
        self.notifier.emit = mock.AsyncMock()
        self.notifier.link = lambda p: p
        self.pipe = Pipeline(Deps(settings=SimpleNamespace(), registry=self.reg, factory=None, notifier=self.notifier,
                                  model_pool=None))
        self.runs = mock.MagicMock()
        for f in ("log_event", "set_status"):
            setattr(self.runs, f, mock.AsyncMock(return_value=True))
        p = mock.patch.object(pipeline_mod, "runs", self.runs)
        p.start()
        self.addCleanup(p.stop)

    def spec(self, trigger="api"):
        return RunSpec(run_id="r1", session_id="r1", task="data-qa", form="agent", env="test", service="vision-board",
                       trigger=RunTrigger(type=trigger, caller="t"))

    def fail(self, code, attempt=1, trigger="api"):
        self.runs.get = mock.AsyncMock(return_value={"status": "running", "attempt": attempt})
        run(self.pipe.fail(self.spec(trigger), "boom", code))
        return self.runs.set_status.await_args.kwargs["retry_in"]

    def test_transient_failures_retry_quietly(self):
        self.assertEqual(self.fail("error"), 30)
        self.notifier.emit.assert_not_awaited()             # 重试用完之前不发失败通知

    def test_last_attempt_and_deterministic_failures_announce(self):
        self.assertIsNone(self.fail("error", attempt=3))
        self.notifier.emit.assert_awaited()
        self.assertIsNone(self.fail("timeout"))
        self.assertIsNone(self.fail("error", trigger="replay"))

    def test_interactive_turns_do_not_retry(self):
        """对话、纠正：人在页面上看着，不自动重试（等重试期间会话的下一条会被挡住）"""
        self.assertIsNone(self.fail("error", trigger="chat"))
        self.assertIsNone(self.fail("error", trigger="correction"))
        self.assertEqual(self.fail("error", trigger="web"), 30)


class RetryDueTest(unittest.TestCase):
    """到点的自动重试：领走 → 续跑；开始不了的取消重试再收尾；暂停时顺延；一条出错不耽误别的。"""

    def setUp(self):
        from agent_platform.orchestration import scheduler as scheduler_mod
        from agent_platform.orchestration.scheduler import Scheduler
        self.reg = seeded_registry()
        self.sub = mock.MagicMock()
        self.sub.resume = mock.AsyncMock(return_value=Accepted("r1", "r1", "queued"))
        self.sched = Scheduler(self.reg, self.sub)
        self.sched.settle_failed = mock.AsyncMock()
        self.runs = mock.MagicMock()
        self.runs.RETRY_LEASE_S = 300
        self.runs.claim_due_retries = mock.AsyncMock(return_value=["r1"])
        self.runs.get = mock.AsyncMock(return_value=a_run(run_id="r1", task="data-qa", status="failed",
                                                          retry_at="2026-10-21T10:00:00+00:00"))
        for f in ("clear_retry", "log_event", "postpone_retry"):
            setattr(self.runs, f, mock.AsyncMock(return_value=True))
        self.ticks = mock.MagicMock()
        self.ticks.record = mock.AsyncMock()
        for name, value in (("runs", self.runs), ("ticks", self.ticks)):
            p = mock.patch.object(scheduler_mod, name, value)
            p.start()
            self.addCleanup(p.stop)

    def test_fires(self):
        self.assertEqual(run(self.sched.retry_due()), 1)
        self.sub.resume.assert_awaited()
        self.assertEqual(self.ticks.record.await_args.kwargs["outcome"], "fired")

    def test_rejected_settles_once(self):
        self.sub.resume = mock.AsyncMock(side_effect=Rejected("task_disabled", "停用了", 400))
        run(self.sched.retry_due())
        self.runs.clear_retry.assert_awaited_with("r1")
        self.sched.settle_failed.assert_awaited_with("r1")
        # 人恰好在这时取消了重试（取消那边已经收过尾）：不再收一次
        self.sched.settle_failed.reset_mock()
        self.runs.clear_retry = mock.AsyncMock(return_value=False)
        run(self.sched.retry_due())
        self.sched.settle_failed.assert_not_awaited()

    def test_paused_postpones(self):
        run(self.reg.update("service", "vision-board", {"envs": {"test": {"triggers_paused": True}}}, "liyd"))
        run(self.sched.retry_due())
        self.sub.resume.assert_not_awaited()
        self.runs.postpone_retry.assert_awaited()
        self.assertEqual(self.ticks.record.await_args.kwargs["outcome"], "skipped")

    def test_unexpected_error_keeps_lease_and_continues(self):
        self.runs.claim_due_retries = mock.AsyncMock(return_value=["r1", "r2"])
        self.sub.resume = mock.AsyncMock(side_effect=[RuntimeError("db down"), Accepted("r2", "r2", "queued")])
        self.assertEqual(run(self.sched.retry_due()), 1)
        self.runs.clear_retry.assert_not_awaited()          # 租约留着，到期后再领
        self.sched.settle_failed.assert_not_awaited()


class PendingRetryActionsTest(unittest.TestCase):
    """失败了、还等着自动重试的运行：重跑会取消原运行的重试（不然同一份输入跑两遍）。"""

    def setUp(self):
        self.reg = seeded_registry()
        self.sub = Submitter(self.reg)
        self.sub.on_failed_final = mock.AsyncMock()
        self.runs = mock.MagicMock()
        for f in ("create", "log_event"):
            setattr(self.runs, f, mock.AsyncMock(return_value=None))
        self.runs.clear_retry = mock.AsyncMock(return_value=True)
        self.runs.get = mock.AsyncMock(return_value={
            "run_id": "old1", "session_id": "old1", "task": "data-qa", "service": "vision-board", "env": "test",
            "status": "failed", "retry_at": "2026-10-21T10:00:00+00:00", "input": {"question": "q"}, "summary": "q",
            "memory": {}, "trigger": {"type": "api"}})
        p = mock.patch.object(submitter_mod, "runs", self.runs)
        p.start()
        self.addCleanup(p.stop)

    def test_rerun_cancels_pending_retry(self):
        caller = mock.Mock()
        caller.name = "liyd"
        run(self.sub.rerun("old1", caller))
        self.runs.clear_retry.assert_awaited_with("old1")
        self.sub.on_failed_final.assert_awaited_with("old1")


class PauseAndSourcesTest(unittest.TestCase):
    def test_triggers_paused_blocks_only_automatic(self):
        reg = seeded_registry()
        run(reg.update("service", "vision-board", {"envs": {"test": {"triggers_paused": True}}}, "liyd"))
        t = run(reg.task("daily-inspection")).spec
        with self.assertRaises(Rejected) as cm:
            run(gates.admit(reg, task_name="daily-inspection", task=t, service="vision-board", env="test",
                            trigger_type="schedule"))
        self.assertEqual(cm.exception.code, "triggers_paused")
        run(gates.admit(reg, task_name="daily-inspection", task=t, service="vision-board", env="test", trigger_type="api"))
        run(gates.admit(reg, task_name="daily-inspection", task=t, service="vision-board", env="prod",
                        trigger_type="schedule"))

    def test_dagster_event_types(self):
        parse = SOURCES["dagster"].parse
        self.assertEqual(parse({"run_id": "r", "error": "x"}, {})[0].name, "run_failure")
        ok = parse({"event": "run_success", "run_id": "r", "asset_keys": ["a", "b"], "env": "test"}, {})[0]
        self.assertEqual((ok.name, ok.data["asset_keys"]), ("run_success", "a,b"))
        check = parse({"asset_key": "a", "check": "fresh", "severity": "ERROR"}, {"x-event": "asset_check_failed"})[0]
        self.assertEqual((check.name, check.data["check"]), ("asset_check_failed", "fresh"))


if __name__ == "__main__":
    unittest.main()
