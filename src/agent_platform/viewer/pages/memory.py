"""记忆管理页：知识条目查看/筛选/编辑。"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from ...store import knowledge as knowledge_store
from .base import render


class MemoryUpdateRequest(BaseModel):
    content: str


def make_router(env: str, target_envs: list[str] | None = None) -> APIRouter:
    router = APIRouter()

    @router.get("/memory", response_class=HTMLResponse)
    async def memory_page(request: Request, domain: str = "",
                          include_inactive: bool = False):
        # 记忆按目标环境分区：?env=xxx 切换查看；缺省看实例默认环境
        view_env = request.query_params.get("env") or env
        items = await knowledge_store.list_all(
            view_env, domain or None, include_inactive=include_inactive)
        entries_json = json.dumps(
            {i["id"]: i["content"] for i in items},
            ensure_ascii=False).replace("</", "<\\/")  # 防内容里的 </script> 提前闭合
        return render("memory.html", "记忆管理", active="/memory",
                      items=items, domain=domain,
                      include_inactive=include_inactive,
                      view_env=view_env, target_envs=target_envs or [],
                      entries_json=entries_json)

    @router.post("/memory/{entry_id}")
    async def memory_update(entry_id: int, req: MemoryUpdateRequest):
        if not req.content.strip():
            raise HTTPException(422, "内容不能为空")
        await knowledge_store.update_content(entry_id, req.content)
        return {"status": "ok"}

    return router
