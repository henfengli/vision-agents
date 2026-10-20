"""响应形状：把领域对象与台账行拼成接口返回的样子。与 web/src/api/types.ts 一一对应。"""

from __future__ import annotations

from ..registry import Entry
from ..store import approvals as approvals_store
from ..store import artifacts as artifacts_store
from ..store import assets as assets_store
from ..store import feedback as feedback_store
from ..store import knowledge as knowledge_store
from ..store import runs


def service_summary(entry: Entry, env_names: list[str], health: dict, running: dict, task_count: int) -> dict:
    """Service + 每个环境的健康汇总。"""
    procs = len(entry.spec.processes)
    per_env = {}
    for env in env_names:
        h = health.get((entry.name, env), {})
        per_env[env] = {
            "enabled": entry.spec.view(entry.name, env).enabled,
            "runs_24h": h.get("runs_24h", 0), "failed_24h": h.get("failed_24h", 0), "last_run": h.get("last_run"),
            "running_processes": running.get((entry.name, env), 0), "total_processes": procs,
        }
    return {**entry.dump(), "task_count": task_count, "health": per_env}


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
    """Run：列表字段 + 输入输出 + 待审批 + 上下文（注入了什么、沉淀了什么、同会话的其他轮、任务图）。"""
    run_id = run["run_id"]
    events = await runs.events(run_id)
    stage = {e["payload"].get("stage"): e["payload"] for e in events if e["kind"] == "stage"}
    feedback = [f for f in await feedback_store.for_run(run_id) if f["kind"] == "rating"]
    session_runs = [{"run_id": r["run_id"], "task": r["task"], "status": r["status"], "created_at": r["created_at"]}
                    for r in await runs.by_session(run["session_id"], exclude=run_id)]
    return {
        **list_item(run, titles),
        "task_version": run.get("task_version"), "role_version": run.get("role_version"),
        "input": run["input"], "output": run.get("output"), "error_code": run.get("error_code"),
        "memory": run.get("memory") or {},
        "pending_approval": await approvals_store.pending_of_run(run_id),
        "feedback": ({"score": feedback[-1]["score"], "comment": feedback[-1]["comment"] or "",
                      "at": feedback[-1]["created_at"]} if feedback else None),
        "context": {
            "profile": (stage.get("profile") or {}).get("content", ""),
            "recalled_knowledge": (stage.get("recall") or {}).get("hits", []),
            "recalled_assets": (stage.get("assets") or {}).get("assets", []),
            "saved_knowledge": [{"id": k["id"], "key": k["key"]} for k in await knowledge_store.by_source_run(run_id)
                                if not k["key"].startswith("session:")],
            "saved_assets": [{"id": a["id"], "kind": a["kind"], "name": a["name"]}
                             for a in await assets_store.by_source_run(run_id)],
            "session_runs": session_runs,
            "graph": await _graph(run_id, stage.get("graph"), events),
        },
    }


async def _graph(run_id: str, topology: dict | None, events: list[dict]) -> dict | None:
    if not topology:
        return None
    status = {a["name"]: a["status"] for a in await artifacts_store.list_by_run(run_id)}
    latest = {e["payload"]["node"]: e["payload"] for e in events if e["kind"] == "artifact"}
    return {
        "nodes": [{"id": n["id"], "kind": n["kind"],
                   "status": status.get(n["id"]) or ("running" if latest.get(n["id"], {}).get("status") == "running" else "pending"),
                   "summary": latest.get(n["id"], {}).get("content")} for n in topology["nodes"]],
        "edges": topology["edges"],
    }


def chat_turn(run: dict, events: list[dict], feedback: int | None) -> dict:
    output = run.get("output") or {}
    return {"run_id": run["run_id"], "question": run["input"].get("question", run["summary"]),
            "answer": output.get("answer") or output.get("error"), "status": run["status"],
            "events": [e for e in events if e["kind"] in ("stage", "thought", "tool_call", "tool_result", "approval")],
            "feedback": feedback, "created_at": run["created_at"]}
