/* 记忆页：检索试用 + 条目卡 + 右抽屉明细（编辑/演化链/反馈）+ 矛盾仲裁。
   数据源：window.MEMORY（列表内嵌，内容不内嵌）+ /memory/search.json +
   /memory/{id}/detail.json；写操作：编辑 /memory/{id}、expire、restore。
   （任务资产是独立概念，在 /assets 页。） */
"use strict";

const MEM = window.MEMORY;
const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));

/* —— tab 切换 —— */
document.getElementById("mem-tabs").addEventListener("click", e => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  document.querySelectorAll("#mem-tabs button")
    .forEach(b => b.classList.toggle("on", b === btn));
  document.querySelectorAll(".mem-tab").forEach(t => {
    t.style.display = t.id === "tab-" + btn.dataset.tab ? "" : "none";
  });
});

/* —— 检索试用 —— */
const qInput = document.getElementById("mem-q");
document.getElementById("mem-search-form").addEventListener("submit",
  async e => {
    e.preventDefault();
    const box = document.getElementById("mem-search-results");
    const q = qInput.value.trim();
    if (!q) return;
    box.innerHTML = '<div class="meta">检索中…</div>';
    const resp = await fetch(
      `/memory/search.json?env=${encodeURIComponent(MEM.env)}` +
      `&domain=${encodeURIComponent(MEM.domain)}&q=${encodeURIComponent(q)}`);
    if (!resp.ok) {
      box.innerHTML = `<div class="meta">检索失败：${esc(await resp.text())}</div>`;
      return;
    }
    const data = await resp.json();
    let html = "";
    if (data.block)
      html += '<div class="md-sec">角色实际注入的 prompt 块（recall 全文，'
        + '含档案/知识/案例分层）</div>'
        + `<pre class="mem-block">${esc(data.block)}</pre>`;
    else
      html += '<div class="meta">未命中（角色此时也查不到任何记忆）</div>';
    if (data.hits.length)
      html += '<div class="md-sec">历史知识命中 ' + data.hits.length +
        ' 条（域 ' + esc(data.domain) + '，按召回序；漂移条目已被过滤并标记过期）</div>' +
        data.hits.map((h, i) => `
        <button class="mem-card" data-id="${h.id}">
          <div class="mc-head">
            <span class="meta mono">#${i + 1}</span>
            <span class="ai-name">${esc(h.key)}</span>
            ${h.fresh ? "" : '<span class="pill pill-failed">代码已漂移</span>'}
          </div>
          <pre>${esc(h.content.slice(0, 300))}</pre>
        </button>`).join("");
    box.innerHTML = html;
  });

/* —— 抽屉 —— */
const drawer = document.getElementById("mem-drawer");
const scrim = document.getElementById("mem-scrim");
let curId = null;
let mode = "edit";          // edit / create
let dirty = false;

const $ = id => document.getElementById(id);
$("md-content").addEventListener("input", () => { dirty = true; });
window.addEventListener("beforeunload", e => {
  if (dirty && drawer.classList.contains("open")) e.preventDefault();
});

function pillHtml(e) {
  if (e.superseded || e.valid_to)
    return '<span class="pill pill-failed">已取代</span>';
  if (e.expired) return '<span class="pill pill-queued">已过期</span>';
  return '<span class="pill pill-success"><span class="led"></span>生效中</span>';
}

function openCreate() {
  mode = "create";
  curId = null;
  dirty = false;
  drawer.classList.add("open");
  scrim.classList.add("open");
  $("md-key").textContent = "新增条目";
  $("md-pills").innerHTML = "";
  $("md-meta").innerHTML = "手动写入，立即生效并参与召回";
  $("md-create-fields").style.display = "";
  $("md-hint").style.display = "none";
  $("md-content").value = "";
  $("md-msg").textContent = "";
  $("md-expire").style.display = "none";
  $("md-restore").style.display = "none";
  $("md-save").textContent = "保存（立即生效）";
  $("md-usage-sec").style.display = "none";
  $("md-chain-sec").style.display = "none";
  $("md-feedback-sec").style.display = "none";
}

async function openDrawer(id) {
  mode = "edit";
  curId = id;
  dirty = false;
  drawer.classList.add("open");
  scrim.classList.add("open");
  $("md-create-fields").style.display = "none";
  ["md-usage-sec", "md-chain-sec", "md-feedback-sec"]
    .forEach(s => $(s).style.display = "");
  const resp = await fetch(`/memory/${id}/detail.json`);
  if (!resp.ok) {
    document.getElementById("md-key").textContent = "加载失败";
    return;
  }
  const e = await resp.json();
  document.getElementById("md-key").textContent = `${e.domain} / ${e.key}`;
  let pills = pillHtml(e);
  if (e.code_ref)
    pills += e.fresh
      ? '<span class="pill pill-success">代码一致</span>'
      : '<span class="pill pill-failed">代码已漂移</span>';
  if (e.feedback_score)
    pills += `<span class="meta"> 反馈 ${e.feedback_score > 0 ? "+" : ""}${e.feedback_score}</span>`;
  document.getElementById("md-pills").innerHTML = pills;

  // 负反馈闭环提示：看到 👎 就知道下一步该干嘛
  const hint = $("md-hint");
  if ((e.feedback_score || 0) < 0 && !e.expired && !e.valid_to) {
    hint.style.display = "";
    hint.textContent = "⚠ 该条目反馈为负且仍在参与召回——建议编辑修正内容，"
      + "或直接标记过期止损。";
  } else {
    hint.style.display = "none";
  }

  const meta = [];
  meta.push(`#${e.id} · 生效自 ${TS.span(e.valid_from)}`);
  if (e.valid_to) meta.push(`失效于 ${TS.span(e.valid_to)}`);
  if (e.source_run && e.source_run !== "manual")
    meta.push(`来源 <a href="/runs/${esc(e.source_run)}">run</a>`);
  else if (e.source_run === "manual") meta.push("手动新增");
  if (e.code_ref && e.code_ref.path)
    meta.push(`出处 <span class="mono">${esc(e.code_ref.path)}` +
      (e.code_ref.commit ? `@${esc(String(e.code_ref.commit).slice(0, 7))}` : "") +
      "</span>");
  document.getElementById("md-meta").innerHTML = meta.join(" · ");
  document.getElementById("md-content").value = e.content;
  document.getElementById("md-msg").textContent = "";
  document.getElementById("md-expire").style.display =
    (e.expired || e.valid_to) ? "none" : "";
  document.getElementById("md-restore").style.display =
    (e.expired || e.valid_to) ? "" : "none";
  $("md-save").textContent = "保存（重新生效）";

  const u = e.usage;
  document.getElementById("md-usage").innerHTML =
    (u ? `<div class="meta">近 30 天命中 <b>${u.hits}</b> 次`
       + `（${u.runs} 个不同 run），最后命中 ${TS.span(u.last_hit)}</div>`
       : '<div class="meta">近 30 天零召回——若长期如此，考虑过期或改写</div>')
    + (e.recent_hits.length
       ? e.recent_hits.map(h => `<div class="md-fb meta">
          #${h.rank ?? "-"} ${h.source === "playground" ? "（试用）" : ""}
          ${h.run_id ? `<a href="/runs/${esc(h.run_id)}">run</a>` : "-"}
          · ${TS.span(h.created_at)}</div>`).join("")
       : "");

  document.getElementById("md-chain").innerHTML = e.chain.length > 1
    ? e.chain.map(c => `
      <div class="ver-row${c.current ? " sel" : ""}${c.id !== e.id ? " md-chain-jump" : ""}"
           ${c.id !== e.id ? `data-id="${c.id}"` : ""}>
        <span class="ver-cur mono">${esc(c.key)}</span>
        ${c.superseded ? '<span class="pill pill-failed">已取代</span>'
          : c.expired ? '<span class="pill pill-queued">已过期</span>'
          : '<span class="pill pill-success">生效中</span>'}
        ${c.current ? '<span class="ver-cur">当前查看</span>' : ""}
        <span class="meta">${TS.span(c.created_at)}</span>
      </div>`).join("")
    : '<div class="meta">无演化链——同 key 的修改是原地覆盖不留历史；'
      + '仅「新 key 取代旧 key」才形成链</div>';

  document.getElementById("md-feedback").innerHTML = e.feedback.length
    ? e.feedback.map(f => `
      <div class="md-fb meta">
        ${f.kind === "step" ? `步骤#${f.step_seq} ` : ""}
        ${f.score === 1 ? "👍" : f.score === -1 ? "👎" : "·"}
        ${f.comment ? " " + esc(f.comment) : ""}
        <span> · ${TS.span(f.created_at)}</span>
      </div>`).join("")
    : '<div class="meta">来源 run 尚无反馈留痕</div>';
}

function closeDrawer() {
  if (dirty && !confirm("有未保存的修改，确定关闭？")) return;
  drawer.classList.remove("open");
  scrim.classList.remove("open");
  curId = null;
  dirty = false;
}

document.getElementById("md-close").addEventListener("click", closeDrawer);
scrim.addEventListener("click", closeDrawer);
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeDrawer();
});
document.getElementById("mem-add").addEventListener("click", openCreate);

document.addEventListener("click", async e => {
  const card = e.target.closest(".mem-card");
  if (card) { openDrawer(card.dataset.id); return; }
  const jump = e.target.closest(".md-chain-jump");
  if (jump) { openDrawer(jump.dataset.id); return; }
  const openBtn = e.target.closest("[data-open]");
  if (openBtn) { openDrawer(openBtn.dataset.open); return; }
  const keep = e.target.closest("[data-keep]");
  if (keep) {  // 矛盾仲裁：保留一条 = 另一条标记过期
    if (!confirm(`保留 #${keep.dataset.keep}，把 #${keep.dataset.drop} 标记过期？`))
      return;
    const resp = await fetch(`/memory/${keep.dataset.drop}/expire`,
                             {method: "POST"});
    if (resp.ok) location.reload(); else alert("操作失败");
  }
});

async function post(url, body) {
  dirty = false;
  const resp = await fetch(url, {
    method: "POST",
    headers: body ? {"Content-Type": "application/json"} : {},
    body: body ? JSON.stringify(body) : undefined});
  document.getElementById("md-msg").textContent = resp.ok ? "已保存" : "失败";
  if (resp.ok) setTimeout(() => location.reload(), 600);
}
document.getElementById("md-save").addEventListener("click", () => {
  if (mode === "create") {
    post(`/memory/entries?env=${encodeURIComponent(MEM.env)}`, {
      domain: document.getElementById("md-domain").value,
      key: document.getElementById("md-new-key").value,
      content: document.getElementById("md-content").value});
    return;
  }
  post(`/memory/${curId}`,
       {content: document.getElementById("md-content").value});
});
document.getElementById("md-expire").addEventListener("click",
  () => post(`/memory/${curId}/expire`));
document.getElementById("md-restore").addEventListener("click",
  () => post(`/memory/${curId}/restore`));
