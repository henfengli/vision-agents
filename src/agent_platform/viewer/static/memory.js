/* 记忆页：检索试用 + 条目卡 + 右抽屉明细（编辑/演化链/反馈）+ 矛盾仲裁。
   数据源：window.MEMORY（列表内嵌，内容不内嵌）+ /memory/search.json +
   /memory/{id}/detail.json；写操作：编辑 /memory/{id}、expire、restore。 */
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
    if (!data.hits.length) {
      box.innerHTML = '<div class="meta">未命中（角色此时也查不到任何记忆）</div>';
      return;
    }
    box.innerHTML = '<div class="md-sec">命中 ' + data.hits.length +
      ' 条（域 ' + esc(data.domain) + '，按召回序）</div>' +
      data.hits.map((h, i) => `
        <button class="mem-card" data-id="${h.id}">
          <div class="mc-head">
            <span class="meta mono">#${i + 1}</span>
            <span class="ai-name">${esc(h.key)}</span>
            ${h.fresh ? "" : '<span class="pill pill-failed">代码已漂移</span>'}
          </div>
          <pre>${esc(h.content.slice(0, 300))}</pre>
        </button>`).join("");
  });

/* —— 抽屉 —— */
const drawer = document.getElementById("mem-drawer");
const scrim = document.getElementById("mem-scrim");
let curId = null;

function pillHtml(e) {
  if (e.superseded || e.valid_to)
    return '<span class="pill pill-failed">已取代</span>';
  if (e.expired) return '<span class="pill pill-queued">已过期</span>';
  return '<span class="pill pill-success"><span class="led"></span>生效中</span>';
}

async function openDrawer(id) {
  curId = id;
  drawer.classList.add("open");
  scrim.classList.add("open");
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

  const meta = [];
  meta.push(`#${e.id} · 生效自 ${esc((e.valid_from || "").slice(0, 16))}`);
  if (e.valid_to) meta.push(`失效于 ${esc(e.valid_to.slice(0, 16))}`);
  if (e.source_run)
    meta.push(`来源 <a href="/runs/${esc(e.source_run)}">run</a>`);
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

  document.getElementById("md-chain").innerHTML = e.chain.length > 1
    ? e.chain.map(c => `
      <div class="ver-row${c.current ? " sel" : ""}${c.id !== e.id ? " md-chain-jump" : ""}"
           ${c.id !== e.id ? `data-id="${c.id}"` : ""}>
        <span class="ver-cur mono">${esc(c.key)}</span>
        ${c.superseded ? '<span class="pill pill-failed">已取代</span>'
          : c.expired ? '<span class="pill pill-queued">已过期</span>'
          : '<span class="pill pill-success">生效中</span>'}
        ${c.current ? '<span class="ver-cur">当前查看</span>' : ""}
        <span class="meta">${esc((c.created_at || "").slice(0, 10))}</span>
      </div>`).join("")
    : '<div class="meta">无演化历史（从未被取代）</div>';

  document.getElementById("md-feedback").innerHTML = e.feedback.length
    ? e.feedback.map(f => `
      <div class="md-fb meta">
        ${f.kind === "step" ? `步骤#${f.step_seq} ` : ""}
        ${f.score === 1 ? "👍" : f.score === -1 ? "👎" : "·"}
        ${f.comment ? " " + esc(f.comment) : ""}
        <span> · ${esc((f.created_at || "").slice(0, 16))}</span>
      </div>`).join("")
    : '<div class="meta">来源 run 尚无反馈留痕</div>';
}

function closeDrawer() {
  drawer.classList.remove("open");
  scrim.classList.remove("open");
  curId = null;
}

document.getElementById("md-close").addEventListener("click", closeDrawer);
scrim.addEventListener("click", closeDrawer);
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeDrawer();
});

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
  const resp = await fetch(url, {
    method: "POST",
    headers: body ? {"Content-Type": "application/json"} : {},
    body: body ? JSON.stringify(body) : undefined});
  document.getElementById("md-msg").textContent = resp.ok ? "已保存" : "失败";
  if (resp.ok) setTimeout(() => location.reload(), 600);
}
document.getElementById("md-save").addEventListener("click",
  () => post(`/memory/${curId}`,
             {content: document.getElementById("md-content").value}));
document.getElementById("md-expire").addEventListener("click",
  () => post(`/memory/${curId}/expire`));
document.getElementById("md-restore").addEventListener("click",
  () => post(`/memory/${curId}/restore`));
