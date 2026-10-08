"""管理页：角色/任务在线编辑 + 重复纠正升舱提示。"""

from __future__ import annotations

import json

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from ...store import feedback as feedback_store
from .base import esc, page


def make_router(defs_store, env: str, langfuse=None) -> APIRouter:
    router = APIRouter()

    @router.get("/admin", response_class=HTMLResponse)
    async def admin_page():
        roles = await defs_store.list_active("role", env)
        tasks = await defs_store.list_active("task", env)
        role_opts = "".join(
            f'<option value="{esc(r["name"])}">{esc(r["name"])}</option>'
            for r in roles)
        task_opts = "".join(
            f'<option value="{esc(t["name"])}">{esc(t["name"])}</option>'
            for t in tasks)
        role_defs = json.dumps({r["name"]: r for r in roles}, ensure_ascii=False)
        task_defs = json.dumps({t["name"]: t for t in tasks}, ensure_ascii=False)

        esc_html = ""
        escalations = await feedback_store.correction_counts(min_count=3)
        if escalations:
            items = "".join(
                f"<li><code>{esc(e['session_id'])}</code> 被纠正 {e['count']} 次"
                f"（最近 {e['last_at'][:10]}）——记忆层反复兜不住，"
                f"建议人工升舱为角色 prompt</li>" for e in escalations)
            esc_html = (f'<div class="card"><b>升舱提示</b>'
                        f"（同一 session 被纠正 ≥3 次）<ul>{items}</ul></div>")

        source = ("Langfuse 为源头" if langfuse is not None and langfuse.enabled
                  else "PG 为源头（Langfuse 未启用）")
        body = f"""
        <h2>管理</h2>{esc_html}
        <div class="card"><b>角色定义</b>（{source}）<br>
          <select id="role-sel" onchange="loadDef('role')"><option value="">新建…</option>{role_opts}</select>
          <input id="role-name" placeholder="角色名">
          <textarea id="role-def" rows="12" style="width:100%" placeholder="角色定义 JSON"></textarea>
          <button onclick="saveDef('role')">保存（新版本，即时生效）</button>
          <span id="role-msg" class="meta"></span></div>
        <div class="card"><b>任务定义</b><br>
          <select id="task-sel" onchange="loadDef('task')"><option value="">新建…</option>{task_opts}</select>
          <input id="task-name" placeholder="任务名">
          <textarea id="task-def" rows="10" style="width:100%" placeholder="任务定义 JSON（含 schedule 可选）"></textarea>
          <button onclick="saveDef('task')">保存</button>
          <span id="task-msg" class="meta"></span></div>
        <div class="card"><b><a href="/memory">记忆管理 →</a></b></div>
        <script>
        const ROLES = {role_defs}, TASKS = {task_defs};
        function loadDef(kind) {{
          const name = document.getElementById(kind+"-sel").value;
          const src = kind === "role" ? ROLES : TASKS;
          document.getElementById(kind+"-name").value = name;
          const d = src[name] || {{}};
          const {{name, ...rest}} = d;
          document.getElementById(kind+"-def").value = JSON.stringify(rest, null, 2);
        }}
        async function saveDef(kind) {{
          const name = document.getElementById(kind+"-name").value.trim();
          const msg = document.getElementById(kind+"-msg");
          try {{
            const definition = JSON.parse(document.getElementById(kind+"-def").value);
            const resp = await fetch(`/v1/admin/${{kind}}s`, {{
              method: "POST", headers: {{"Content-Type": "application/json"}},
              body: JSON.stringify({{name, definition, updated_by: "viewer"}})}});
            const data = await resp.json();
            msg.textContent = resp.ok ? "已保存" : (data.detail || "失败");
            if (resp.ok) setTimeout(() => location.reload(), 800);
          }} catch (e) {{ msg.textContent = "JSON 不合法：" + e; }}
        }}
        </script>"""
        return page("管理", body)

    return router
