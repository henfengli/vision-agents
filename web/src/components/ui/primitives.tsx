/**
 * 基础展示件：卡片、徽标、空态、加载、骨架、键帽、指标块。
 */
import { type HTMLAttributes, type ReactNode } from "react";
import { LuCircleAlert, LuLoaderCircle } from "react-icons/lu";

import { cn } from "@/lib/cn";
import { Button } from "./button";

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("min-w-0 rounded-lg border border-line bg-panel shadow-[var(--shadow-card)]", className)} {...p} />;
}

export function CardHeader({ title, description, actions, className, icon }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string; icon?: ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-3 border-b border-line px-4 py-3", className)}>
      {icon && <div className="mt-0.5 text-fg-3 [&_svg]:size-4">{icon}</div>}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-fg">{title}</div>
        {description && <div className="mt-0.5 text-xs text-fg-3">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

const tones = {
  neutral: "bg-sunken text-fg-2 border-line",
  accent: "bg-accent-soft text-accent border-transparent",
  ok: "bg-ok-soft text-ok border-transparent",
  bad: "bg-bad-soft text-bad border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  info: "bg-info-soft text-info border-transparent",
  idle: "bg-idle-soft text-idle border-transparent",
  outline: "bg-transparent text-fg-2 border-line",
} as const;
export type Tone = keyof typeof tones;

export function Badge({ tone = "neutral", className, children, icon, ...p }: { tone?: Tone; icon?: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[11.5px] font-medium leading-none whitespace-nowrap [&_svg]:size-3", tones[tone], className)} {...p}>
      {icon}
      {children}
    </span>
  );
}

export function Dot({ tone = "idle", pulse, className }: { tone?: Exclude<Tone, "outline" | "neutral"> | "neutral"; pulse?: boolean; className?: string }) {
  const color = { neutral: "bg-fg-3", accent: "bg-accent", ok: "bg-ok", bad: "bg-bad", warn: "bg-warn", info: "bg-info", idle: "bg-idle" }[tone];
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", color, pulse && "animate-pulse-dot", className)} />;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line bg-sunken px-1 font-mono text-[10.5px] text-fg-3", className)}>{children}</kbd>;
}

export function Spinner({ className }: { className?: string }) {
  return <LuLoaderCircle className={cn("size-4 animate-spin text-fg-3", className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-sunken", className)} />;
}

export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2.5 p-4", className)}>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-5" />)}
    </div>
  );
}

export function Empty({ icon, title, description, action, className }: {
  icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {icon && <div className="mb-3 flex size-10 items-center justify-center rounded-lg border border-line bg-sunken text-fg-3 [&_svg]:size-5">{icon}</div>}
      <div className="text-[13px] font-medium text-fg">{title}</div>
      {description && <div className="mt-1 max-w-sm text-xs text-fg-3">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: Error; onRetry?: () => void; className?: string }) {
  return (
    <Empty
      className={className}
      icon={<LuCircleAlert className="text-bad" />}
      title="加载失败"
      description={error.message}
      action={onRetry && <Button size="sm" onClick={onRetry}>重试</Button>}
    />
  );
}

export function Stat({ label, value, hint, tone, className, icon }: {
  label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "ok" | "bad" | "warn" | "accent"; className?: string; icon?: ReactNode;
}) {
  const color = tone ? { ok: "text-ok", bad: "text-bad", warn: "text-warn", accent: "text-accent" }[tone] : "text-fg";
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-center gap-1.5 text-xs text-fg-3 [&_svg]:size-3.5">{icon}{label}</div>
      <div className={cn("mt-1 text-[22px] font-semibold tabular-nums leading-tight tracking-tight", color)}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-fg-3">{hint}</div>}
    </div>
  );
}

/** 键值清单（详情页右栏常用） */
export function DescList({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(84px,auto)_1fr] gap-x-4 gap-y-2 text-[12.5px]", className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-fg-3">{k}</dt>
          <dd className="min-w-0 break-words text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SectionTitle({ children, actions, className }: { children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-2 flex items-center justify-between gap-2", className)}>
      <div className="text-[11.5px] font-semibold uppercase tracking-wider text-fg-3">{children}</div>
      {actions}
    </div>
  );
}
