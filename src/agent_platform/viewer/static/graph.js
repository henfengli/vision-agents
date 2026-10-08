/* Run Viewer 运行图与步骤渲染：dagre 分层布局 + SVG，2s 轮询局部刷新。 */

const STEP_LABELS = {
  thought: "💭 思考", tool_call: "🔧 工具调用", tool_result: "📄 工具结果",
  llm: "✅ 结论", note: "ℹ️ 备注", trace: "🔍 trace",
};

function esc(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* —— dagre 布局 + SVG 渲染 —— */
function renderGraph(container, graph, nodeStatus) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({rankdir: "TB", nodesep: 30, ranksep: 45});
  g.setDefaultEdgeLabel(() => ({}));
  const W = 150, H = 36;
  for (const n of graph.nodes) g.setNode(n.id, {label: n.label, width: W, height: H});
  for (const e of graph.edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  let nodes = "", edges = "";
  for (const e of g.edges()) {
    const pts = g.edge(e).points;
    edges += `<polyline class="gedge" points="${pts.map(p => p.x + "," + p.y).join(" ")}"/>`;
  }
  for (const id of g.nodes()) {
    const n = g.node(id);
    const st = (nodeStatus && nodeStatus[id]) || "";
    nodes += `<g class="gnode ${st}" data-node="${esc(id)}" transform="translate(${n.x - W/2},${n.y - H/2})">
      <rect width="${W}" height="${H}" rx="6"></rect>
      <text x="${W/2}" y="${H/2 + 4}" text-anchor="middle">${esc(n.label)}</text></g>`;
  }
  container.innerHTML =
    `<svg width="${g.graph().width + 20}" height="${g.graph().height + 20}">
      <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4"
        orient="auto"><path d="M0,0 L8,4 L0,8" fill="none" stroke="#999"/></marker></defs>
      ${edges}${nodes}</svg>`;

  // 点击节点 → 跳到该节点的第一条步骤
  container.querySelectorAll(".gnode").forEach(el => {
    el.addEventListener("click", () => {
      const target = document.querySelector(`[data-step-node="${el.dataset.node}"]`);
      if (target) target.scrollIntoView({behavior: "smooth", block: "center"});
    });
  });
}

/* —— 步骤时间线 —— */
function renderSteps(container, events) {
  container.innerHTML = events.filter(e => e.kind !== "graph").map(e => {
    const label = STEP_LABELS[e.kind] || e.kind;
    const tool = e.tool ? ` <b>${esc(e.tool)}</b>` : "";
    return `<div class="step step-${e.kind}" data-step-node="${esc(e.node || "")}" id="seq-${e.seq}">
      <div class="meta"><span class="tag">#${e.seq}</span>${label}${tool}
        ${e.node ? `<span class="tag">节点 ${esc(e.node)}</span>` : ""} · ${e.created_at}</div>
      <pre>${esc(e.text)}</pre></div>`;
  }).join("");
}

/* —— 节点状态推导：执行过 / 进行中（最后事件所在节点）/ 失败点 —— */
function nodeStatusOf(events, status) {
  const st = {};
  for (const e of events) if (e.node) st[e.node] = "executed";
  const last = [...events].reverse().find(e => e.node);
  if (last) {
    if (status === "running" || status === "queued") st[last.node] = "active";
    if (status === "failed") st[last.node] = "failed";
  }
  return st;
}

/* —— Run 详情页：轮询 state.json，局部刷新图与步骤 —— */
async function watchRun(runId) {
  while (true) {
    const s = await (await fetch(`/runs/${runId}/state.json`)).json();
    const v = (name, ver) => ver == null ? name : `${name} <span class="tag">v${ver}</span>`;
    document.getElementById("run-head").innerHTML =
      `<h2>Run ${s.run.run_id} <span class="status-${s.run.status}">[${s.run.status}]</span></h2>
       <div class="meta">任务 ${v(s.run.task_type, s.run.task_version)}
         · 角色 ${v(s.run.role, s.run.role_version)} · 来源 ${s.run.trigger_source}
         · 耗时 ${s.run.duration_ms || "-"}ms · ${s.created_at}</div>`;
    if (s.graph && s.graph.nodes.length) {
      document.getElementById("graph-card").style.display = "";
      // 资产图 run 的节点状态由 artifacts 表直给；普通 run 从事件推导
      const statuses = s.graph.statuses
        ? Object.fromEntries(Object.entries(s.graph.statuses).map(([k, v]) =>
            [k, v === "materialized" || v === "reused" ? "executed"
              : v === "rejected" ? "failed" : ""]))
        : nodeStatusOf(s.events, s.run.status);
      renderGraph(document.getElementById("graph"), s.graph, statuses);
    }
    renderSteps(document.getElementById("steps"), s.events);
    document.getElementById("output").textContent = JSON.stringify(s.run.output);
    if (s.run.status !== "queued" && s.run.status !== "running") break;
    await new Promise(r => setTimeout(r, 2000));
  }
}

/* —— /graph 拓扑页 —— */
async function showTopology() {
  const g = await (await fetch("/graph.json")).json();
  renderGraph(document.getElementById("graph"), g, {});
}
