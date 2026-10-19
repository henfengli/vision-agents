"""管理页：角色/任务/策略的列表 + 结构化编辑 + 版本时间线 + 同页 diff。

布局参照 Langfuse prompt 管理：左栏列表（名称/当前版本/近 24h run 数），
右栏编辑器（已知字段结构化表单，未识别字段落「高级 JSON」原样保留）。
版本历史与 diff 数据源是 PG definitions（Langfuse 只是角色定义的同步写
目标，见 langfuse.py）；编辑动作走 /v1/admin/* 既有 API，保存即新版本
即时生效。
"""

from __future__ import annotations

import difflib
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

from ...store import feedback as feedback_store
from ...store import runs as runs_store
from .base import render

KINDS = ("role", "task", "policy", "rules")


def make_router(defs_store, env: str, langfuse=None,
                tool_names: list[str] | None = None,
                domains: list[str] | None = None,
                target_envs: list[str] | None = None) -> APIRouter:
    router = APIRouter()

    @router.get("/admin", response_class=HTMLResponse)
    async def admin_page():
        usage = await runs_store.usage_24h()
        items = {}
        for kind in KINDS:
            rows = await defs_store.list_active(kind, env)
            for r in rows:
                # 影响面：角色/任务按名聚合；策略无 run 维度
                r["usage"] = usage.get(kind, {}).get(r["name"])
            items[kind] = rows
        # 升舱提示：同一 session 被反复纠正，记忆层兜不住，建议升角色 prompt
        escalations = await feedback_store.correction_counts(min_count=3)
        source = ("Langfuse 为源头" if langfuse is not None and langfuse.enabled
                  else "PG 为源头（Langfuse 未启用）")
        return render(
            "admin.html", "管理", active="/admin",
            items=items, escalations=escalations, source=source,
            # 编辑器的结构化选项：工具目录、域、目标环境、角色名（任务用）
            tool_names=tool_names or [], domains=domains or [],
            envs=sorted({env, *(target_envs or [])}),
            role_names=[r["name"] for r in items.get("role", [])],
            defs_json=json.dumps(
                {k: {r["name"]: r for r in rows} for k, rows in items.items()},
                ensure_ascii=False))

    @router.get("/admin/defs/{kind}/{name}/history.json")
    async def def_history(kind: str, name: str):
        """版本时间线数据：版本号/更新人/时间（定义体大，diff 时再按需取）。"""
        if kind not in KINDS:
            raise HTTPException(422, f"kind 只能是 {'/'.join(KINDS)}")
        history = await defs_store.history(kind, env, name)
        if not history:
            raise HTTPException(404, f"{kind}:{name} 不存在")
        return {"history": [{"version": h["version"],
                             "updated_by": h["updated_by"],
                             "created_at": h["created_at"]} for h in history]}

    @router.get("/admin/diff")
    async def def_diff(kind: str, name: str, a: int, b: int, format: str = ""):
        """两个版本的定义 diff。format=json 供管理页内联渲染；默认整页 HTML
        （直链/新窗口打开）。排查"当时那版 prompt 怎么写的"的落点。"""
        if kind not in ("role", "task", "rules"):
            raise HTTPException(422, "kind 只能是 role/task/rules")
        history = await defs_store.history(kind, env, name)
        by_version = {h["version"]: h for h in history}
        if a not in by_version or b not in by_version:
            raise HTTPException(404, f"{kind}:{name} 缺少版本 {a} 或 {b}")

        def pretty(v: int) -> list[str]:
            return json.dumps(by_version[v]["definition"], ensure_ascii=False,
                              indent=2, sort_keys=True).splitlines()

        diff = list(difflib.unified_diff(
            pretty(a), pretty(b),
            fromfile=f"{name} v{a}（{by_version[a]['updated_by'] or '?'}）",
            tofile=f"{name} v{b}（{by_version[b]['updated_by'] or '?'}）",
            lineterm=""))
        if format == "json":
            return {"diff": "\n".join(diff)}
        return render("diff.html", f"diff {name}", active="/admin",
                      kind=kind, name=name, a=a, b=b,
                      diff_text="\n".join(diff))

    return router
