/**
 * 任务图：节点是父任务（子任务归在父任务上），边是上游联动（上游结束 → 下游）。
 * 分层布局：没有上游的在最左，每个任务排在它最长上游链的下一列；同一列按上游的位置排序，少交叉。
 * 悬停一个任务高亮它的上下游；没有任何联动的任务列在图下面。数据来自 GET /v1/tasks/_graph。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { LuWorkflow } from "react-icons/lu";

import type { TaskGraph as Graph, TaskGraphEdge, TaskGraphNode } from "@/api/types";
import { DisabledBadge, FailCount, RunStatusDot, TRIGGER } from "@/components/status";
import { TimeAgo } from "@/components/time";
import { Tooltip } from "@/components/ui/overlay";
import { Empty } from "@/components/ui/primitives";
import { describeCron } from "@/lib/cron";
import { cn } from "@/lib/cn";
import { Link } from "@/lib/router";

const W_MIN = 184;      // 节点宽：按容器宽度在这之间取，放得下就不横向滚
const W_MAX = 248;
const H = 76;           // 节点高
const GAP_X = 84;       // 列间距（放边上的标签）
const GAP_Y = 20;
const PAD = 12;

const taskHref = (name: string) => `/tasks/${encodeURIComponent(name)}`;
const when = (on: TaskGraphEdge["on"]) => (on.includes("success") && on.includes("failed") ? "结束后" : on.includes("failed") ? "失败后" : "成功后");
const edgeColor = (e: TaskGraphEdge) => (e.on.includes("success") && e.on.includes("failed") ? "var(--color-fg-3)" : e.on.includes("failed") ? "var(--color-bad)" : "var(--color-ok)");

interface Placed { node: TaskGraphNode; x: number; y: number; layer: number }

/** 分层：最长路径定列；两遍重心排序定行。room：容器宽度（0 = 还没量到），节点宽按它定 */
function layout(nodes: TaskGraphNode[], edges: TaskGraphEdge[], room: number) {
  const names = nodes.map((n) => n.name);
  const preds = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const e of edges) preds.get(e.to)?.push(e.from);
  const layer = new Map<string, number>();
  const depth = (n: string, seen: Set<string>): number => {
    if (layer.has(n)) return layer.get(n)!;
    if (seen.has(n)) return 0;            // 定义上不允许成环，兜底
    seen.add(n);
    const ps = preds.get(n) ?? [];
    const d = ps.length ? Math.max(...ps.map((p) => depth(p, seen) + 1)) : 0;
    layer.set(n, d);
    return d;
  };
  for (const n of names) depth(n, new Set());
  const cols: string[][] = [];
  for (const n of names) (cols[layer.get(n)!] ??= []).push(n);
  for (const c of cols) c?.sort();
  // 重心：按上游所在行的平均值排，跑两遍
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < cols.length; i++) {
      const idx = new Map(cols.slice(0, i).flatMap((c) => (c ?? []).map((n, j) => [n, j] as const)));
      const bary = (n: string) => { const ps = (preds.get(n) ?? []).map((p) => idx.get(p)).filter((x): x is number => x !== undefined); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0; };
      cols[i]?.sort((a, b) => bary(a) - bary(b) || a.localeCompare(b));
    }
  }
  const rows = Math.max(1, ...cols.map((c) => c?.length ?? 0));
  const n = Math.max(1, cols.length);
  const w = Math.floor(Math.min(W_MAX, Math.max(W_MIN, room ? (room - 1 - PAD * 2 - (n - 1) * GAP_X) / n : W_MAX)));
  const byName = new Map(nodes.map((x) => [x.name, x]));
  const placed = new Map<string, Placed>();
  cols.forEach((c, i) => {
    const offset = ((rows - (c?.length ?? 0)) * (H + GAP_Y)) / 2;   // 列内居中
    (c ?? []).forEach((name, j) => placed.set(name, { node: byName.get(name)!, layer: i, x: PAD + i * (w + GAP_X), y: PAD + offset + j * (H + GAP_Y) }));
  });
  return { placed, w, width: PAD * 2 + n * w + (n - 1) * GAP_X, height: PAD * 2 + rows * H + (rows - 1) * GAP_Y };
}

export function TaskGraph({ graph, focus, serviceTitle }: { graph: Graph; focus?: string; serviceTitle: (s: string | null) => string }) {
  const [hover, setHover] = useState<string | null>(null);
  const known = new Set(graph.nodes.map((n) => n.name));
  const edges = graph.edges.filter((e) => known.has(e.from) && known.has(e.to));
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const nodes = graph.nodes.filter((n) => linked.has(n.name));
  const isolated = graph.nodes.filter((n) => !linked.has(n.name));
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom(el.clientWidth));
    ro.observe(el);
    setRoom(el.clientWidth);
    return () => ro.disconnect();
  }, [nodes.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const { placed, width, height, w: W } = useMemo(() => layout(nodes, edges, room),
    [JSON.stringify(nodes.map((n) => n.name)), JSON.stringify(edges), room]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = hover ?? focus ?? null;
  const near = useMemo(() => {
    if (!active) return null;
    const s = new Set([active]);
    for (const e of edges) { if (e.from === active) s.add(e.to); if (e.to === active) s.add(e.from); }
    return s;
  }, [active, edges]);
  // 从任务详情点「任务图」过来：把它滚到视野里
  useEffect(() => {
    const p = focus ? placed.get(focus) : undefined;
    if (p && box.current) box.current.scrollTo({ left: Math.max(0, p.x - 80), top: Math.max(0, p.y - 80), behavior: "smooth" });
  }, [focus, placed]);

  // 同一对任务之间有多条边（不同的联动触发器）：标签错开
  const pairIndex = new Map<string, number>();
  const edgeKey = (e: TaskGraphEdge) => `${e.from}>${e.to}`;

  return (
    <div className="space-y-4">
      {nodes.length === 0 ? (
        <Empty icon={<LuWorkflow />} title="还没有联动" description="在任务的「定义 → 触发」里加「上游任务结束后」，任务就会接在别的任务后面跑，这里画出上下游。" />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-3 text-[11.5px] text-fg-3">
            <Legend color="var(--color-ok)" label="上游成功后" />
            <Legend color="var(--color-bad)" label="上游失败后" />
            <Legend color="var(--color-fg-3)" label="结束后（成功或失败）" />
            <Legend color="var(--color-fg-3)" dashed label="已停用" />
            <span>「全部」= 每个上游都结束过才跑；节点里的小图标是它自己的入口触发</span>
          </div>
          <div ref={box} className="relative overflow-auto px-0 pb-2" style={{ maxHeight: 640 }}>
            <div className="relative" style={{ width, height }}>
              <svg width={width} height={height} className="absolute inset-0" aria-hidden>
                <defs>
                  {["ok", "bad", "fg-3"].map((c) => (
                    <marker key={c} id={`arrow-${c}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M0,0 L8,4 L0,8 z" fill={`var(--color-${c})`} />
                    </marker>
                  ))}
                </defs>
                {edges.map((e, i) => {
                  const a = placed.get(e.from), b = placed.get(e.to);
                  if (!a || !b) return null;
                  const k = pairIndex.get(edgeKey(e)) ?? 0;
                  pairIndex.set(edgeKey(e), k + 1);
                  const x1 = a.x + W, y1 = a.y + H / 2 + k * 6, x2 = b.x - 2, y2 = b.y + H / 2 + k * 6;
                  const dx = Math.max(40, (x2 - x1) / 2);
                  const d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
                  const dim = near && !(near.has(e.from) && near.has(e.to) && (e.from === active || e.to === active));
                  const color = edgeColor(e);
                  const marker = color.includes("ok") ? "ok" : color.includes("bad") ? "bad" : "fg-3";
                  return (
                    <path key={i} d={d} fill="none" stroke={color} strokeWidth={dim ? 1.2 : 1.8} strokeDasharray={e.enabled ? undefined : "5 4"}
                      opacity={dim ? 0.18 : e.enabled ? 0.85 : 0.5} markerEnd={`url(#arrow-${marker})`} />
                  );
                })}
              </svg>
              {/* 边的标签放在 HTML 里：能悬停看是哪个触发器 */}
              {(() => {
                const seen = new Map<string, number>();
                return edges.map((e, i) => {
                  const a = placed.get(e.from), b = placed.get(e.to);
                  if (!a || !b) return null;
                  const k = seen.get(edgeKey(e)) ?? 0;
                  seen.set(edgeKey(e), k + 1);
                  const x = (a.x + W + b.x) / 2, y = (a.y + b.y) / 2 + H / 2 + k * 18;
                  const dim = near && !(e.from === active || e.to === active);
                  return (
                    <div key={i} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: x, top: y }}>
                      <Tooltip content={<>
                        <div>{e.to}{e.to_object ? `:${e.to_object}` : ""} 的联动 #{e.trigger_id}</div>
                        <div>{e.from}{e.from_object ? `:${e.from_object}` : ""} {when(e.on)}{e.upstreams > 1 ? (e.mode === "all" ? `，${e.upstreams} 个上游都结束才跑` : `，${e.upstreams} 个上游任一结束就跑`) : ""}</div>
                        {!e.enabled && <div>已停用</div>}
                      </>}>
                        <span className={cn("whitespace-nowrap rounded border border-line bg-panel px-1 text-[10.5px] leading-[16px] text-fg-2 shadow-[var(--shadow-card)] transition-opacity",
                          dim && "opacity-25")}>
                          {when(e.on)}{e.upstreams > 1 && e.mode === "all" ? "·全部" : ""}{e.from_object || e.to_object ? "·对象" : ""}
                        </span>
                      </Tooltip>
                    </div>
                  );
                });
              })()}
              {[...placed.values()].map((p) => (
                <div key={p.node.name} className="absolute" style={{ left: p.x, top: p.y, width: W, height: H }}
                  onMouseEnter={() => setHover(p.node.name)} onMouseLeave={() => setHover(null)}>
                  <NodeCard node={p.node} serviceTitle={serviceTitle} focused={focus === p.node.name} dim={!!near && !near.has(p.node.name)} />
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      {isolated.length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <div className="mb-2 text-[11.5px] font-medium text-fg-3">没有联动的任务（{isolated.length}）：只由自己的入口触发</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {isolated.map((n) => <div key={n.name} style={{ height: H }}><NodeCard node={n} serviceTitle={serviceTitle} focused={focus === n.name} /></div>)}
          </div>
        </div>
      )}
    </div>
  );
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "4 3" : undefined} /></svg>
      {label}
    </span>
  );
}

function entryText(e: TaskGraphNode["entry"][number]): string {
  if (e.type === "schedule") return `定时 ${e.cron ? describeCron(e.cron) : ""}`;
  if (e.type === "event") return `事件 ${e.source}.${e.event}`;
  return TRIGGER[e.type]?.label ?? e.type;
}

function NodeCard({ node, serviceTitle, focused, dim }: { node: TaskGraphNode; serviceTitle: (s: string | null) => string; focused?: boolean; dim?: boolean }) {
  const s = node.stats_24h;
  return (
    <Link to={taskHref(node.name)}
      className={cn("flex h-full flex-col justify-between rounded-lg border bg-panel px-3 py-2 shadow-[var(--shadow-card)] transition-[opacity,border-color] hover:border-accent",
        focused ? "border-accent ring-2 ring-[color-mix(in_oklab,var(--color-accent)_25%,transparent)]" : "border-line",
        !node.enabled && "bg-sunken/60", dim && "opacity-35")}>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-medium text-fg">{node.title || node.name}</span>
          {/* 入口触发（定时 / 事件 / API / 对话）：小图标，悬停看是什么 */}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {!node.enabled ? <DisabledBadge /> : node.entry.map((e) => (
              <Tooltip key={e.id} content={entryText(e)}><span className="text-fg-3 [&_svg]:size-3">{TRIGGER[e.type]?.icon}</span></Tooltip>
            ))}
          </span>
        </div>
        <div className="truncate font-mono text-[10.5px] text-fg-3">{node.name} · {serviceTitle(node.service)}{node.subtask_count ? ` · ${node.subtask_count} 个子任务` : ""}</div>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-fg-3">
        <Tooltip content="近 24 小时的运行次数"><span className="tabular-nums">{s.runs ? `${s.runs} 次` : "24h 没跑"}</span></Tooltip>
        <FailCount n={s.failed} />
        {node.last_run && (
          <span className="ml-auto inline-flex min-w-0 items-center gap-1"><RunStatusDot status={node.last_run.status} hint="最近一次" /><TimeAgo at={node.last_run.created_at} /></span>
        )}
      </div>
    </Link>
  );
}
