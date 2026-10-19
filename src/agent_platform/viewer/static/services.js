/* 服务页交互（三段，按页面上存在的元素自动启用）：
   1) /services       —— 环境启停开关（/v1/admin/envs）
   2) /services/new   —— 新建服务（/v1/admin/domains）
   3) /services/{name}—— 服务配置编辑/启停（/v1/admin/domains）+
      入站分流规则编辑（/v1/admin/rules）+ 版本时间线/diff
      （/admin/defs、/admin/diff 既有读回端点） */
"use strict";

const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));

async function post(url, body) {
  const resp = await fetch(url, {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body)});
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.detail || "保存失败");
  return data;
}

function parseJsonField(id, fallback) {
  const raw = document.getElementById(id).value.trim();
  return raw ? JSON.parse(raw) : fallback;
}

/* —— 1) 环境启停（/services） —— */

document.querySelectorAll(".svc-env-toggle").forEach(btn =>
  btn.addEventListener("click", async () => {
    const env = btn.dataset.env;
    const turningOn = btn.dataset.on !== "1";
    const msg = document.querySelector(`.svc-env-msg[data-env="${env}"]`);
    try {
      await post("/v1/admin/envs",
        {name: env, definition: {enabled: turningOn}, updated_by: "viewer"});
      location.reload();
    } catch (e) { msg.textContent = e.message; }
  }));

/* —— 2) 新建服务（/services/new） —— */

const createBtn = document.getElementById("svc-create");
if (createBtn) createBtn.addEventListener("click", async () => {
  const msg = document.getElementById("svc-msg");
  const name = document.getElementById("svc-name").value.trim();
  if (!name) { msg.textContent = "服务名必填"; return; }
  try {
    const definition = {
      code_paths: parseJsonField("svc-code-paths", []),
      hosts: parseJsonField("svc-hosts", []),
      readonly_dsn:
        document.getElementById("svc-readonly-dsn").value.trim() || null,
      session_template:
        document.getElementById("svc-session-template").value.trim() || null,
      envs: parseJsonField("svc-envs", {}),
      profile: parseJsonField("svc-profile", {}),
    };
    await post("/v1/admin/domains", {name, definition, updated_by: "viewer"});
    msg.textContent = "已创建，跳转中…";
    setTimeout(() => location.href = `/services/${encodeURIComponent(name)}`,
               800);
  } catch (e) { msg.textContent = e.message; }
});

/* —— 3) 服务详情（/services/{name}） —— */

const SVC = window.SVC;

const cfgSave = document.getElementById("cfg-save");
if (cfgSave) {
  const collectCfg = () => ({
    code_paths: parseJsonField("cfg-code-paths", []),
    hosts: parseJsonField("cfg-hosts", []),
    readonly_dsn:
      document.getElementById("cfg-readonly-dsn").value.trim() || null,
    session_template:
      document.getElementById("cfg-session-template").value.trim() || null,
    envs: parseJsonField("cfg-envs", {}),
    profile: parseJsonField("cfg-profile", {}),
    seed_tasks: SVC.seedTasks || [],
    enabled: SVC.enabled,
  });

  cfgSave.addEventListener("click", async () => {
    const msg = document.getElementById("cfg-msg");
    try {
      const d = await post("/v1/admin/domains",
        {name: SVC.name, definition: collectCfg(), updated_by: "viewer"});
      msg.textContent = `已保存（v${d.version}，热生效）`;
      setTimeout(() => location.reload(), 1200);
    } catch (e) { msg.textContent = e.message; }
  });

  document.getElementById("cfg-toggle").addEventListener("click", async () => {
    const action = SVC.enabled ? "停用" : "启用";
    if (!confirm(`${action}服务 ${SVC.name}？${SVC.enabled
      ? "停用后拒收新任务/webhook 并暂停调度" : ""}`)) return;
    const msg = document.getElementById("cfg-msg");
    try {
      await post("/v1/admin/domains", {name: SVC.name,
        definition: {...collectCfg(), enabled: !SVC.enabled},
        updated_by: "viewer"});
      msg.textContent = `已${action}`;
      setTimeout(() => location.reload(), 800);
    } catch (e) { msg.textContent = e.message; }
  });
}

const rulesSave = document.getElementById("svc-rules-save");
if (rulesSave) rulesSave.addEventListener("click", async () => {
  const msg = document.getElementById("svc-rules-msg");
  let rules;
  try {
    const raw = document.getElementById("svc-rules").value.trim();
    rules = raw ? JSON.parse(raw) : [];
  } catch (e) { msg.textContent = "JSON 不合法：" + e.message; return; }
  try {
    const d = await post("/v1/admin/rules",
      {name: SVC.name, definition: {rules}, updated_by: "viewer"});
    msg.textContent = `已保存（v${d.version}）`;
    setTimeout(() => location.reload(), 1200);
  } catch (e) { msg.textContent = e.message; }
});

/* —— 入站分流规则版本时间线 + diff —— */

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

if (SVC) loadVersions();
