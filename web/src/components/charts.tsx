/**
 * 轻量图表（d3-scale 算坐标，React 画 SVG）：时间堆叠柱、比例条。
 * 颜色只用状态语义色；悬停给精确数值。
 */
import { scaleBand, scaleLinear } from "d3-scale";
import { useMemo, useRef, useState, useLayoutEffect } from "react";

import { cn } from "@/lib/cn";
import { dayjs } from "@/lib/format";

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export interface StackPoint { t: string; success: number; failed: number; other: number }

export function RunsChart({ data, height = 140, className }: { data: StackPoint[]; height?: number; className?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 28, r: 4, t: 6, b: 18 };
  const { x, y, max } = useMemo(() => {
    const max = Math.max(4, ...data.map((d) => d.success + d.failed + d.other));
    return {
      max,
      x: scaleBand<number>().domain(data.map((_, i) => i)).range([pad.l, Math.max(pad.l + 1, width - pad.r)]).paddingInner(0.28),
      y: scaleLinear().domain([0, max]).nice(4).range([height - pad.b, pad.t]),
    };
  }, [data, width, height, pad.l, pad.r, pad.t, pad.b]);
  const ticks = y.ticks(4);
  const labelEvery = Math.ceil(data.length / 6);
  const h = hover !== null ? data[hover] : null;
  void max;
  return (
    <div ref={ref} className={cn("relative select-none", className)} style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} className="overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="stroke-line" strokeDasharray={t === 0 ? undefined : "2 3"} />
              <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-fg-3 text-[10px] tabular-nums">{t}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const x0 = x(i) ?? 0;
            const bw = x.bandwidth();
            let base = y(0);
            const seg = (v: number, cls: string) => {
              if (!v) return null;
              const top = y(y.invert(base) + v);
              const el = <rect key={cls} x={x0} y={top} width={bw} height={Math.max(0, base - top)} className={cls} rx={1} />;
              base = top;
              return el;
            };
            return (
              <g key={i} onMouseEnter={() => setHover(i)} className={cn(hover !== null && hover !== i && "opacity-55")}>
                <rect x={x0 - 2} y={pad.t} width={bw + 4} height={height - pad.b - pad.t} className="fill-transparent" />
                {seg(d.success, "fill-ok/80")}
                {seg(d.failed, "fill-bad/85")}
                {seg(d.other, "fill-info/60")}
                {i % labelEvery === 0 && (
                  <text x={x0 + bw / 2} y={height - 4} textAnchor="middle" className="fill-fg-3 text-[10px] tabular-nums">{dayjs(d.t).format(data.length > 24 ? "DD日HH时" : "HH:mm")}</text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {h && hover !== null && (
        <div className="pointer-events-none absolute top-0 z-10 rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs shadow-[var(--shadow-pop)]"
          style={{ left: Math.min(width - 150, Math.max(0, (x(hover) ?? 0) - 40)) }}>
          <div className="mb-1 font-medium text-fg">{dayjs(h.t).format("MM-DD HH:mm")}</div>
          <div className="flex items-center gap-1.5 text-fg-2"><span className="size-2 rounded-sm bg-ok" />成功 <b className="ml-auto pl-3 tabular-nums text-fg">{h.success}</b></div>
          <div className="flex items-center gap-1.5 text-fg-2"><span className="size-2 rounded-sm bg-bad" />失败 <b className="ml-auto pl-3 tabular-nums text-fg">{h.failed}</b></div>
          <div className="flex items-center gap-1.5 text-fg-2"><span className="size-2 rounded-sm bg-info" />其他 <b className="ml-auto pl-3 tabular-nums text-fg">{h.other}</b></div>
        </div>
      )}
    </div>
  );
}

/** 成功率条：绿/红两段 + 数字 */
export function RatioBar({ ok, bad, total, className }: { ok: number; bad: number; total: number; className?: string }) {
  const pctOk = total ? (ok / total) * 100 : 0;
  const pctBad = total ? (bad / total) * 100 : 0;
  return (
    <div className={cn("flex h-1.5 w-full overflow-hidden rounded-full bg-sunken", className)}>
      <div className="bg-ok" style={{ width: `${pctOk}%` }} />
      <div className="bg-bad" style={{ width: `${pctBad}%` }} />
    </div>
  );
}
