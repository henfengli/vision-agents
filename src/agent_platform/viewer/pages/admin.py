"""管理页：角色/任务在线编辑 + 版本对比 + 重复纠正升舱提示。"""

from __future__ import annotations

import difflib
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

from ...store import feedback as feedback_store
from .base import render


def make_router(defs_store, env: str, langfuse=None) -> APIRouter:
    router = APIRouter()

    @router.get("/admin", response_class=HTMLResponse)
    async def admin_page():
        roles = await defs_store.list_active("role", env)
        tasks = await defs_store.list_active("task", env)
        policies = await defs_store.list_active("policy", env)
        # 升舱提示：同一 session 被反复纠正，记忆层兜不住，建议升角色 prompt
        escalations = await feedback_store.correction_counts(min_count=3)
        source = ("Langfuse 为源头" if langfuse is not None and langfuse.enabled
                  else "PG 为源头（Langfuse 未启用）")
        return render(
            "admin.html", "管理", active="/admin",
            roles=roles, tasks=tasks, policies=policies,
            escalations=escalations, source=source,
            role_defs=json.dumps({r["name"]: r for r in roles},
                                 ensure_ascii=False),
            task_defs=json.dumps({t["name"]: t for t in tasks},
                                 ensure_ascii=False),
            policy_defs=json.dumps({p["name"]: p for p in policies},
                                   ensure_ascii=False))

    @router.get("/admin/diff", response_class=HTMLResponse)
    async def def_diff(kind: str, name: str, a: int, b: int):
        """两个版本的定义 diff——排查"当时那版 prompt 怎么写的"的落点。"""
        if kind not in ("role", "task"):
            raise HTTPException(422, "kind 只能是 role/task")
        history = await defs_store.history(kind, env, name)
        by_version = {h["version"]: h for h in history}
        if a not in by_version or b not in by_version:
            raise HTTPException(404, f"{kind}:{name} 缺少版本 {a} 或 {b}")

        def pretty(v: int) -> list[str]:
            return json.dumps(by_version[v]["definition"], ensure_ascii=False,
                              indent=2, sort_keys=True).splitlines()

        diff = difflib.unified_diff(
            pretty(a), pretty(b),
            fromfile=f"{name} v{a}（{by_version[a]['updated_by'] or '?'}）",
            tofile=f"{name} v{b}（{by_version[b]['updated_by'] or '?'}）",
            lineterm="")
        return render("diff.html", f"diff {name}", active="/admin",
                      kind=kind, name=name, a=a, b=b,
                      diff_text="\n".join(diff))

    return router
