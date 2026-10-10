// Cytoscape 运行图 React 组件：dagre 分层布局 + 三态染色 + 点击联动。
// 结构不变时只刷状态颜色（保留用户缩放/平移视口），结构变了才重排。

import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";
import type { TraceGraph } from "@/lib/api";

cytoscape.use(dagre);

const STYLE: cytoscape.StylesheetJson = [
  { selector: "node", style: {
    label: "data(label)",
    "font-family": "'JetBrains Mono', ui-monospace, monospace",
    "font-size": 11, color: "#e2e8f0",
    "text-wrap": "wrap", "text-max-width": "180px",
    "text-valign": "center", "text-halign": "center",
    width: "label", height: "label", padding: "10px",
    shape: "round-rectangle",
    "background-color": "#111a2b", "border-width": 1.5,
    "border-color": "#2a3a5f",
  } },
  { selector: "node.executed", style: {
    "border-color": "#34d399", "background-color": "#0d201a" } },
  { selector: "node.active", style: {
    "border-color": "#fbbf24", "background-color": "#251e0f" } },
  { selector: "node.failed", style: {
    "border-color": "#f87171", "background-color": "#2a1214" } },
  { selector: "edge", style: {
    width: 1.2, "line-color": "#2a3a5f",
    "target-arrow-shape": "triangle", "target-arrow-color": "#2a3a5f",
    "arrow-scale": 0.9, "curve-style": "bezier" } },
];

function sig(g: TraceGraph): string {
  return g.nodes.map((n) => n.id).sort().join(",") + "|" +
    g.edges.map((e) => `${e.source}>${e.target}`).sort().join(",");
}

export default function CyGraph({ graph, onNodeTap, className }: {
  graph: TraceGraph;
  onNodeTap?: (id: string) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const sigRef = useRef("");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const s = sig(graph);
    if (cyRef.current && sigRef.current === s) {
      // 结构未变：原地刷状态
      const cy = cyRef.current;
      cy.nodes().removeClass("executed active failed");
      for (const [id, st] of Object.entries(graph.statuses || {})) {
        if (st) cy.getElementById(id).addClass(st);
      }
      return;
    }
    cyRef.current?.destroy();
    const cy = cytoscape({
      container: el,
      elements: [
        ...graph.nodes.map((n) => ({
          data: { id: n.id, label: n.label || n.id } })),
        ...graph.edges.map((e) => ({
          data: { source: e.source, target: e.target } })),
      ],
      style: STYLE,
      wheelSensitivity: 0.2,
      boxSelectionEnabled: false,
    });
    cy.layout({ name: "dagre", rankDir: "TB", nodeSep: 26, rankSep: 54,
                animate: false, fit: true, padding: 28 } as never).run();
    cy.on("tap", "node", (ev) => onNodeTap?.(ev.target.id()));
    cyRef.current = cy;
    sigRef.current = s;
    for (const [id, st] of Object.entries(graph.statuses || {})) {
      if (st) cy.getElementById(id).addClass(st);
    }
    return () => { /* 不随每次渲染销毁，卸载时由下面 effect 管 */ };
  }, [graph, onNodeTap]);

  useEffect(() => () => { cyRef.current?.destroy(); cyRef.current = null; },
            []);

  return <div ref={ref} className={className ?? "h-[420px] w-full"} />;
}
