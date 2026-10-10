// 通用小组件：状态灯、页面头、JSON 展示块。

import { cn } from "@/lib/utils";

const STYLES: Record<string, string> = {
  success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  failed: "bg-red-500/10 text-red-400 border-red-500/30",
  running: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  queued: "bg-slate-500/10 text-slate-400 border-slate-500/30",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5",
      "font-mono text-[11px]",
      STYLES[status] ?? STYLES.queued)}>
      <span className={cn("size-1.5 rounded-full",
        status === "success" && "bg-emerald-400",
        status === "failed" && "bg-red-400",
        status === "running" && "bg-amber-400 animate-pulse",
        status === "queued" && "bg-slate-400")} />
      {status}
    </span>
  );
}

export function PageHead({ eyebrow, title, meta, right }:
  { eyebrow: string; title: string; meta?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between">
      <div>
        <div className="font-mono text-[11px] tracking-[0.2em] text-cyan-400 mb-1">
          {eyebrow}
        </div>
        <h2 className="text-xl font-semibold">{title}</h2>
        {meta && <p className="text-xs text-muted-foreground mt-1">{meta}</p>}
      </div>
      {right}
    </div>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="rounded-md bg-muted/50 border border-border p-3 text-xs
                    font-mono overflow-x-auto whitespace-pre-wrap break-all">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}
