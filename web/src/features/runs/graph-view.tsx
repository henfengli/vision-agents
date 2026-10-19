/**
 * 任务图 DAG：拓扑分层布局（层 = 列，层内纵向排列），SVG 画贝塞尔边。
 * 任务图通常十几个节点以内，自绘布局足够且零依赖。
 */
import { useMemo } from "react";

import type { GraphNodeState } from "@/api/types";
import { cn } from "@/lib/cn";

const W = 144, H = 54, GX = 44, GY = 20, PAD = 12;

const STATUS: Record<GraphNodeState["status"], { label: string; cls: string; dot: string }> = {
  pending: { label: "等待", cls: "border-line bg-panel", dot: "bg-line-strong" },
  running: { label: "物化中", cls: "border-info bg-info-soft", dot: "bg-info animate-pulse-dot" },
  materialized: { label: "已物化", cls: "border-ok/50 bg-ok-soft", dot: "bg-ok" },
  reused: { label: "复用", cls: "border-accent/40 bg-accent-soft", dot: "bg-accent" },
  skipped: { label: "跳过", cls: "border-dashed border-line-strong bg-sunken", dot: "bg-idle" },
  rejected: { label: "被拒", cls: "border-warn/50 bg-warn-soft", dot: "bg-warn" },
  failed: { label: "失败", cls: "border-bad/60 bg-bad-soft", dot: "bg-bad" },
};

const KIND: Record<GraphNodeState["kind"], string> = { code: "code", agent: "agent", route: "route", map: "map ×N" };

export function GraphView({ graph }: { graph: { nodes: GraphNodeState[]; edges: { from: string; to: string }[] } }) {
  const layout = useMemo(() => {
    const layer = new Map<string, number>();
    const deps = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
    for (const e of graph.edges) deps.get(e.to)?.push(e.from);
    const depth = (id: string, seen = new Set<string>()): number => {
      if (layer.has(id)) return layer.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const d = Math.max(-1, ...(deps.get(id) ?? []).map((p) => depth(p, seen))) + 1;
      layer.set(id, d);
      return d;
    };
    graph.nodes.forEach((n) => depth(n.id));
    const cols: string[][] = [];
    for (const n of graph.nodes) (cols[layer.get(n.id)!] ??= []).push(n.id);
    const maxRows = Math.max(...cols.map((c) => c.length));
    const pos = new Map<string, { x: number; y: number }>();
    cols.forEach((col, ci) => col.forEach((id, ri) => {
      const offset = ((maxRows - col.length) * (H + GY)) / 2;
      pos.set(id, { x: PAD + ci * (W + GX), y: PAD + offset + ri * (H + GY) });
    }));
    return { pos, width: PAD * 2 + cols.length * W + (cols.length - 1) * GX, height: PAD * 2 + maxRows * H + (maxRows - 1) * GY };
  }, [graph]);

  return (
    <div className="overflow-x-auto p-4">
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <svg width={layout.width} height={layout.height} className="absolute inset-0">
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0 8 4 0 8z" className="fill-line-strong" />
            </marker>
          </defs>
          {graph.edges.map((e) => {
            const a = layout.pos.get(e.from), b = layout.pos.get(e.to);
            if (!a || !b) return null;
            const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
            return <path key={e.from + e.to} d={`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`} fill="none" className="stroke-line-strong" strokeWidth={1.5} markerEnd="url(#arrow)" />;
          })}
        </svg>
        {graph.nodes.map((n) => {
          const p = layout.pos.get(n.id)!;
          const s = STATUS[n.status];
          return (
            <div key={n.id} className={cn("absolute flex flex-col justify-center rounded-lg border px-3 shadow-[var(--shadow-card)]", s.cls)} style={{ left: p.x, top: p.y, width: W, height: H }}>
              <div className="flex items-center gap-1.5">
                <span className={cn("size-2 rounded-full", s.dot)} />
                <span className="truncate font-mono text-[12.5px] font-semibold text-fg">{n.id}</span>
                <span className="ml-auto rounded bg-panel/70 px-1 font-mono text-[10px] text-fg-3">{KIND[n.kind]}</span>
              </div>
              <div className="mt-0.5 truncate pl-3.5 text-[11px] text-fg-3">{n.summary || s.label}</div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-[11.5px] text-fg-3">
        {(["materialized", "reused", "running", "skipped", "failed"] as const).map((k) => (
          <span key={k} className="flex items-center gap-1.5"><span className={cn("size-2 rounded-full", STATUS[k].dot)} />{STATUS[k].label}</span>
        ))}
      </div>
    </div>
  );
}
