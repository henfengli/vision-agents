"""事件入口：POST /v1/events/{source} → 匹配任务上的 event 触发器 → 每个匹配发起一次运行。

一条事件可以匹配多个任务；每个匹配：
1. filter 全部满足（字段 → 正则）才算匹配
2. map 把事件字段映射成任务输入（没写映射就整份透传）
3. rules 规则先行：报错命中规则直接给结论（不调模型），但同样留一条运行记录（resolution=rule）
4. session 模板决定会话：同一类事件续进同一个会话，跨类 / 跨天自动开新会话
"""

from __future__ import annotations

import datetime
import logging
import re
from collections import defaultdict

from ..domain import Caller, EventTrigger, Rejected, RunRequest, RunTrigger
from ..orchestration.submitter import Submitter
from ..registry import Registry
from .sources import SOURCES, Event

log = logging.getLogger(__name__)


class EventRouter:
    def __init__(self, registry: Registry, submitter: Submitter):
        self._reg = registry
        self._submitter = submitter

    async def receive(self, source: str, body: dict, headers: dict, caller: Caller) -> dict:
        src = SOURCES.get(source)
        if src is None:
            raise Rejected("unknown_source", f"未知事件来源 {source}（可用：{'、'.join(SOURCES)}）", 404)
        events = src.parse(body, {k.lower(): v for k, v in headers.items()})
        results = []
        for event in events:
            for task_name, trigger in await self._matching(source, event):
                results.append(await self._fire(task_name, trigger, source, event, caller))
        return {"source": source, "events": [e.name for e in events], "matched": results}

    async def _matching(self, source: str, event: Event) -> list[tuple[str, EventTrigger]]:
        out = []
        for raw in await self._reg.tasks():
            if raw.spec.extends and "triggers" not in raw.spec.model_fields_set:
                continue                                  # 子任务没声明自己的触发：只由父任务接收
            task = (await self._reg.task(raw.name)).spec
            for t in task.triggers_of("event"):
                if t.source == source and t.event in (event.name, "*") and t.accepts(event.data):
                    out.append((raw.name, t))
        return out

    async def _fire(self, task_name: str, t: EventTrigger, source: str, event: Event, caller: Caller) -> dict:
        data = event.data
        base, _, obj = task_name.partition(":")
        rule = _first_rule(t, str(data.get("error") or ""))
        req = RunRequest(task=base, subtask=obj or data.get("subtask"), env=data.get("env"),
                         service=t.service or data.get("service"), input=t.input_from(data),
                         session_id=_session(t.session, data, rule))
        trigger = RunTrigger(type="event", id=t.id, source=source, caller=caller.name)
        item = {"task": f"{base}:{req.subtask}" if req.subtask else base, "trigger": t.id,
                "rule": rule["category"] if rule else None}
        try:
            accepted = await self._submitter.submit(req, trigger=trigger, caller=caller, rule=rule)
        except Rejected as e:
            log.info("事件 %s/%s → 任务 %s 被拒：%s", source, event.name, task_name, e.message)
            return {**item, "run_id": None, "status": "rejected", "error": {"code": e.code, "message": e.message}}
        return {**item, "run_id": accepted.run_id, "status": accepted.status, "dedup": accepted.dedup, "error": None}


def _first_rule(t: EventTrigger, error: str) -> dict | None:
    if not error:
        return None
    for r in t.rules:
        if r.enabled and re.search(r.pattern, error, re.IGNORECASE):
            return {"category": r.category, "conclusion": r.conclusion, "pattern": r.pattern}
    return None


def _session(template: str | None, data: dict, rule: dict | None) -> str | None:
    """会话模板里可用事件的任意字段，外加 {error_class}（命中规则的类别，否则 unknown）与 {date}。"""
    if not template:
        return None
    values = defaultdict(lambda: "_", {k: re.sub(r"[^\w.-]+", "_", str(v))[:80] for k, v in data.items()})
    values["error_class"] = rule["category"] if rule else "unknown"
    values["date"] = datetime.date.today().isoformat()
    return template.format_map(values)
