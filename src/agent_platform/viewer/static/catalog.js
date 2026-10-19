/* 资产目录页：行点击 → 抽屉（档案 + 最近 run）；编辑/新建同一表单 */
const drawer = document.getElementById("cat-drawer");
const scrim = document.getElementById("cat-scrim");
const view = document.getElementById("cd-view");
const form = document.getElementById("cd-form");
const delForm = document.getElementById("cd-del");

const esc = s => String(s ?? "").replace(/[&<>"]/g, c =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));

function open() { drawer.classList.add("open"); scrim.classList.add("open"); }
function close() { drawer.classList.remove("open"); scrim.classList.remove("open"); }
scrim.onclick = close;
document.getElementById("cd-close").onclick = close;

function showForm(e) {
  view.hidden = true; delForm.hidden = true; form.hidden = false;
  document.getElementById("cd-edit").style.display = "none";
  document.getElementById("cf-env").value = e?.env || CUR_ENV;
  document.getElementById("cf-domain").value = e?.domain || CUR_DOMAIN;
  document.getElementById("cf-key").value = e?.asset_key || "";
  document.getElementById("cf-key").readOnly = !!e;
  document.getElementById("cf-domain").readOnly = !!e;
  document.getElementById("cf-name").value = e?.name || "";
  document.getElementById("cf-owner").value = e?.owner || "";
  document.getElementById("cf-tier").value = e?.tier || "";
  document.getElementById("cf-upstream").value = (e?.upstream || []).join(", ");
  document.getElementById("cf-downstream").value = (e?.downstream || []).join(", ");
  document.getElementById("cf-code").value = (e?.code_refs || []).join(", ");
  document.getElementById("cf-tags").value = (e?.tags || []).join(", ");
  document.getElementById("cf-runbook").value = e?.runbook || "";
}

async function openEntry(id) {
  const r = await fetch(`/catalog/${id}.json`);
  if (!r.ok) return;
  const {entry, recent_runs} = await r.json();
  document.getElementById("cd-title").textContent = entry.asset_key;
  const tier = {"": "未分级", core: "核心", important: "重要",
                normal: "普通"}[entry.tier] || entry.tier;
  document.getElementById("cd-meta").innerHTML =
    [entry.domain, entry.owner && `负责人 ${esc(entry.owner)}`, tier,
     entry.upstream.length && `上游：${esc(entry.upstream.join("、"))}`,
     entry.downstream.length && `下游：${esc(entry.downstream.join("、"))}`,
     entry.code_refs.length && `代码：${esc(entry.code_refs.join("、"))}`,
     entry.tags.length && `标签：${esc(entry.tags.join("、"))}`]
      .filter(Boolean).join(" · ");
  document.getElementById("cd-runbook").textContent =
    entry.runbook || "（未填写——补上坑/口径/SOP 后，涉及本资产的 run 会自动挂载）";
  document.getElementById("cd-runs").innerHTML = recent_runs.length
    ? recent_runs.map(r =>
        `<div style="margin:4px 0"><a href="/runs/${r.run_id}"><code>${r.run_id.slice(0, 8)}</code></a>
         <span class="pill pill-${r.status}">${r.status}</span>
         <span class="meta">${r.task_type} · ${(r.created_at || "").slice(0, 16).replace("T", " ")}</span></div>`).join("")
      + `<div style="margin-top:6px"><a href="/runs?q=${encodeURIComponent(entry.asset_key)}">全部 run →</a></div>`
    : '<div class="meta">近 30 天无 run</div>';
  view.hidden = false; form.hidden = true;
  document.getElementById("cd-edit").style.display = "";
  delForm.hidden = false;
  delForm.action = `/catalog/${entry.id}/delete`;
  document.getElementById("cd-edit").onclick = () => showForm(entry);
  open();
}

document.querySelectorAll(".cat-row").forEach(row =>
  row.addEventListener("click", () => openEntry(row.dataset.id)));
document.getElementById("cat-add").onclick = () => {
  document.getElementById("cd-title").textContent = "登记资产";
  showForm(null); open();
};
document.getElementById("cf-cancel").onclick = close;
