"""记忆管理页：知识条目查看/筛选/编辑。"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from ...store import knowledge as knowledge_store
from .base import esc, page


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
        env_opts = ""
        if target_envs:
            env_opts = ('<select name="env" class="inline">'
                        + "".join(
                            f'<option value="{esc(e)}"'
                            f'{" selected" if e == view_env else ""}>{esc(e)}</option>'
                            for e in target_envs) + "</select>")

        def _status(i: dict) -> str:
            if i["superseded"]:
                return '<span class="pill pill-failed">已取代</span>'
            if i["expired"]:
                return '<span class="pill pill-queued">已过期</span>'
            return ('<span class="pill pill-success"><span class="led"></span>生效中</span>'
                    f' <span class="meta">+{i["feedback_score"]}</span>')

        rows = "".join(
            f'<tr><td><span class="tag">{esc(i["domain"])}</span></td>'
            f'<td class="meta">{esc(i["key"])}</td>'
            f'<td><pre style="max-width:520px">{esc(i["content"][:500])}</pre></td>'
            f'<td>{_status(i)}</td>'
            f'<td><button onclick="editEntry({i["id"]})">编辑</button></td></tr>'
            for i in items)
        entries_json = json.dumps(
            {i["id"]: i["content"] for i in items},
            ensure_ascii=False).replace("</", "<\\/")  # 防内容里的 </script> 提前闭合
        body = f"""
        <div class="page-head">
          <div class="eyebrow">MEMORY</div>
          <h2>记忆管理</h2>
          <div class="meta">按环境分区 · 反馈会影响条目权重 · 编辑保存后重新生效</div>
        </div>
        <div class="card">
          <form method="get" class="filter-bar">{env_opts}
            <input name="domain" class="inline" value="{esc(domain)}" placeholder="域过滤">
            <label class="meta"><input type="checkbox" name="include_inactive" value="true"
              {"checked" if include_inactive else ""}> 含失效</label>
            <button>筛选</button></form></div>
        <div class="card"><table class="grid">
          <thead><tr><th>域</th><th>key</th><th>内容</th><th>状态</th><th></th></tr></thead>
          <tbody>{rows or '<tr><td colspan="5" class="meta">暂无条目</td></tr>'}</tbody></table></div>
        <div class="card" id="edit-card" style="display:none">
          <b>编辑条目</b> <span id="edit-id" class="meta"></span>
          <textarea id="edit-content" rows="8"></textarea>
          <button onclick="saveEntry()">保存（重新生效）</button>
          <span id="edit-msg" class="meta"></span></div>
        <script>
        // id → 当前内容，点"编辑"时回填 textarea，避免凭记忆重写
        const ENTRIES = {entries_json};
        let editId = null;
        function editEntry(id) {{
          editId = id;
          document.getElementById("edit-card").style.display = "block";
          document.getElementById("edit-id").textContent = "#" + id;
          document.getElementById("edit-content").value = ENTRIES[id] || "";
        }}
        async function saveEntry() {{
          const resp = await fetch(`/memory/${{editId}}`, {{
            method: "POST", headers: {{"Content-Type": "application/json"}},
            body: JSON.stringify({{content: document.getElementById("edit-content").value}})}});
          document.getElementById("edit-msg").textContent = resp.ok ? "已保存" : "失败";
          if (resp.ok) setTimeout(() => location.reload(), 600);
        }}
        </script>"""
        return page("记忆管理", body, active="/memory")

    @router.post("/memory/{entry_id}")
    async def memory_update(entry_id: int, req: MemoryUpdateRequest):
        if not req.content.strip():
            raise HTTPException(422, "内容不能为空")
        await knowledge_store.update_content(entry_id, req.content)
        return {"status": "ok"}

    return router
