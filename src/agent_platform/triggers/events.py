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
from ..store import ticks
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
            matched, filtered = await self._matching(source, event)
            brief = _brief(event)
            for task_name, trigger in filtered:
                await ticks.record("event", "filtered", task=task_name, trigger_id=trigger.id, env=event.data.get("env"),
                                   source=source, reason=f"{source}.{event.name} 不满足过滤条件",
                                   detail={"event": event.name, "data": brief, "filter": trigger.filter})
            if not matched:
                await ticks.record("event", "unmatched", env=event.data.get("env"), source=source,
                                   reason=f"{source}.{event.name} 没有任务接（没有任务声明这个事件，或过滤条件都不满足）",
                                   detail={"event": event.name, "data": brief})
            for task_name, trigger in matched:
                results.append(await self._fire(task_name, trigger, source, event, caller))
        return {"source": source, "events": [e.name for e in events], "matched": results}

    async def _matching(self, source: str, event: Event) -> tuple[list[tuple[str, EventTrigger]], list[tuple[str, EventTrigger]]]:
        """→ (匹配上的, 事件对上了但过滤条件不满足的)。"""
        out, filtered = [], []
        for raw in await self._reg.tasks():
            if raw.spec.extends and "triggers" not in raw.spec.model_fields_set:
                continue                                  # 子任务没声明自己的触发：只由父任务接收
            task = (await self._reg.task(raw.name)).spec
            for t in task.triggers_of("event"):
                if t.source == source and t.event in (event.name, "*"):
                    (out if t.accepts(event.data) else filtered).append((raw.name, t))
        return out, filtered

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
        common = {"task": item["task"], "trigger_id": t.id, "env": req.env, "source": source,
                  "detail": {"event": event.name, "data": _brief(event), "rule": item["rule"]}}
        try:
            accepted = await self._submitter.submit(req, trigger=trigger, caller=caller, rule=rule)
        except Rejected as e:
            log.info("事件 %s/%s → 任务 %s 被拒：%s", source, event.name, task_name, e.message)
            await ticks.record("event", "rejected", reason=e.message, **common)
            return {**item, "run_id": None, "status": "rejected", "error": {"code": e.code, "message": e.message}}
        await ticks.record("event", "deduped" if accepted.dedup else "fired", run_id=accepted.run_id,
                           reason="命中去重，复用已有的运行" if accepted.dedup
                           else (f"规则先行命中（{rule['category']}）" if rule else f"{source}.{event.name}"), **common)
        return {**item, "run_id": accepted.run_id, "status": accepted.status, "dedup": accepted.dedup, "error": None}


_SECRET_KEY = re.compile(r"password|passwd|secret|token|api_?key|access_key|private_key|authorization", re.IGNORECASE)
_URL_PASSWORD = re.compile(r"(\w+://[^:/@\s]+:)[^@\s]+@")
_SECRET_ASSIGN = re.compile(r"((?:password|passwd|secret|token|api_?key)\s*[=:]\s*)\S+", re.IGNORECASE)


def _brief(event: Event) -> dict:
    """触发记录里留的事件字段（任何密钥都能经 /v1/ticks 读到，存 30 天）：长文本截短（报错堆栈动辄几十 KB），
    像密钥的字段整个打码，文本里连接串的口令、password=… 这类赋值也打码。"""
    def clean(k: str, v):
        if _SECRET_KEY.search(k):
            return "***"
        if not isinstance(v, str):
            return v
        v = _SECRET_ASSIGN.sub(r"\1***", _URL_PASSWORD.sub(r"\1***@", v))
        return v[:300] + "…" if len(v) > 300 else v
    return {k: clean(k, v) for k, v in list(event.data.items())[:20]}


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
