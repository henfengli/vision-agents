/**
 * 轻量图表（d3-scale 算坐标，React 画 SVG）：时间堆叠柱、比例条。
 * 颜色只用状态语义色；悬停给精确数值。
 */
import { scaleBand, scaleLinear } from "d3-scale";
import { useMemo, useRef, useState, useLayoutEffect } from "react";

import { cn } from "@/lib/cn";
import { dayjs } from "@/lib/format";

function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, number, number] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size.w, size.h];
}

export interface StackPoint { t: string; end: string; success: number; failed: number; retrying: number; active: number; cancelled: number }

type SegKey = "failed" | "success" | "active" | "cancelled";
/**
 * 自下而上的堆叠顺序：失败贴着底线，各时段的失败数在同一条基线上比；成功其次；还没结束的、取消的在最上面。
 * 「进行中」= 排队中 + 运行中，会变成成功或失败，和已取消（终态）分开画。
 */
const SEGMENTS: { key: SegKey; label: string; fill: string; dot: string }[] = [
  { key: "failed", label: "失败", fill: "fill-bad/85", dot: "bg-bad/85" },
  { key: "success", label: "成功", fill: "fill-ok/80", dot: "bg-ok/80" },
  { key: "active", label: "进行中", fill: "fill-info/60", dot: "bg-info/60" },
  { key: "cancelled", label: "已取消", fill: "fill-idle/50", dot: "bg-idle/50" },
];
/** 图例按读的顺序（成功在前），颜色和柱子一致 */
const LEGEND: SegKey[] = ["success", "failed", "active", "cancelled"];

const totalOf = (d: StackPoint) => d.success + d.failed + d.active + d.cancelled;

export function RunsLegend() {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[11.5px] text-fg-3">
      {LEGEND.map((k) => {
        const s = SEGMENTS.find((x) => x.key === k)!;
        return <span key={k} className="flex items-center gap-1.5"><span className={cn("size-2 rounded-sm", s.dot)} />{s.label}</span>;
      })}
    </div>
  );
}

/** 轴上的刻度间隔（小时）：柱宽的整数倍，按宽度挑，大约每 56px 一个 */
const TICK_EVERY_H = [1, 2, 3, 4, 6, 12, 24, 48, 72, 168];

/**
 * 运行趋势：每根柱子是一个按本地钟点对齐的时段（step 秒，后端给），按发起时间落柱。
 * 刻度画在柱子之间的分界上（这一刻之后的柱子从它开始），0 点写日期并画一条竖虚线；
 * 第一根从窗口起点算、最后一根到现在为止，可能不满一格，悬停时写清楚起止。
 * onSelect：点柱子（看那段时间的运行）。height 不给 = 撑满容器（容器要有高度，比如 flex-1）。
 */
export function RunsChart({ data, step, onSelect, height: fixed, className }: {
  data: StackPoint[]; step: number; onSelect?: (p: StackPoint, last: boolean) => void; height?: number; className?: string;
}) {
  const [ref, width, measured] = useSize<HTMLDivElement>();
  const height = fixed ?? Math.max(120, measured);
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 28, r: 6, t: 6, b: 20 };
  const { x, y } = useMemo(() => ({
    x: scaleBand<number>().domain(data.map((_, i) => i)).range([pad.l, Math.max(pad.l + 1, width - pad.r)]).paddingInner(0.28),
    y: scaleLinear().domain([0, Math.max(4, ...data.map(totalOf))]).nice(4).range([height - pad.b, pad.t]),
  }), [data, width, height, pad.l, pad.r, pad.t, pad.b]);
  const base = y(0);
  const yTicks = y.ticks(4);
  const total = data.reduce((n, d) => n + totalOf(d), 0);

  // 刻度：只落在对齐的时段起点上（被窗口截断的第一根不算），本地时间按「从纪元起第几小时」取整判断
  const stepH = step / 3600;
  const every = TICK_EVERY_H.find((h) => h % stepH === 0 && (data.length * stepH) / h <= Math.max(2, (width - pad.l - pad.r) / 56)) ?? 168;
  const gap = x.step() * x.paddingInner();
  const ticks = data.flatMap((d, i) => {
    const t = dayjs(d.t);
    const localH = t.valueOf() / 3_600_000 + t.utcOffset() / 60;
    if (Math.abs(localH - Math.round(localH)) > 1e-6 || Math.round(localH) % every !== 0) return [];
    return [{ i, at: (x(i) ?? 0) - gap / 2, midnight: Math.round(localH) % 24 === 0, t }];
  });

  const h = hover !== null ? data[hover] : null;
  const span = (d: StackPoint, i: number) => {
    const a = dayjs(d.t), b = dayjs(d.end);
    const last = i === data.length - 1;
    const end = last ? "现在" : b.format(b.isSame(a, "day") || b.hour() + b.minute() === 0 ? "HH:mm" : "MM-DD HH:mm");
    return `${a.format("MM-DD HH:mm")} – ${end === "00:00" ? "24:00" : end}`;
  };
  const finished = h ? h.success + h.failed : 0;

  return (
    <div ref={ref} className={cn("relative select-none", className)} style={fixed ? { height: fixed } : undefined} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} className="absolute inset-x-0 top-0 overflow-visible" role="img"
          aria-label={`运行趋势：共 ${total} 次，失败 ${data.reduce((n, d) => n + d.failed, 0)} 次`}>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="stroke-line" strokeDasharray={t === 0 ? undefined : "2 3"} />
              <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-fg-3 text-[10px] tabular-nums">{t}</text>
            </g>
          ))}
          {ticks.map((k) => (
            <g key={k.i}>
              {k.midnight && stepH < 24 && <line x1={k.at} x2={k.at} y1={pad.t} y2={base} className="stroke-line-strong" strokeDasharray="2 3" />}
              <line x1={k.at} x2={k.at} y1={base} y2={base + 4} className="stroke-line-strong" />
              <text x={k.at} y={height - 4} textAnchor={k.at > width - 20 ? "end" : "middle"}
                className={cn("text-[10px] tabular-nums", k.midnight ? "fill-fg-2 font-medium" : "fill-fg-3")}>
                {k.midnight ? k.t.format("MM-DD") : k.t.format("HH:mm")}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x0 = x(i) ?? 0;
            const bw = x.bandwidth();
            let top = 0;
            const clickable = !!onSelect && totalOf(d) > 0;
            return (
              <g key={i} onMouseEnter={() => setHover(i)} onClick={clickable ? () => onSelect!(d, i === data.length - 1) : undefined}
                className={cn(clickable && "cursor-pointer", hover !== null && hover !== i && "opacity-55")}>
                <rect x={x0 - gap / 2} y={pad.t} width={bw + gap} height={base - pad.t} className="fill-transparent" />
                {SEGMENTS.map((s) => {
                  const v = d[s.key];
                  if (!v) return null;
                  const y1 = y(top), y2 = y(top + v);
                  top += v;
                  return <rect key={s.key} x={x0} y={y2} width={bw} height={Math.max(0, y1 - y2)} className={s.fill} rx={1} />;
                })}
              </g>
            );
          })}
          {total === 0 && <text x={(pad.l + width - pad.r) / 2} y={(pad.t + base) / 2} textAnchor="middle" className="fill-fg-3 text-[12px]">这段时间没有运行</text>}
        </svg>
      )}
      {h && hover !== null && (
        <div className="pointer-events-none absolute top-0 z-10 w-[176px] rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs shadow-[var(--shadow-pop)]"
          style={{ left: Math.min(width - 176, Math.max(0, (x(hover) ?? 0) + x.bandwidth() / 2 - 88)) }}>
          <div className="mb-1 font-medium tabular-nums text-fg">{span(h, hover)}</div>
          {LEGEND.map((k) => {
            const s = SEGMENTS.find((x) => x.key === k)!;
            return (
              <div key={k} className={cn("flex items-center gap-1.5 text-fg-2", !h[k] && "opacity-50")}>
                <span className={cn("size-2 rounded-sm", s.dot)} />{s.label}
                {k === "failed" && h.retrying > 0 && <span className="text-[11px] text-fg-3">（{h.retrying} 个等重试）</span>}
                <b className="ml-auto pl-3 tabular-nums text-fg">{h[k]}</b>
              </div>
            );
          })}
          <div className="mt-1 border-t border-line pt-1 text-[11px] text-fg-3">
            共 {totalOf(h)} 次{finished ? ` · 失败率 ${Math.round((h.failed / finished) * 100)}%` : ""}
            {onSelect && totalOf(h) > 0 && <div>点击看这段时间的运行</div>}
          </div>
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
