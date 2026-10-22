"""响应形状：把领域对象与台账行拼成接口返回的样子。与 web/src/api/types.ts 一一对应。"""

from __future__ import annotations

from .. import credentials
from ..domain import EnvDef
from ..registry import Entry
from ..store import approvals as approvals_store
from ..store import assets as assets_store
from ..store import feedback as feedback_store
from ..store import knowledge as knowledge_store
from ..store import runs


def service_summary(entry: Entry, envs: list[EnvDef], health: dict, running: dict, task_count: int) -> dict:
    """Service + 每个环境的健康汇总。定义里的只读库口令不回显（redact_service）。"""
    procs = len(entry.spec.processes)
    per_env = {}
    for e in envs:
        env = e.name
        view = entry.spec.view(entry.name, env)
        h = health.get((entry.name, env), {})
        per_env[env] = {
            "enabled": view.enabled, "python": view.python,
            "runs_24h": h.get("runs_24h", 0), "failed_24h": h.get("failed_24h", 0), "last_run": h.get("last_run"),
            "running_processes": running.get((entry.name, env), 0), "total_processes": procs,
        }
    return {**credentials.redact_service(entry.dump()), "task_count": task_count, "health": per_env}


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


async def run_detail(run: dict, titles: dict[str, str]) -> dict:
    """Run：列表字段 + 输入输出 + 待审批 + 上下文（注入了什么、沉淀了什么、同会话的其他轮）。
    replay_of：回归重放出来的运行，指向被重放的原运行。"""
    run_id = run["run_id"]
    events = await runs.events(run_id)
    stage = {e["payload"].get("stage"): e["payload"] for e in events if e["kind"] == "stage"}
    session_runs = [{"run_id": r["run_id"], "task": r["task"], "status": r["status"], "created_at": r["created_at"]}
                    for r in await runs.by_session(run["session_id"], exclude=run_id)]
    return {
        **list_item(run, titles),
        "task_version": run.get("task_version"), "role_version": run.get("role_version"),
        "replay_of": run["trigger"]["id"] if run["trigger"]["type"] == "replay" else None,
        "input": run["input"], "output": run.get("output"), "error_code": run.get("error_code"),
        "memory": run.get("memory") or {},
        "pending_approval": await approvals_store.pending_of_run(run_id),
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
        },
    }


def chat_turn(run: dict, events: list[dict], feedback: dict | None) -> dict:
    """对话的一轮。feedback 是当前用户对这一轮的评价（没有则 None）。"""
    output = run.get("output") or {}
    return {"run_id": run["run_id"], "question": run["input"].get("question", run["summary"]),
            "answer": output.get("answer") or output.get("error"), "status": run["status"],
            "events": [e for e in events if e["kind"] in ("stage", "thought", "tool_call", "tool_result", "approval")],
            "feedback": feedback, "created_at": run["created_at"]}
