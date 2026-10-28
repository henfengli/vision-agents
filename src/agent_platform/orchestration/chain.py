"""运行结束之后：上游联动（after 触发）和点名等它的运行（depends_on）。

pipeline 在一次运行**最终**结束时调用 on_finished（失败后还要自动重试的不算结束，等重试完再来）：
1. 点名等它的排队运行：它成功了就叫醒 worker 去认领；失败 / 取消了，这些运行不再执行（upstream_failed，连带下游）
2. 上游联动：哪些任务声明了「在它结束后跑」——
   - on 里没有这个状态：不理会（不记录，免得每次结束都给不相干的触发器记一条）
   - 过滤不满足 → filtered；联动层数超过 MAX_DEPTH → rejected
   - mode=all：其它上游还没在窗口内（且在这个触发器上一次触发之后）结束过 → waiting
   - 否则按映射拼输入，在同一个环境提交（幂等键 after:<上游运行>:<状态>:<下游>:<触发器>，重复调用只建一条）
每一步判定都写一条触发记录（store/ticks）。

不触发的：回归重放出来的运行（对比用，不该引出别的运行）、被取消的运行（人主动停的）。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from ..domain import AfterTrigger, Rejected, RunRequest, RunTrigger, run_fields
from ..registry import Registry
from ..store import runs, ticks

log = logging.getLogger(__name__)

MAX_DEPTH = 5          # 联动最多几层：A → B → C … 超过就不再往下触发（定义上已经不允许成环，这是兜底）


class Chainer:
    def __init__(self, registry: Registry, submitter):
        self._reg = registry
        self._submitter = submitter

    async def on_finished(self, run_id: str) -> None:
        run = await runs.get(run_id)
        if run is None or run["trigger"]["type"] == "replay":
            return
        status = run["status"]
        if status == "failed" and run.get("retry_at"):
            return                                   # 还要自动重试：不算结束
        await self._settle_dependents(run)
        if status not in ("success", "failed"):
            return
        depth = await self._depth(run)
        for downstream, trigger in await self._listeners(run["task"]):
            if status not in trigger.on:
                continue
            try:
                await self._consider(run, depth, downstream, trigger)
            except Exception:  # noqa: BLE001 —— 一个下游出错不影响别的
                log.exception("上游联动 %s → %s/%s 失败", run_id, downstream, trigger.id)

    async def _settle_dependents(self, run: dict) -> None:
        if run["status"] == "success":
            if await runs.has_waiting_dependents(run["run_id"]):
                await runs.wake()
            return
        what = "失败" if run["status"] == "failed" else "被取消"
        reason = f"点名等的上游运行 {run['run_id'][:8]}（{run['task']}）{what}了，这次没有执行"
        for rid in await runs.fail_dependents(run["run_id"], reason):
            await runs.log_event(rid, "error", {"title": "upstream_failed", "content": reason})

    async def _depth(self, run: dict) -> int:
        """这次运行在联动链上的第几层（自己由联动触发的，往上数）。"""
        depth, current, seen = 0, run, set()
        while current and current["trigger"]["type"] == "after" and current["trigger"]["source"] and depth < 50:
            if current["run_id"] in seen:
                break
            seen.add(current["run_id"])
            depth += 1
            current = await runs.get(current["trigger"]["source"])
        return depth

    async def _listeners(self, task_name: str) -> list[tuple[str, AfterTrigger]]:
        """声明了「在它结束后跑」的任务（子任务要自己写了 triggers 才算），连同那个触发器。"""
        out = []
        for raw in await self._reg.tasks():
            if raw.spec.extends and "triggers" not in raw.spec.model_fields_set:
                continue
            entry = await self._reg.task(raw.name)
            if entry is None:
                continue
            for t in entry.spec.triggers_of("after"):
                if t.watches(task_name) and raw.name != task_name:
                    out.append((raw.name, t))
        return out

    async def _consider(self, run: dict, depth: int, downstream: str, t: AfterTrigger) -> None:
        env, status = run["env"], run["status"]
        common = {"kind": "after", "task": downstream, "trigger_id": t.id, "env": env, "source": run["run_id"]}
        key = f"after:{run['run_id']}:{status}:{downstream}:{t.id}"
        fields = run_fields(run)
        if not t.accepts(fields):
            await ticks.record(outcome="filtered", reason=f"上游 {run['task']} 的这次运行不满足过滤条件",
                               detail={"filter": t.filter}, key=key, **common)
            return
        if depth >= MAX_DEPTH:
            await ticks.record(outcome="rejected", reason=f"联动已经 {depth} 层，超过 {MAX_DEPTH} 层不再往下触发",
                               key=key, **common)
            return

        values = dict(fields)
        if t.mode == "all":
            since = datetime.now(timezone.utc) - timedelta(seconds=t.window_s)
            if last := await runs.last_after_fire(downstream, t.id, env):
                since = max(since, datetime.fromisoformat(last))
            missing = []
            for upstream in t.tasks:
                if run_fields_match(run, upstream):
                    values.update(run_fields(run, prefix=f"{upstream}."))
                    continue
                other = await runs.latest_finished(upstream, env, list(t.on), since.isoformat())
                if other is None:
                    missing.append(upstream)
                else:
                    values.update(run_fields(other, prefix=f"{upstream}."))
            if missing:
                await ticks.record(outcome="waiting", reason=f"还在等 {'、'.join(missing)} 结束（{_window(t.window_s)}内）",
                                   detail={"have": [u for u in t.tasks if u not in missing]}, key=key, **common)
                return

        entry = await self._reg.task(downstream)
        if entry is None:
            return
        spec = entry.spec
        if t.map:
            input_data = {k: values[path] for k, path in t.map.items() if values.get(path) is not None}
        else:                                        # 没写映射：上游输入里和下游同名的字段带过来
            input_data = {k: v for k, v in (run.get("input") or {}).items() if k in spec.input}
        base, _, obj = downstream.partition(":")
        service = (t.service or run["service"]) if spec.service == "*" else None
        req = RunRequest(task=base, subtask=obj or None, env=env, service=service, input=input_data)
        trigger = RunTrigger(type="after", id=t.id, source=run["run_id"], caller=run["trigger"]["caller"] or "after")
        try:
            accepted = await self._submitter.submit(req, trigger=trigger, idempotency_key=key)
        except Rejected as e:
            await ticks.record(outcome="rejected", reason=e.message, detail={"code": e.code}, key=key, **common)
            return
        await ticks.record(outcome="deduped" if accepted.dedup else "fired", run_id=accepted.run_id,
                           reason="命中去重，复用已有的运行" if accepted.dedup else f"上游 {run['task']} {_STATUS[status]}",
                           key=key, **common)


_STATUS = {"success": "成功", "failed": "失败"}


def run_fields_match(run: dict, upstream: str) -> bool:
    """这次结束的运行是不是 upstream（父任务名匹配它的子任务）。"""
    return run["task"] == upstream or run["task"].partition(":")[0] == upstream


def _window(seconds: int) -> str:
    return f"{seconds // 3600} 小时" if seconds >= 3600 and seconds % 3600 == 0 else f"{seconds // 60} 分钟"
