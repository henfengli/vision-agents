/* 服务详情页：规则库编辑（保存走 /v1/admin/rules，即新版本热生效）
   + 版本时间线（/admin/defs/rules/*\/history.json）+ 同页 diff
   （/admin/diff?format=json）。数据源：window.SVC（页面内嵌）。 */
"use strict";

const SVC = window.SVC;
const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));

document.getElementById("svc-rules-save").addEventListener("click", async () => {
  const msg = document.getElementById("svc-rules-msg");
  let rules;
  try {
    const raw = document.getElementById("svc-rules").value.trim();
    rules = raw ? JSON.parse(raw) : [];
  } catch (e) { msg.textContent = "JSON 不合法：" + e.message; return; }
  try {
    const resp = await fetch("/v1/admin/rules", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({name: SVC.name, definition: {rules},
                            updated_by: "viewer"})});
    const data = await resp.json();
    if (!resp.ok) { msg.textContent = data.detail || "保存失败"; return; }
    msg.textContent = `已保存（v${data.version}）`;
    setTimeout(() => location.reload(), 1200);
  } catch (e) { msg.textContent = "网络错误：" + e.message; }
});

async function loadVersions() {
  const list = document.getElementById("svc-ver-list");
  if (!list) return;  // 规则库尚未创建时无时间线
  const resp = await fetch(
    `/admin/defs/rules/${encodeURIComponent(SVC.name)}/history.json`);
  if (!resp.ok) { list.textContent = "版本历史加载失败"; return; }
  const {history} = await resp.json();
  const sel = new Set();
  list.className = "";
  list.innerHTML = history.map((h, i) => `
    <div class="ver-row" data-v="${h.version}">
      <span class="tag">v${h.version}</span>${i === 0 ? ' <span class="ver-cur">当前</span>' : ""}
      <span class="meta">${esc(h.updated_by || "?")} · ${TS.span(h.created_at)}</span>
    </div>`).join("");
  list.querySelectorAll(".ver-row").forEach(row => {
    row.addEventListener("click", async () => {
      const v = Number(row.dataset.v);
      if (sel.has(v)) { sel.delete(v); row.classList.remove("sel"); }
      else if (sel.size < 2) { sel.add(v); row.classList.add("sel"); }
      if (sel.size === 2) await showDiff(...[...sel].sort((x, y) => x - y));
      else document.getElementById("svc-diff").innerHTML = "";
    });
  });
}

async function showDiff(a, b) {
  const box = document.getElementById("svc-diff");
  box.innerHTML = '<div class="meta">diff 加载中…</div>';
  const resp = await fetch(
    `/admin/diff?kind=rules&name=${encodeURIComponent(SVC.name)}&a=${a}&b=${b}&format=json`);
  const {diff} = await resp.json();
  box.innerHTML = `<pre class="diff-view">${
    (diff || "（两版内容一致）").split("\n").map(l => {
      const cls = l.startsWith("+") ? "d-add" : l.startsWith("-") ? "d-del"
        : l.startsWith("@") ? "d-hunk" : "";
      return `<span class="${cls}">${esc(l)}</span>`;
    }).join("\n")}</pre>`;
}

loadVersions();
