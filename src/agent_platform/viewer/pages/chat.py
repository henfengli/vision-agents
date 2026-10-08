"""Web 对话页：SSE 流式。"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from .base import page

_CHAT_HTML = """
<h2>Agent 对话</h2>
<div class="card">
  <select id="server">__SERVER_OPTIONS__</select>
  <input id="role" value="data_searcher" placeholder="角色">
  <input id="session" placeholder="session_id（留空自动新建）">
</div>
<div id="log"></div>
<div class="card">
  <input id="q" placeholder="输入问题，回车发送">
</div>
<script>
let sessionId = "";
const log = document.getElementById("log");
const esc = (t) => String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;");
const step = (cls, label, text) =>
  log.innerHTML += `<div class="step step-${cls}"><div class="meta">${label}</div><pre>${esc(text)}</pre></div>`;

document.getElementById("q").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  const q = e.target.value; e.target.value = "";
  log.innerHTML += `<div class="card"><b>我：</b><pre>${esc(q)}</pre></div>`;
  const resp = await fetch("/v1/chat/stream", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({server: document.getElementById("server").value,
      role: document.getElementById("role").value, question: q,
      session_id: sessionId || null})});
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    buf += decoder.decode(value, {stream: true});
    const parts = buf.split("\\n\\n"); buf = parts.pop();
    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      const ev = JSON.parse(part.slice(6));
      if (ev.type === "run") {
        sessionId = ev.session_id;
        document.getElementById("session").value = sessionId;
        step("note", "ℹ️ run", `<a href="/runs/${ev.run_id}">${ev.run_id}</a>`);
      } else if (ev.type === "thought") step("thought", "💭 思考", ev.content);
      else if (ev.type === "tool_call") step("tool_call", "🔧 " + ev.tool, ev.args);
      else if (ev.type === "tool_result") step("tool_result", "📄 " + ev.tool, ev.output);
      else if (ev.type === "final") step("final", "✅ 完成", JSON.stringify(ev.output));
    }
  }
});
</script>
"""


def make_router(domains: list[str] | None = None) -> APIRouter:
    """domains 来自配置（settings.domains），业务域不在页面里硬编码。"""
    router = APIRouter()
    options = "".join(f'<option value="{d}">{d}</option>' for d in (domains or []))

    @router.get("/chat", response_class=HTMLResponse)
    async def chat_page():
        return page("对话", _CHAT_HTML.replace("__SERVER_OPTIONS__", options))

    return router
