/* 管理页：列表 + 结构化编辑器 + 版本时间线 + 同页 diff。
   已知字段结构化表单编辑；未识别字段（interrupt_on/artifacts/未来新增）
   落「高级 JSON」原样保留——表单永远不会悄悄丢字段。
   数据源：window.ADMIN（页面内嵌）+ /admin/defs/*\/history.json +
   /admin/diff?format=json；保存走 /v1/admin/* 既有 API（cookie 鉴权）。 */
"use strict";

const D = window.ADMIN;
const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));

const KIND_LABEL = {role: "角色", task: "任务", policy: "策略"};
const SAVE_URL = {role: "/v1/admin/roles", task: "/v1/admin/tasks",
                  policy: "/v1/admin/policies"};

/* 表单 schema：kind → 字段描述列表。type: text/number/textarea/json/
   comma/checks/select/bool。lift 进表单的键不会出现在高级 JSON 里。 */
const FORMS = {
  role: [
    {k: "description", label: "描述", type: "text"},
    {k: "prompt", label: "Prompt（纯文本，所见即所发）", type: "textarea",
     rows: 14, mono: true},
    {k: "tools", label: "工具", type: "checks", options: () => D.toolNames},
    {k: "domains", label: "可见域", type: "checks", options: () => D.domains},
    {k: "extends", label: "继承自（子角色只能收敛）", type: "select",
     options: () => D.roleNames, empty: "（不继承）"},
    {k: "prompt_append", label: "追加 Prompt（extends 时拼接在父级后）",
     type: "textarea", rows: 3, mono: true},
  ],
  task: [
    {k: "extends", label: "父任务", type: "select",
     options: () => D.taskNames.filter(n => n !== cur.name && !n.includes(":")),
     empty: "（不继承，通用任务）",
     help: "选了父任务就是子任务：上面名称只填对象名，其余字段继承父任务"},
    {k: "context", label: "任务档案", type: "json", rows: 6,
     help: '这个对象的一手事实，逐字注入 prompt 最前。例：{"owner": "张三", "code_refs": ["repo://…/job.py"], "pitfalls": ["02 点锁表属正常，重跑即可"], "upstream": ["ods_x"], "runbook": "先查分区再查上游"}'},
    {k: "role", label: "角色", type: "select",
     options: () => D.roleNames, empty: "（无 / artifacts 任务）"},
    {k: "triggers", label: "触发源（逗号分隔）", type: "comma"},
    {k: "input_schema", label: "输入 schema（{\"字段\": \"类型\"}）",
     type: "json", rows: 3},
    {k: "output_channel", label: "输出通道", type: "select",
     options: () => ["caller", "dingtalk", "http"]},
    {k: "output_callback", label: "回调地址（channel=http）", type: "text"},
    {k: "dedup_key", label: "去重键（input 字段，a+b 可拼接）", type: "text"},
    {k: "dedup_window_s", label: "去重窗口（秒）", type: "number"},
    {k: "timeout_s", label: "超时（秒）", type: "number"},
    {k: "schedule", label: "定时（cron，可选）", type: "text"},
    {k: "schedule_input", label: "定时固定输入（JSON，可选）",
     type: "json", rows: 2},
    {k: "env_gate", label: "启用环境（空 = 全部）", type: "checks",
     options: () => D.envs},
  ],
  policy: [
    {k: "match_regex", label: "命中正则（作用于 任务名+输入+question）",
     type: "text", mono: true},
    {k: "action", label: "动作", type: "select",
     options: () => ["deny", "require_approval"]},
    {k: "message", label: "理由（给调用方/审批人看）", type: "text"},
    {k: "order", label: "顺序（小的先判）", type: "number"},
    {k: "applies_to", label: "适用任务（逗号分隔，空 = 全部）", type: "comma"},
    {k: "envs", label: "适用环境（空 = 全部）", type: "checks",
     options: () => D.envs},
    {k: "enabled", label: "启用", type: "bool"},
  ],
};

let cur = {kind: "role", name: "", dirty: false};

/* —— 表单渲染 —— */

function fieldHtml(f, val) {
  const id = `f-${f.k}`;
  const help = f.help ? `<div class="af-help">${esc(f.help)}</div>` : "";
  if (f.type === "textarea" || f.type === "json") {
    const text = f.type === "json"
      ? (val && Object.keys(val).length ? JSON.stringify(val, null, 2) : "")
      : (val ?? "");
    return `<label class="af-label" for="${id}">${f.label}</label>
      <textarea id="${id}" data-k="${f.k}" data-t="${f.type}"
        class="${f.mono || f.type === "json" ? "mono" : ""}"
        rows="${f.rows || 4}" spellcheck="false">${esc(text)}</textarea>${help}`;
  }
  if (f.type === "checks") {
    const cur_ = new Set(val || []);
    // 当前值里出现但目录里没有的选项（如已下线工具）照样渲染，防静默丢
    const opts = [...new Set([...f.options(), ...cur_])];
    return `<div class="af-label">${f.label}</div>
      <div class="af-checks" data-k="${f.k}" data-t="checks">
        ${opts.map(o => `<label class="af-check">
          <input type="checkbox" value="${esc(o)}"${cur_.has(o) ? " checked" : ""}>
          ${esc(o)}</label>`).join("")}</div>${help}`;
  }
  if (f.type === "select") {
    const opts = f.options();
    return `<label class="af-label" for="${id}">${f.label}</label>
      <select id="${id}" data-k="${f.k}" data-t="select">
        ${f.empty !== undefined ? `<option value="">${f.empty}</option>` : ""}
        ${opts.map(o => `<option value="${esc(o)}"${o === val ? " selected" : ""}>
          ${esc(o)}</option>`).join("")}</select>${help}`;
  }
  if (f.type === "bool")
    return `<label class="af-check af-bool">
      <input type="checkbox" id="${id}" data-k="${f.k}" data-t="bool"
        ${val !== false ? " checked" : ""}> ${f.label}</label>`;
  const v = f.type === "comma" ? (val || []).join(", ") : (val ?? "");
  return `<label class="af-label" for="${id}">${f.label}</label>
    <input id="${id}" data-k="${f.k}" data-t="${f.type}"
      class="${f.mono ? "mono" : ""}" type="${f.type === "number" ? "number" : "text"}"
      value="${esc(v)}" spellcheck="false">`;
}

function renderEditor(kind, name) {
  const main = document.getElementById("admin-main");
  const def = name ? (D.defs[kind][name] || {}) : {};
  const fields = FORMS[kind];
  const known = new Set(fields.map(f => f.k));
  // 未识别字段 → 高级 JSON（原样保留，保存时合并回去）
  const extra = Object.fromEntries(
    Object.entries(def).filter(([k]) =>
      !known.has(k) && !["name", "version", "updated_by", "created_at",
                         "usage"].includes(k)));
  const usage = def.usage;
  const impact = usage
    ? `近 24h：${usage.runs} 个 run · 成功率 ${Math.round(usage.ok / usage.runs * 100)}%`
    : (name ? "近 24h 无 run 使用" : "");
  main.innerHTML = `
    <div class="af-head">
      <h3>${name ? esc(name) : `新建${KIND_LABEL[kind]}`}
        ${name ? `<span class="tag">v${def.version}</span>` : ""}</h3>
      <div class="meta">${impact}${kind === "role" ? ` · ${esc(D.source)}` : ""}</div>
    </div>
    <div class="af-field"><label class="af-label" for="f-name" id="f-name-label">名称</label>
      <input id="f-name" value="${esc(name)}" ${name ? "disabled" : ""}
        spellcheck="false" class="mono">
      <div class="af-help" id="f-name-help" hidden>子任务：输入对象名（如表名 dwd_trade_order），保存时自动拼为 父任务:对象名。调用方输入里出现该对象名即自动命中本任务</div></div>
    ${fields.map(f => `<div class="af-field">${fieldHtml(f, def[f.k])}</div>`).join("")}
    <details class="af-extra" ${Object.keys(extra).length ? "open" : ""}>
      <summary>高级 JSON（未识别字段，原样保留合并）</summary>
      <textarea id="f-extra" class="mono" rows="4" spellcheck="false"
        >${esc(Object.keys(extra).length ? JSON.stringify(extra, null, 2) : "")}</textarea>
    </details>
    <div class="af-actions">
      <button id="af-save">${name ? "保存（新版本，即时生效）" : "创建"}</button>
      <span id="af-msg" class="meta"></span>
    </div>
    ${name && kind !== "policy" ? `<div class="af-vers">
      <div class="af-label">版本时间线（点选两个版本对比）</div>
      <div id="af-ver-list" class="meta">加载中…</div>
      <div id="af-diff"></div></div>` : ""}`;
  document.getElementById("af-save").onclick = () => save(kind);
  main.querySelectorAll("input,textarea,select").forEach(el =>
    el.addEventListener("input", () => { cur.dirty = true; }));
  if (kind === "task") wireSubTaskName(name);
  if (name && kind !== "policy") loadVersions(kind, name);
}

/* —— 子任务名称联动：选父任务后名称只填对象名，前缀自动拼 —— */

function wireSubTaskName(name) {
  const extEl = document.querySelector('[data-k="extends"]');
  const nameEl = document.getElementById("f-name");
  const help = document.getElementById("f-name-help");
  const label = document.getElementById("f-name-label");
  if (!extEl) return;
  const sync = () => {
    const parent = extEl.value;
    help.hidden = !parent;
    label.textContent = parent ? "对象名" : "名称";
    if (!parent) return;
    // 显示态去掉前缀（存量编辑也保持只显示对象名），保存时统一拼回
    if (nameEl.value.startsWith(parent + ":"))
      nameEl.value = nameEl.value.slice(parent.length + 1);
  };
  extEl.addEventListener("change", sync);
  sync();
}

/* —— 值收集（表单 + 高级 JSON 合并） —— */

function collect(kind) {
  let def = {};
  const extraRaw = document.getElementById("f-extra").value.trim();
  if (extraRaw) def = JSON.parse(extraRaw);  // 语法错误抛给调用方提示
  for (const f of FORMS[kind]) {
    const el = document.querySelector(`[data-k="${f.k}"]`);
    if (!el) continue;
    if (f.type === "checks")
      def[f.k] = [...el.querySelectorAll("input:checked")].map(i => i.value);
    else if (f.type === "comma")
      def[f.k] = el.value.split(",").map(s => s.trim()).filter(Boolean);
    else if (f.type === "number")
      def[f.k] = el.value === "" ? undefined : Number(el.value);
    else if (f.type === "bool")
      def[f.k] = el.checked;
    else if (f.type === "json")
      def[f.k] = el.value.trim() ? JSON.parse(el.value) : undefined;
    else if (f.type === "select")
      def[f.k] = el.value || undefined;
    else
      def[f.k] = el.value;
    if (def[f.k] === undefined) delete def[f.k];  // 空值不写，走服务端默认
  }
  return def;
}

async function save(kind) {
  const msg = document.getElementById("af-msg");
  let name = document.getElementById("f-name").value.trim();
  if (kind === "task") {
    const parent = document.querySelector('[data-k="extends"]')?.value || "";
    if (parent && !name.startsWith(parent + ":")) name = parent + ":" + name;
  }
  if (!name) { msg.textContent = "名称必填"; return; }
  let definition;
  try { definition = collect(kind); }
  catch (e) { msg.textContent = "JSON 不合法：" + e.message; return; }
  try {
    const resp = await fetch(SAVE_URL[kind], {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({name, definition, updated_by: "viewer"})});
    const data = await resp.json();
    if (!resp.ok) { msg.textContent = data.detail || "保存失败"; return; }
    let text = `已保存（v${data.version || "?"}）`;
    if (data.recent_runs_on_previous)
      text += `；注意：近 24h 有 ${data.recent_runs_on_previous} 个 run 用的是 v${data.previous_version}`;
    msg.textContent = text;
    cur.dirty = false;
    setTimeout(() => location.reload(), 1200);
  } catch (e) { msg.textContent = "网络错误：" + e.message; }
}

/* —— 版本时间线 + 同页 diff —— */

async function loadVersions(kind, name) {
  const list = document.getElementById("af-ver-list");
  const resp = await fetch(`/admin/defs/${kind}/${encodeURIComponent(name)}/history.json`);
  const {history} = await resp.json();
  const sel = new Set();
  list.className = "";
  list.innerHTML = history.map((h, i) => `
    <div class="ver-row" data-v="${h.version}">
      <span class="tag">v${h.version}</span>${i === 0 ? ' <span class="ver-cur">当前</span>' : ""}
      <span class="meta">${esc(h.updated_by || "?")} · ${TS.span(h.created_at)}</span>
      ${kind === "role" && i > 0
        ? `<button class="inline ver-rb" data-v="${h.version}">回滚到此版</button>` : ""}
    </div>`).join("");
  list.querySelectorAll(".ver-row").forEach(row => {
    row.addEventListener("click", async e => {
      if (e.target.closest(".ver-rb")) return;
      const v = Number(row.dataset.v);
      if (sel.has(v)) { sel.delete(v); row.classList.remove("sel"); }
      else if (sel.size < 2) { sel.add(v); row.classList.add("sel"); }
      if (sel.size === 2) await showDiff(kind, name, ...[...sel].sort((x, y) => x - y));
      else document.getElementById("af-diff").innerHTML = "";
    });
  });
  list.querySelectorAll(".ver-rb").forEach(btn =>
    btn.addEventListener("click", async () => {
      if (!confirm(`回滚 ${name} 到 v${btn.dataset.v}？（产生一个新版本）`)) return;
      const r = await fetch(
        `/v1/admin/roles/${encodeURIComponent(name)}/rollback/${btn.dataset.v}`,
        {method: "POST"});
      if (r.ok) location.reload();
    }));
}

async function showDiff(kind, name, a, b) {
  const box = document.getElementById("af-diff");
  box.innerHTML = '<div class="meta">diff 加载中…</div>';
  const resp = await fetch(
    `/admin/diff?kind=${kind}&name=${encodeURIComponent(name)}&a=${a}&b=${b}&format=json`);
  const {diff} = await resp.json();
  box.innerHTML = `<pre class="diff-view">${
    (diff || "（两版内容一致）").split("\n").map(l => {
      const cls = l.startsWith("+") ? "d-add" : l.startsWith("-") ? "d-del"
        : l.startsWith("@") ? "d-hunk" : "";
      return `<span class="${cls}">${esc(l)}</span>`;
    }).join("\n")}</pre>`;
}

/* —— 列表交互 —— */

// 名称即时过滤：本地定位器（不进 URL——这不是可分享的视图状态）
document.getElementById("admin-q").addEventListener("input", e => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll(".admin-item").forEach(btn => {
    btn.style.display =
      !q || btn.dataset.name.toLowerCase().includes(q) ? "" : "none";
  });
});

document.getElementById("admin-tabs").addEventListener("click", e => {
  const btn = e.target.closest("button[data-kind]");
  if (!btn) return;
  document.querySelectorAll("#admin-tabs button").forEach(b =>
    b.classList.toggle("on", b === btn));
  document.querySelectorAll(".admin-items").forEach(el =>
    el.hidden = el.dataset.kind !== btn.dataset.kind);
  cur.kind = btn.dataset.kind;
});

document.querySelectorAll(".admin-item").forEach(btn =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".admin-item").forEach(b =>
      b.classList.toggle("sel", b === btn));
    cur.name = btn.dataset.name;
    cur.dirty = false;
    renderEditor(cur.kind, cur.name);
  }));

document.getElementById("admin-new").addEventListener("click", () => {
  document.querySelectorAll(".admin-item").forEach(b => b.classList.remove("sel"));
  cur.name = "";
  cur.dirty = false;
  renderEditor(cur.kind, "");
});

window.addEventListener("beforeunload", e => {
  if (cur.dirty) { e.preventDefault(); e.returnValue = ""; }
});
