"""任务定义的写入检查、子任务覆盖的增删、平台配置的引用检查、对象字段与子任务的互相补齐。不需要 Postgres。"""

import asyncio
import unittest
from unittest import mock

from support import seeded_registry

from agent_platform.domain import Rejected, RunRequest, RunTrigger, TaskDef, consistency_error, object_value
from agent_platform.orchestration import submitter as submitter_mod
from agent_platform.orchestration.submitter import Submitter

run = asyncio.run


def task(**kw) -> TaskDef:
    base = {"role": "r", "input": {"q": {"type": "str"}}}
    return TaskDef.model_validate({**base, **kw})


def event(**kw) -> dict:
    return {"id": "ev", "type": "event", "source": "dagster", "event": "run_failure", **kw}


class ConsistencyTest(unittest.TestCase):
    def assertProblem(self, t: TaskDef, *fragments: str):
        why = consistency_error(t)
        self.assertIsNotNone(why, "应当不通过")
        for f in fragments:
            self.assertIn(f, why)

    def test_valid_definition(self):
        self.assertIsNone(consistency_error(task(triggers=[event(session="dagster:{q}:{date}", rules=[
            {"pattern": "oom", "conclusion": "内存不足"}])])))

    def test_event_rules(self):
        self.assertProblem(task(triggers=[event(rules=[{"pattern": " ", "conclusion": "x"}])]), "正则是空的")
        self.assertProblem(task(triggers=[event(rules=[{"pattern": "oom", "conclusion": ""}])]), "没写结论")

    def test_event_filter_regex_is_checked_on_write_only(self):
        t = task(triggers=[event(filter={"asset_key": "("})])     # 读库时照样能读出来
        self.assertProblem(t, "过滤", "正则不合法")
        self.assertFalse(t.triggers[0].accepts({"asset_key": "x"}))   # 收事件时当作不匹配，不炸

    def test_session_template(self):
        self.assertProblem(task(triggers=[event(session="dagster:{q")]), "会话命名模板")
        self.assertProblem(task(triggers=[event(session="dagster:{a b}")]), "占位要是字段名")
        self.assertProblem(task(triggers=[event(session="dagster:{}")]), "占位要是字段名")
        self.assertIsNone(consistency_error(task(triggers=[event(session="{{literal}}:{q}")])))

    def test_dedup_fields(self):
        self.assertProblem(task(dedup={"key": "q+missing"}), "去重字段不在输入里", "missing")
        self.assertProblem(task(dedup={"key": " + "}), "去重要写按哪个输入字段")
        self.assertIsNone(consistency_error(task(dedup={"key": "q"})))

    def test_schedule(self):
        sched = {"id": "daily", "type": "schedule", "cron": "0 9 * * *", "envs": ["prod"], "input": {}}
        self.assertProblem(task(envs=["test"], triggers=[sched]), "定时 daily", "prod")
        t = task(input={"scope": {"type": "enum", "options": ["full", "quick"]}}, triggers=[{**sched, "input": {"scope": "all"}}])
        self.assertProblem(t, "固定输入不合法", "scope")

    def test_inputs(self):
        self.assertProblem(task(input={"1bad": {"type": "str"}}), "字段名")
        self.assertProblem(task(input={"kind": {"type": "enum"}}), "至少要有一个选项")
        self.assertProblem(task(object_input="asset_key"), "对象字段 asset_key 不在输入字段里")

    def test_builtin_handler(self):
        self.assertProblem(TaskDef(form="builtin", handler="nope"), "未知的内建处理器")
        self.assertIsNone(consistency_error(TaskDef(form="builtin", handler="memory-gardener")))


class ObjectValueTest(unittest.TestCase):
    def test_only_usable_names(self):
        t = task(input={"asset_key": {"type": "str"}}, object_input="asset_key")
        self.assertEqual(object_value(t, {"asset_key": " dws_a "}), "dws_a")
        self.assertEqual(object_value(t, {"asset_key": 42}), "42")
        self.assertEqual(object_value(t, {"asset_key": "a/b"}), "")        # Dagster 多段 key：落在父任务上
        self.assertEqual(object_value(t, {"asset_key": True}), "")
        self.assertEqual(object_value(t, {}), "")
        self.assertEqual(object_value(task(), {"q": "x"}), "")           # 没声明对象字段


class SubtaskOverrideTest(unittest.TestCase):
    SUB = "failure-analysis:dws_a"

    def setUp(self):
        self.reg = seeded_registry()
        run(self.reg.create("task", self.SUB, {"extends": "failure-analysis", "auto_created": True}, "auto:api"))

    def stored(self) -> dict:
        return run(self.reg.store.get("task", self.SUB))["definition"]

    def test_null_removes_override_and_human_edit_clears_auto_created(self):
        run(self.reg.update("task", self.SUB, {"title": "账户收益日表", "timeout_s": 1200}, "liyd"))
        d = self.stored()
        self.assertEqual((d["title"], d["timeout_s"]), ("账户收益日表", 1200))
        self.assertNotIn("auto_created", d)                                # 人改过：不再算自动创建
        run(self.reg.update("task", self.SUB, {"timeout_s": None}, "liyd"))
        d = self.stored()
        self.assertNotIn("timeout_s", d)                                   # 去掉覆盖
        self.assertEqual(d["title"], "账户收益日表")
        self.assertEqual(run(self.reg.task(self.SUB)).spec.timeout_s, 900)   # 重新跟随父任务

    def test_auto_edit_keeps_auto_created(self):
        run(self.reg.update("task", self.SUB, {"profile": {"pitfalls": "x"}}, "auto:api"))
        self.assertTrue(self.stored()["auto_created"])

    def test_effective_definition_is_checked(self):
        with self.assertRaises(Rejected) as cm:     # 子任务只存差异：检查的是和父任务合并之后的
            run(self.reg.update("task", self.SUB, {"dedup": {"key": "nope"}}, "liyd"))
        self.assertIn("去重字段", cm.exception.message)

    def test_parent_change_must_keep_children_valid(self):
        run(self.reg.update("task", self.SUB, {"dedup": {"key": "asset_key"}}, "liyd"))   # 用的是父任务的字段
        with self.assertRaises(Rejected) as cm:     # 父任务去掉这个字段：子任务合并后不成立，不让存
            run(self.reg.update("task", "failure-analysis", {
                "input": {"run_id": {"type": "str", "required": True}}, "object_input": None}, "liyd"))
        self.assertIn(self.SUB, cm.exception.message)

    def test_env_override_ignores_inherited_schedule(self):
        # 子任务没写自己的触发：父任务的定时不按它触发，收窄环境不该被父任务定时的环境卡住；之后改父任务也不受它影响
        run(self.reg.create("task", "daily-inspection:pnl", {"extends": "daily-inspection"}, "auto:api"))
        run(self.reg.update("task", "daily-inspection:pnl", {"envs": ["test"]}, "liyd"))
        run(self.reg.update("task", "daily-inspection", {"title": "巡检"}, "liyd"))
        with self.assertRaises(Rejected):          # 子任务自己写了定时，就按它自己的查
            run(self.reg.update("task", "daily-inspection:pnl", {"triggers": [
                {"id": "m", "type": "schedule", "cron": "0 9 * * *", "envs": ["prod"], "input": {}}]}, "liyd"))

    def test_auto_created_subtask_not_blocked_by_legacy_parent(self):
        # 新规则之前存的父任务（这里：规则没写结论）：调用时自动建对象不能因此 422，问题留在父任务上改
        stored = run(self.reg.store.get("task", "frontend-smoke"))["definition"]
        stored["triggers"][0]["rules"] = [{"pattern": "boom", "conclusion": ""}]
        run(self.reg.store.put("task", "frontend-smoke", stored, "legacy"))
        run(self.reg.create("task", "frontend-smoke:x", {"extends": "frontend-smoke", "auto_created": True}, "auto:api"))
        with self.assertRaises(Rejected):
            run(self.reg.update("task", "frontend-smoke", {"title": "冒烟"}, "liyd"))

    def test_no_subtasks_of_builtin_tasks(self):
        with self.assertRaises(Rejected):
            run(self.reg.create("task", "memory-gardener:x", {"extends": "memory-gardener"}, "liyd"))

    def test_deliver_channel_must_exist(self):
        with self.assertRaises(Rejected) as cm:
            run(self.reg.update("task", "daily-inspection", {"deliver": {"channel": "nope"}}, "liyd"))
        self.assertIn("渠道 nope 不存在", cm.exception.message)


class ConfigReferenceTest(unittest.TestCase):
    def setUp(self):
        self.reg = seeded_registry()

    def body(self, section: str) -> dict:
        return run(self.reg.config(section)).model_dump(mode="json")

    def test_removing_used_env_is_refused(self):
        body = self.body("envs")
        body["items"] = [e for e in body["items"] if e["name"] != "prod"]
        with self.assertRaises(Rejected) as cm:
            run(self.reg.put_config("envs", body, "liyd"))
        self.assertEqual((cm.exception.code, cm.exception.status), ("in_use", 409))
        self.assertTrue(any("failure-analysis" in u for u in cm.exception.detail["used_by"]))

    def test_adding_env_is_fine(self):
        body = self.body("envs")
        body["items"].append({"name": "dev", "title": "开发"})
        self.assertIn("dev", [e["name"] for e in run(self.reg.put_config("envs", body, "liyd"))["items"]])

    def test_removing_used_channel_is_refused(self):
        body = self.body("notifications")
        body["channels"] = {}
        body["rules"] = []
        with self.assertRaises(Rejected) as cm:
            run(self.reg.put_config("notifications", body, "liyd"))
        self.assertEqual(cm.exception.code, "in_use")
        self.assertTrue(any("daily-inspection" in u for u in cm.exception.detail["used_by"]))


class SubmitterObjectTest(unittest.TestCase):
    """对象字段和子任务互相补齐；对话里同一会话同时只能有一轮。runs 的读写换成替身。"""

    def setUp(self):
        self.reg = seeded_registry()
        self.sub = Submitter(self.reg)
        self.runs = mock.MagicMock()
        for f in ("find_idempotent", "find_dedup", "live_in_session", "create"):
            setattr(self.runs, f, mock.AsyncMock(return_value=None))
        patcher = mock.patch.object(submitter_mod, "runs", self.runs)
        patcher.start()
        self.addCleanup(patcher.stop)

    def submit(self, trigger="api", **req):
        return run(self.sub.submit(RunRequest(**req), trigger=RunTrigger(type=trigger, caller="t")))

    def created(self) -> dict:
        return self.runs.create.await_args.kwargs

    def test_object_input_picks_the_subtask(self):
        acc = self.submit(task="failure-analysis", env="test", input={"run_id": "r1", "asset_key": "dws_a"})
        self.assertEqual(acc.subtask_created, "failure-analysis:dws_a")
        self.assertEqual(self.created()["task"], "failure-analysis:dws_a")
        self.assertIsNotNone(run(self.reg.task_raw("failure-analysis:dws_a")))

    def test_subtask_fills_the_object_input(self):
        self.submit(task="failure-analysis", subtask="dws_b", env="test", input={"run_id": "r2"})
        self.assertEqual(self.created()["input_data"]["asset_key"], "dws_b")

    def test_unusable_object_stays_on_parent(self):
        acc = self.submit(task="failure-analysis", env="test", input={"run_id": "r3", "asset_key": "a/b"})
        self.assertIsNone(acc.subtask_created)
        self.assertEqual(self.created()["task"], "failure-analysis")

    def test_rejected_request_leaves_no_subtask(self):
        with self.assertRaises(Rejected):          # 任务不允许这个环境：闸门拒了，不留子任务
            run(self.reg.update("task", "failure-analysis", {"envs": ["prod"]}, "liyd"))
            self.submit(task="failure-analysis", env="test", input={"asset_key": "dws_c"})
        self.assertIsNone(run(self.reg.task_raw("failure-analysis:dws_c")))

    def test_manual_run_needs_no_ids(self):
        # 手动跑：run_id、asset_key 都不是必填，只给资产也能跑（落到它的子任务）
        acc = self.submit(task="failure-analysis", env="test", input={"asset_key": "dws_d"})
        self.assertEqual(acc.subtask_created, "failure-analysis:dws_d")

    def test_builtin_task_has_no_subtasks(self):
        with self.assertRaises(Rejected) as cm:
            self.submit(task="memory-gardener", subtask="x", service="vision-board", env="test", input={})
        self.assertEqual(cm.exception.code, "invalid_subtask")

    def test_one_live_turn_per_chat_session(self):
        self.runs.live_in_session.return_value = {"run_id": "abcdef1234567890"}
        with self.assertRaises(Rejected) as cm:
            self.submit(trigger="chat", task="ask", service="vision-board", env="test", session_id="s1", input={"question": "hi"})
        self.assertEqual(cm.exception.status, 409)
        self.runs.create.assert_not_awaited()
        self.submit(trigger="api", task="ask", service="vision-board", env="test", session_id="s1", input={"question": "hi"})
        self.runs.create.assert_awaited()          # API 指定会话不受这条限制


class CorrectResumeTest(unittest.TestCase):
    def setUp(self):
        self.reg = seeded_registry()
        self.sub = Submitter(self.reg)
        self.runs = mock.MagicMock()
        for f in ("get", "live_in_session", "create", "reached_agent", "log_event", "enqueue"):
            setattr(self.runs, f, mock.AsyncMock(return_value=None))
        patcher = mock.patch.object(submitter_mod, "runs", self.runs)
        patcher.start()
        self.addCleanup(patcher.stop)

    def old(self, **kw) -> dict:
        row = {"run_id": "old1", "session_id": "s1", "task": "data-qa", "service": "vision-board", "env": "test",
               "status": "success", "resolution": "agent", "input": {"question": "q"}, "summary": "q", "memory": {},
               "trigger": {"type": "chat"}, **kw}
        self.runs.get.return_value = row
        return row

    def test_correction_needs_a_finished_run(self):
        self.old(status="running")
        with self.assertRaises(Rejected):
            run(self.sub.correct("old1", "不对", mock.Mock(name="liyd")))

    def test_correction_points_at_the_corrected_run(self):
        self.old()
        caller = mock.Mock()
        caller.name = "liyd"
        run(self.sub.correct("old1", "口径错了", caller))
        kw = self.runs.create.await_args.kwargs
        self.assertEqual((kw["trigger_type"], kw["trigger_id"], kw["session_id"]), ("correction", "old1", "s1"))
        self.assertIn("[纠正] 口径错了", kw["input_data"]["question"])

    def test_correction_waits_for_live_turn(self):
        self.old()
        self.runs.live_in_session.return_value = {"run_id": "live1234"}
        with self.assertRaises(Rejected) as cm:
            run(self.sub.correct("old1", "x", mock.Mock()))
        self.assertEqual(cm.exception.status, 409)

    def test_resume_before_agent_starts_over(self):
        self.old(status="failed", resolution=None)
        self.runs.reached_agent.return_value = False
        run(self.sub.resume("old1", mock.Mock()))
        self.runs.enqueue.assert_awaited_with("old1", resume=False)
        self.runs.reached_agent.return_value = True
        run(self.sub.resume("old1", mock.Mock()))
        self.runs.enqueue.assert_awaited_with("old1", resume=True)

    def test_resume_waits_for_live_turn(self):
        self.old(status="failed", resolution=None)
        self.runs.live_in_session.return_value = {"run_id": "live1234"}
        with self.assertRaises(Rejected) as cm:
            run(self.sub.resume("old1", mock.Mock()))
        self.assertEqual(cm.exception.status, 409)
        self.runs.enqueue.assert_not_awaited()

    def test_rule_runs_cannot_resume(self):
        self.old(status="failed", resolution="rule", task="failure-analysis")
        with self.assertRaises(Rejected):
            run(self.sub.resume("old1", mock.Mock()))


if __name__ == "__main__":
    unittest.main()
