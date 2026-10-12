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
    // 运行详情页：点击节点跳到对应步骤（骨架图按节点名，轨迹图按 seq-N 元素 id）
    const step = document.querySelector(
      `[data-step-node="${CSS.escape(node.id())}"]`)
      || document.getElementById(node.id());
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
/* 每步带 👍👎（节点级反馈）：POST /runs/{runId}/steps/{seq}/feedback；
   步骤间显示距上步耗时；长输出默认折叠（Claude Code 式，点击展开） */
function foldPre(text) {
  const t = String(text || "");
  if (t.length <= 240 && (t.match(/\n/g) || []).length < 4)
    return `<pre>${esc(t)}</pre>`;
  return `<div class="fold"><pre>${esc(t)}</pre>`
    + '<button class="fold-btn">展开 ▾</button></div>';
}

function renderSteps(container, newEvents) {
  // 服务端 ?since= 已保证只回新事件，这里全部追加渲染
  const list = newEvents.filter(e => e.kind !== "graph");
  if (!list.length) return;
  let prevTs = Date.parse(container.dataset.lastTs || "");
  const html = list.map(e => {
    const label = STEP_LABELS[e.kind] || e.kind;
    const tool = e.tool ? ` <span class="tag">${esc(e.tool)}</span>` : "";
    const node = e.node ? ` <span class="tag">${esc(e.node)}</span>` : "";
    const ts = Date.parse(e.created_at);
    const delta = !isNaN(prevTs) && !isNaN(ts) && ts > prevTs
      ? ` <span class="dur">+${((ts - prevTs) / 1000).toFixed(1)}s</span>` : "";
    if (!isNaN(ts)) prevTs = ts;
    return `<div class="step step-${e.kind}" data-step-node="${esc(e.node || "")}" id="seq-${e.seq}">
      <div class="meta"><span class="tag">#${e.seq}</span><span class="kind">${label}</span>${tool}${node}${delta}
        · ${esc(e.created_at)}
        <span class="step-fb" data-seq="${e.seq}">
          <button data-score="1" title="这步做得好">👍</button><button data-score="-1" title="这步有问题">👎</button>
        </span></div>
      ${foldPre(e.text)}</div>`;
  }).join("");
  container.insertAdjacentHTML("beforeend", html);
  if (!isNaN(prevTs)) container.dataset.lastTs = new Date(prevTs).toISOString();
}

/* 长步骤折叠 + 卡片复制：事件委托 */
document.addEventListener("click", async e => {
  const foldBtn = e.target.closest(".fold-btn");
  if (foldBtn) {
    const wrap = foldBtn.closest(".fold");
    const open = wrap.classList.toggle("open");
    foldBtn.textContent = open ? "收起 ▴" : "展开 ▾";
    return;
  }
  const copyBtn = e.target.closest(".copy-btn");
  if (copyBtn) {
    const el = document.getElementById(copyBtn.dataset.copy);
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.textContent);
      copyBtn.textContent = "已复制 ✓";
      setTimeout(() => { copyBtn.textContent = "复制"; }, 1200);
    } catch (err) { copyBtn.textContent = "复制失败"; }
  }
});

/* 节点级反馈：事件委托，点击后该步按钮锁定并打勾（fetch 不跳页） */
document.addEventListener("click", async e => {
  const btn = e.target.closest(".step-fb button");
  if (!btn) return;
  const wrap = btn.closest(".step-fb");
  const runId = document.getElementById("steps").dataset.runId;
  wrap.querySelectorAll("button").forEach(b => b.disabled = true);
  try {
    const resp = await fetch(`/runs/${runId}/steps/${wrap.dataset.seq}/feedback`, {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded"},
      body: `score=${btn.dataset.score}`,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    wrap.insertAdjacentHTML("beforeend", '<span class="fb-done">✓ 已记录</span>');
  } catch (err) {
    wrap.querySelectorAll("button").forEach(b => b.disabled = false);
    wrap.insertAdjacentHTML("beforeend", '<span class="fb-fail">记录失败，重试</span>');
  }
});

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
  // 终态给重跑入口：failed 断点续跑（同 id），其余终态同输入新开 run
  const rerun = ["success", "failed"].includes(s.run.status)
    ? `<form method="post" action="/runs/${esc(s.run.run_id)}/rerun"
         style="display:inline;margin-left:10px">
         <button class="inline">${s.run.status === "failed" ? "重跑（断点续跑）" : "重跑"}</button>
       </form>` : "";
  // 有会话的 run 可跳回对话页续聊：同 session 自动继承上下文/记忆，
  // 对话页再从该会话最新 run 回填域/角色/环境配置
  const chatLink = s.run.session_id
    ? `<a class="btn sm" style="margin-left:10px"
         href="/chat?session=${esc(s.run.session_id)}">在对话中继续 →</a>` : "";
  document.getElementById("run-head").innerHTML = `
    <div class="eyebrow">RUN · ${esc(s.run.task_type)}</div>
    <h2>${esc(s.run.run_id)} ${statusPill(s.run.status)}${rerun}${chatLink}</h2>
    <div class="meta">任务 ${v(s.run.task_type, s.run.task_version)}
      · 角色 ${v(s.run.role, s.run.role_version)} · 来源 ${esc(s.run.trigger_source)}${envTag}
      · 耗时 ${s.run.duration_ms || "-"}ms · ${esc(s.created_at)}</div>`;
}

/* —— Trace 元信息回填：Langfuse span（模型/token/成本/真实耗时）并进 —— */
/* 时间线步骤行。不另开视图——执行过程已覆盖步骤内容，span 数据只是补充 */
function annotateSpans(stepsEl, meta) {
  for (const [seq, m] of Object.entries(meta || {})) {
    const head = document.querySelector(`#seq-${seq} > .meta`);
    if (!head || head.querySelector(".span-meta")) continue;
    const info = [m.model, m.tokens ? `${m.tokens} tok` : "",
      m.cost ? `$${Number(m.cost).toFixed(4)}` : "",
      m.ms != null ? `${(m.ms / 1000).toFixed(2)}s` : ""]
      .filter(Boolean).join(" · ");
    if (!info) continue;
    const fb = head.querySelector(".step-fb");
    const html = ` <span class="span-meta">${esc(info)}</span>`;
    if (fb) fb.insertAdjacentHTML("beforebegin", html);
    else head.insertAdjacentHTML("beforeend", html);
  }
}

/* —— Run 详情页：轮询 state.json，局部刷新图与步骤 —— */
/* trace 元信息只在首拉与 run 到终态时各拉一次（?trace=1），回填步骤行 */
async function watchRun(runId) {
  const graphEl = document.getElementById("graph");
  const stepsEl = document.getElementById("steps");
  const wantTrace = document.getElementById("steps-head") &&
    document.getElementById("steps-head").dataset.traceTid;
  stepsEl.dataset.runId = runId;
  let lastSeq = -1;   // seq 从 0 起（trace 事件是 seq 0），首拉要全量
  let traceDone = false, first = true, prevTerminal = false;
  const allEvents = [];   // 失败横幅/图状态推导要用完整事件，不随增量丢弃
  while (true) {
    const askTrace = wantTrace && !traceDone && (first || prevTerminal);
    let s;
    try {
      s = await (await fetch(
        `/runs/${runId}/state.json?since=${lastSeq}${askTrace ? "&trace=1" : ""}`
      )).json();
    } catch (err) {
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    first = false;
    allEvents.push(...s.events);
    if (s.events.length) lastSeq = Math.max(...s.events.map(e => e.seq));
    renderRunHead(s);
    if (s.graph && s.graph.nodes && s.graph.nodes.length) {
      document.getElementById("graph-card").style.display = "";
      // 状态来源：资产图 artifacts 表映射 / 骨架图事件推导
      const statuses = s.graph.statuses
        ? Object.fromEntries(Object.entries(s.graph.statuses).map(([k, v]) =>
            [k, v === "materialized" || v === "reused" ? "executed"
              : v === "rejected" ? "failed" : ""]))
        : nodeStatusOf(allEvents, s.run.status);
      renderInto(graphEl, s.graph, statuses);
    }
    renderSteps(stepsEl, s.events);
    if (s.trace) {
      annotateSpans(stepsEl, s.trace.meta);
      if (["success", "failed"].includes(s.run.status)) traceDone = true;
    }
    // 最终输出：Markdown 渲染（answer 字段），否则 JSON 代码块——与对话页一致
    const outEl = document.getElementById("output");
    if (s.run.output && typeof s.run.output.answer === "string")
      outEl.innerHTML = DOMPurify.sanitize(
        marked.parse(s.run.output.answer, {breaks: true}));
    else
      outEl.innerHTML = `<pre>${esc(JSON.stringify(s.run.output, null, 2))}</pre>`;
    // 失败 run：报错从时间线提到顶部横幅，一眼定位
    if (s.run.status === "failed" && !document.getElementById("fail-banner")) {
      const last = [...allEvents].reverse().find(e => e.kind !== "graph");
      if (last) {
        const head = document.getElementById("run-head");
        head.insertAdjacentHTML("afterend",
          `<div class="alert" id="fail-banner"><b>失败</b>${foldPre(last.text)}</div>`);
      }
    }
    prevTerminal = s.run.status !== "queued" && s.run.status !== "running";
    if (prevTerminal) {
      // 终态补拉一次完整 trace 元信息（入库有延迟，运行中拉的可能是部分）
      if (wantTrace && !traceDone) {
        try {
          const t = await (await fetch(
            `/runs/${runId}/state.json?trace=1`)).json();
          if (t.trace) annotateSpans(stepsEl, t.trace.meta);
        } catch (err) { /* 元信息缺失不挡页面 */ }
      }
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}
