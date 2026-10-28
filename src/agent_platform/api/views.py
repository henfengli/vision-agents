"""响应形状：把领域对象与台账行拼成接口返回的样子。与 web/src/api/types.ts 一一对应。"""

from __future__ import annotations

from .. import credentials
from ..domain import EnvDef
from ..registry import Entry
from ..store import assets as assets_store
from ..store import feedback as feedback_store
from ..store import knowledge as knowledge_store
from ..store import runs


def service_summary(entry: Entry, envs: list[EnvDef], health: dict, task_count: int,
                    generic_task_count: int = 0) -> dict:
    """Service + 每个环境的健康汇总。定义里的只读库口令不回显（redact_service）。

    task_count：本服务专属的任务数；generic_task_count：通用任务（service="*"，调用时指定服务）数，
    服务页的「任务」标签两组一起列。health[env].enabled 是实际是否接收运行（服务整体开关 且 该环境开关），
    env_enabled 只看该环境自己的开关：服务整体停用时页面据此只说一次"服务已停用"，不把每个环境都标成未启用。"""
    per_env = {}
    for e in envs:
        env = e.name
        view = entry.spec.view(entry.name, env)
        override = entry.spec.envs.get(env)
        h = health.get((entry.name, env), {})
        per_env[env] = {
            "enabled": view.enabled, "env_enabled": override.enabled if override is not None else True,
            "triggers_paused": view.triggers_paused, "python": view.python,
            "runs_24h": h.get("runs_24h", 0), "failed_24h": h.get("failed_24h", 0), "last_run": h.get("last_run"),
        }
    return {**credentials.redact_service(entry.dump()), "task_count": task_count,
            "generic_task_count": generic_task_count, "health": per_env}


def task_summary(effective: Entry, own: Entry, stats: dict, next_fire: dict | None, subtask_count: int) -> dict:
    """Task（生效定义）+ 近 24 小时统计 + 下次定时 + 子任务数。
    overrides：子任务自己写了哪些字段（其余跟随父任务），页面据此标"已覆盖"。"""
    s = stats.get(effective.name, {})
    return {
        **effective.dump(),
        "overrides": sorted(own.spec.model_fields_set - {"extends", "auto_created"}) if own.spec.extends else [],
        "stats_24h": {k: s.get(k, 0 if k != "p50_ms" else None) for k in ("runs", "success", "failed", "p50_ms")},
        "last_run": s.get("last_run"), "next_fire": next_fire, "subtask_count": subtask_count,
    }


def list_item(run: dict, titles: dict[str, str]) -> dict:
    base = run["task"].split(":")[0]
    return {**run, "task_title": titles.get(run["task"]) or titles.get(base) or base}


def _last_todo(events: list[dict]) -> list[dict] | None:
    """待办：主 agent 最后一次被接受的 todo 调用的清单（子代理的不算；参数不合格被工具拒了的跳过）。
    tool_call 事件记的是校验前的原始参数，这里按工具的规则再筛一遍。"""
    from ..agent.tools.catalog import TODO_STATUS
    calls = [e["payload"] for e in events if e["kind"] in ("tool_call", "tool_result")
             and e["payload"].get("tool") == "todo" and not e["payload"].get("agent")]
    todo, pending = None, None
    for p in calls:
        if "args" in p:                              # tool_call；结果还没来时先算它
            pending = p.get("args")
        elif pending is not None:
            if not str(p.get("output", "")).startswith("[参数]"):
                todo = pending
            pending = None
    for args in (pending, todo):
        items = args.get("items") if isinstance(args, dict) else None
        if isinstance(items, list) and items and all(
                isinstance(i, dict) and isinstance(i.get("content"), str) and i.get("status", "pending") in TODO_STATUS
                for i in items):
            return [{"content": i["content"], "status": i.get("status", "pending")} for i in items]
    return None


async def run_detail(run: dict, titles: dict[str, str]) -> dict:
    """Run：列表字段 + 输入输出 + 上下文（注入了什么、沉淀了什么、同会话的其他轮）。
    replay_of：回归重放出来的运行，指向被重放的原运行。"""
    run_id = run["run_id"]
    events = await runs.events(run_id)
    stage = {e["payload"].get("stage"): e["payload"] for e in events if e["kind"] == "stage"}
    todo = _last_todo(events)
    session_runs = [{"run_id": r["run_id"], "task": r["task"], "status": r["status"], "created_at": r["created_at"]}
                    for r in await runs.by_session(run["session_id"], exclude=run_id)]
    return {
        **list_item(run, titles),
        "task_version": run.get("task_version"), "role_version": run.get("role_version"),
        "recipe": run.get("recipe"),
        "replay_of": run["trigger"]["id"] if run["trigger"]["type"] == "replay" else None,
        "input": run["input"], "output": run.get("output"), "error_code": run.get("error_code"),
        "memory": run.get("memory") or {},
        "feedback": await feedback_store.for_run(run_id),        # 所有人对整次与各步的评价
        "context": {
            "profile": (stage.get("profile") or {}).get("content", ""),
            "recalled_knowledge": (stage.get("recall") or {}).get("hits", []),
            "recalled_assets": (stage.get("assets") or {}).get("assets", []),
            "saved_knowledge": [{"id": k["id"], "key": k["key"], "kind": k["kind"]}
                                for k in await knowledge_store.by_source_run(run_id) if k["kind"] != "handoff"],
            "saved_assets": [{"id": a["id"], "kind": a["kind"], "name": a["name"]}
                             for a in await assets_store.by_source_run(run_id)],
            "session_runs": session_runs,
            "todo": todo,
        },
        # 执行中的工具（bash / py 跑得久时每几秒一条输出尾部）：{键: {tool, title, output, ms, at}}；结束了就没有
        "progress": run.get("progress") or None,
        "lineage": await _lineage(run, titles),
        "queue": await _queue_state(run) if run["status"] == "queued" else None,
    }


async def _lineage(run: dict, titles: dict[str, str]) -> dict:
    """前后关系：触发它的上游运行（上游联动）、它点名等的运行（depends_on），以及它引出的运行。"""
    upstream_ids = list(run.get("depends_on") or [])
    via = run["trigger"]["source"] if run["trigger"]["type"] == "after" else None
    found = await runs.statuses([*upstream_ids, *([via] if via else [])])
    brief = lambda rid: {**found[rid], "task_title": titles.get(found[rid]["task"]) or titles.get(  # noqa: E731
        found[rid]["task"].split(":")[0]) or found[rid]["task"].split(":")[0]} if rid in found else {"run_id": rid}
    downstream = [list_item(r, titles) for r in await runs.downstream_of(run["run_id"])]
    return {"triggered_by": brief(via) if via else None, "depends_on": [brief(r) for r in upstream_ids],
            "downstream": downstream}


async def _queue_state(run: dict) -> dict:
    """排着队的运行在等什么：点名的上游没成功 / 任务并发满了 / 没有在线的主机负责 / 只是在排队。"""
    from ..store import workers
    waiting = [r for r in (await runs.statuses(run.get("depends_on") or [])).values() if r["status"] != "success"]
    hosts = workers.serving(await workers.list_workers(), run["env"], run["service"])
    running = None
    if run.get("concurrency_limit"):
        running = await runs.running_with_key(run["concurrency_key"])
    return {"waiting_for": [{"run_id": r["run_id"], "status": r["status"], "task": r["task"]} for r in waiting],
            "concurrency": {"limit": run["concurrency_limit"], "running": running} if run.get("concurrency_limit") else None,
            "hosts": [{"host": h["host"], "running": h["running"], "max_concurrent": h["max_concurrent"]} for h in hosts],
            "priority": run.get("priority", 1),
            # 这一次进队列的时刻（续跑、自动重试会重新进）：「已排队多久」从它算
            "since": run.get("queued_at") or run["created_at"]}


def chat_turn(run: dict, events: list[dict], feedback: dict | None) -> dict:
    """对话的一轮。feedback 是当前用户对这一轮的评价（没有则 None）。"""
    output = run.get("output") or {}
    return {"run_id": run["run_id"], "question": run["input"].get("question", run["summary"]),
            "answer": output.get("answer") or output.get("error"), "status": run["status"],
            "events": [e for e in events
                       if e["kind"] in ("stage", "thought", "model_call", "tool_call", "tool_result")],
            "feedback": feedback, "created_at": run["created_at"]}
