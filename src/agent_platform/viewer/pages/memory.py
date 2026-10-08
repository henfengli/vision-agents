"""记忆管理页：知识条目查看/筛选/编辑。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from ...store import knowledge as knowledge_store
from .base import esc, page


class MemoryUpdateRequest(BaseModel):
    content: str


def make_router(env: str) -> APIRouter:
    router = APIRouter()

    @router.get("/memory", response_class=HTMLResponse)
    async def memory_page(domain: str = "", include_inactive: bool = False):
        items = await knowledge_store.list_all(
            env, domain or None, include_inactive=include_inactive)
        rows = "".join(
            f'<tr><td>{esc(i["domain"])}</td><td>{esc(i["key"])}</td>'
            f'<td><pre style="max-width:500px;white-space:pre-wrap">{esc(i["content"][:500])}</pre></td>'
            f'<td>{"🗑已取代" if i["superseded"] else ("⛔已过期" if i["expired"] else "✅")}'
            f' 👍{i["feedback_score"]}</td>'
            f'<td><button onclick="editEntry({i["id"]})">编辑</button></td></tr>'
            for i in items)
        body = f"""
        <h2>记忆管理</h2>
        <div class="card">
          <form method="get"><input name="domain" value="{esc(domain)}" placeholder="域过滤">
          <label><input type="checkbox" name="include_inactive" value="true"
            {"checked" if include_inactive else ""}> 含失效</label>
          <button>筛选</button></form></div>
        <div class="card"><table border="1" cellpadding="6" style="border-collapse:collapse;width:100%">
          <tr><th>域</th><th>key</th><th>内容</th><th>状态</th><th></th></tr>{rows}</table></div>
        <div class="card" id="edit-card" style="display:none">
          <b>编辑条目 <span id="edit-id"></span></b>
          <textarea id="edit-content" rows="8" style="width:100%"></textarea>
          <button onclick="saveEntry()">保存（重新生效）</button>
          <span id="edit-msg" class="meta"></span></div>
        <script>
        let editId = null;
        function editEntry(id) {{
          editId = id;
          document.getElementById("edit-card").style.display = "block";
          document.getElementById("edit-id").textContent = "#" + id;
        }}
        async function saveEntry() {{
          const resp = await fetch(`/memory/${{editId}}`, {{
            method: "POST", headers: {{"Content-Type": "application/json"}},
            body: JSON.stringify({{content: document.getElementById("edit-content").value}})}});
          document.getElementById("edit-msg").textContent = resp.ok ? "已保存" : "失败";
          if (resp.ok) setTimeout(() => location.reload(), 600);
        }}
        </script>"""
        return page("记忆管理", body)

    @router.post("/memory/{entry_id}")
    async def memory_update(entry_id: int, req: MemoryUpdateRequest):
        if not req.content.strip():
            raise HTTPException(422, "内容不能为空")
        await knowledge_store.update_content(entry_id, req.content)
        return {"status": "ok"}

    return router
