/* Viewer 图渲染：cytoscape + dagre 分层布局（布局引擎内嵌于 cytoscape-dagre）。
   拓扑页与运行详情共用 mountGraph；运行图 2s 轮询——结构不变时只更新状态样式，
   保留用户的平移/缩放视口。节点标签自动换行，不截断。 */

const STEP_LABELS = {
  thought: "思考", tool_call: "工具调用", tool_result: "工具结果",
  llm: "结论", final: "结论", note: "备注", trace: "trace",
};

function esc(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function statusPill(status) {
  return `<span class="pill pill-${status}"><span class="led"></span>${status}</span>`;
}

/* —— cytoscape 样式：与 app.css 设计令牌一致 —— */
const CY_STYLE = [
  {selector: "node", style: {
    "label": "data(label)",
    "font-family": "'JetBrains Mono', ui-monospace, monospace",
    "font-size": 11, "color": "#e2e8f0",
    "text-wrap": "wrap", "text-max-width": "180px",
    "text-valign": "center", "text-halign": "center",
    "width": "label", "height": "label", "padding": "10px",
    "shape": "round-rectangle",
    "background-color": "#111a2b", "border-width": 1.5, "border-color": "#2a3a5f",
    "overlay-color": "#fbbf24", "overlay-opacity": 0, "overlay-padding": 5,
  }},
  {selector: "node.hover", style: {"border-color": "#22d3ee"}},
  {selector: "node.executed", style: {
    "border-color": "#34d399", "background-color": "#0d201a"}},
  {selector: "node.active", style: {
    "border-color": "#fbbf24", "background-color": "#251e0f"}},
  {selector: "node.failed", style: {
    "border-color": "#f87171", "background-color": "#2a1214"}},
  {selector: "edge", style: {
    "width": 1.2, "line-color": "#2a3a5f",
    "target-arrow-shape": "triangle", "target-arrow-color": "#2a3a5f",
    "arrow-scale": 0.9, "curve-style": "bezier",
  }},
  {selector: "edge.to-active", style: {
    "line-color": "#fbbf24", "target-arrow-color": "#fbbf24"}},
  {selector: ".faded", style: {"opacity": 0.22}},
];

const LAYOUT_OPTS = {
  name: "dagre", rankDir: "TB", nodeSep: 26, rankSep: 54,
  nodeDimensionsIncludeLabels: true, useDagreEdgeControlPoints: true,
  animate: false, fit: true, padding: 28,
};

/* 结构签名：节点与边集合变化才重新布局，避免轮询重置视口 */
function structureSig(graph) {
  const ns = graph.nodes.map(n => n.id).sort().join(",");
  const es = graph.edges.map(e => `${e.source}>${e.target}`).sort().join(",");
  return ns + "|" + es;
}

function mountGraph(el, graph) {
  const cy = cytoscape({
    container: el,
    elements: [
      ...graph.nodes.map(n => ({data: {id: n.id, label: n.label || n.id}})),
      ...graph.edges.map(e => ({data: {source: e.source, target: e.target},
                                classes: "useDagreEdgeControlPoints"})),
    ],
    style: CY_STYLE,
    wheelSensitivity: 0.2,
    boxSelectionEnabled: false,
  });
  cy.layout(LAYOUT_OPTS).run();
  cy.on("mouseover", "node", e => e.target.addClass("hover"));
  cy.on("mouseout", "node", e => e.target.removeClass("hover"));
  cy.on("tap", "node", e => {
    const node = e.target;
    cy.elements().addClass("faded");
    node.closedNeighborhood().removeClass("faded");
    // 运行详情页：点击节点跳到该节点的第一条步骤
    const step = document.querySelector(
      `[data-step-node="${CSS.escape(node.id())}"]`);
    if (step) step.scrollIntoView({behavior: "smooth", block: "center"});
  });
  cy.on("tap", e => { if (e.target === cy) cy.elements().removeClass("faded"); });
  el._cy = cy;
  el._sig = structureSig(graph);
  return cy;
}

/* 节点状态：executed/active/failed；active 带呼吸光晕，入边上色 */
function updateStatuses(cy, statuses) {
  cy.nodes().removeClass("executed active failed");
  for (const [id, st] of Object.entries(statuses || {})) {
    if (st) cy.getElementById(id).addClass(st);
  }
  cy.edges().removeClass("to-active");
  cy.nodes(".active").incomers("edge").addClass("to-active");
  pulseActive(cy);
}

function pulseActive(cy) {
  if (cy.scratch("_pulsing")) return;
  const tick = () => {
    const nodes = cy.nodes(".active");
    if (cy.destroyed() || !nodes.nonempty()) {
      cy.scratch("_pulsing", false);
      return;
    }
    cy.scratch("_pulsing", true);
    nodes.animate({style: {"overlay-opacity": 0.22}}, {duration: 650})
         .animate({style: {"overlay-opacity": 0}}, {duration: 650, complete: tick});
  };
  tick();
}

/* 渲染入口：结构变化重建并重排，否则原地刷状态 */
function renderInto(el, graph, statuses) {
  const sig = structureSig(graph);
  if (el._cy && !el._cy.destroyed() && el._sig === sig) {
    updateStatuses(el._cy, statuses);
    return;
  }
  if (el._cy && !el._cy.destroyed()) el._cy.destroy();
  el.innerHTML = "";
  const cy = mountGraph(el, graph);
  updateStatuses(cy, statuses);
}

/* 图右上角/右下角浮层的缩放按钮（页面静态 markup，这里统一接线） */
document.addEventListener("click", e => {
  const btn = e.target.closest(".graph-tools button");
  if (!btn) return;
  const shell = btn.closest(".graph-shell");
  const cyEl = shell && shell.querySelector(".cy");
  const cy = cyEl && cyEl._cy;
  if (!cy) return;
  const center = {x: cyEl.clientWidth / 2, y: cyEl.clientHeight / 2};
  if (btn.dataset.act === "in") cy.zoom({level: cy.zoom() * 1.25, renderedPosition: center});
  else if (btn.dataset.act === "out") cy.zoom({level: cy.zoom() / 1.25, renderedPosition: center});
  else if (btn.dataset.act === "fit") cy.fit(undefined, 28);
});

/* —— 步骤时间线：事件 append-only，只增量渲染新步骤 —— */
function renderSteps(container, events) {
  const list = events.filter(e => e.kind !== "graph");
  const done = parseInt(container.dataset.count || "0", 10);
  if (list.length <= done) { container.dataset.count = list.length; return; }
  const html = list.slice(done).map(e => {
    const label = STEP_LABELS[e.kind] || e.kind;
    const tool = e.tool ? ` <span class="tag">${esc(e.tool)}</span>` : "";
    const node = e.node ? ` <span class="tag">${esc(e.node)}</span>` : "";
    return `<div class="step step-${e.kind}" data-step-node="${esc(e.node || "")}" id="seq-${e.seq}">
      <div class="meta"><span class="tag">#${e.seq}</span><span class="kind">${label}</span>${tool}${node}
        · ${esc(e.created_at)}</div>
      <pre>${esc(e.text)}</pre></div>`;
  }).join("");
  container.insertAdjacentHTML("beforeend", html);
  container.dataset.count = list.length;
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

function renderRunHead(s) {
  const v = (name, ver) => ver == null ? esc(name) : `${esc(name)} <span class="tag">v${ver}</span>`;
  const envTag = s.run.target_env
    ? ` · 目标环境 <span class="tag">${esc(s.run.target_env)}</span>` : "";
  document.getElementById("run-head").innerHTML = `
    <div class="eyebrow">RUN · ${esc(s.run.task_type)}</div>
    <h2>${esc(s.run.run_id)} ${statusPill(s.run.status)}</h2>
    <div class="meta">任务 ${v(s.run.task_type, s.run.task_version)}
      · 角色 ${v(s.run.role, s.run.role_version)} · 来源 ${esc(s.run.trigger_source)}${envTag}
      · 耗时 ${s.run.duration_ms || "-"}ms · ${esc(s.created_at)}</div>`;
}

/* —— Run 详情页：轮询 state.json，局部刷新图与步骤 —— */
async function watchRun(runId) {
  const graphEl = document.getElementById("graph");
  while (true) {
    let s;
    try {
      s = await (await fetch(`/runs/${runId}/state.json`)).json();
    } catch (err) {
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    renderRunHead(s);
    if (s.graph && s.graph.nodes && s.graph.nodes.length) {
      document.getElementById("graph-card").style.display = "";
      // 资产图 run 的节点状态由 artifacts 表直给；普通 run 从事件推导
      const statuses = s.graph.statuses
        ? Object.fromEntries(Object.entries(s.graph.statuses).map(([k, v]) =>
            [k, v === "materialized" || v === "reused" ? "executed"
              : v === "rejected" ? "failed" : ""]))
        : nodeStatusOf(s.events, s.run.status);
      renderInto(graphEl, s.graph, statuses);
    }
    renderSteps(document.getElementById("steps"), s.events);
    document.getElementById("output").textContent = JSON.stringify(s.run.output);
    if (s.run.status !== "queued" && s.run.status !== "running") break;
    await new Promise(r => setTimeout(r, 2000));
  }
}

/* —— /graph 拓扑页：首次加载引擎构建图约需 30s —— */
async function showTopology() {
  const el = document.getElementById("graph");
  el.innerHTML = '<div class="graph-loading">引擎构建中，首次约需 30s…</div>';
  try {
    const resp = await fetch("/graph.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const g = await resp.json();
    renderInto(el, g, {});
  } catch (err) {
    el.innerHTML = `<div class="graph-loading">加载失败：${esc(err.message)}
      · <a href="/graph">重试</a></div>`;
  }
}
