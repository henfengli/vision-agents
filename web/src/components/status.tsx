/**
 * 领域徽标：运行状态、环境、触发类型、回归判定——全站一致的颜色与措辞。
 */
import { type ReactNode } from "react";
import {
  LuBan, LuBot, LuCalendarClock, LuCircleCheck, LuCircleHelp, LuCircleMinus, LuCirclePause, LuCircleX, LuCode,
  LuFlaskConical, LuGlobe, LuHand, LuLoaderCircle, LuMessageSquare, LuRotateCcw, LuShieldCheck, LuTerminal, LuTrendingDown,
  LuWebhook, LuZap,
} from "react-icons/lu";

import type { Env, ReplayVerdict, Resolution, RunStatus, TriggerType } from "@/api/types";
import { useEnvs } from "@/api/hooks";
import { cn } from "@/lib/cn";
import { Badge, type Tone } from "./ui/primitives";
import { Tooltip } from "./ui/overlay";

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone; icon: ReactNode }> = {
  queued: { label: "排队中", tone: "idle", icon: <LuCirclePause /> },
  running: { label: "运行中", tone: "info", icon: <LuLoaderCircle className="animate-spin" /> },
  success: { label: "成功", tone: "ok", icon: <LuCircleCheck /> },
  failed: { label: "失败", tone: "bad", icon: <LuCircleX /> },
  cancelled: { label: "已取消", tone: "idle", icon: <LuBan /> },
};

export function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  const s = RUN_STATUS[status];
  return <Badge tone={s.tone} icon={s.icon} className={className}>{s.label}</Badge>;
}

/** 紧凑状态点（表格、时间线） */
export function RunStatusDot({ status }: { status: RunStatus }) {
  const s = RUN_STATUS[status];
  return (
    <Tooltip content={s.label}>
      <span role="img" aria-label={s.label} className={cn("inline-flex size-4 items-center justify-center [&_svg]:size-3.5",
        { ok: "text-ok", bad: "text-bad", warn: "text-warn", info: "text-info", idle: "text-idle", neutral: "text-fg-3", accent: "text-accent", outline: "" }[s.tone])}>
        {s.icon}
      </span>
    </Tooltip>
  );
}

const ENV_TONE: Record<Env["color"], string> = {
  red: "bg-[color-mix(in_oklab,#ef4444_14%,transparent)] text-[#dc2626] dark:text-[#f87171]",
  amber: "bg-[color-mix(in_oklab,#f59e0b_16%,transparent)] text-[#b45309] dark:text-[#fbbf24]",
  blue: "bg-[color-mix(in_oklab,#3b82f6_14%,transparent)] text-[#2563eb] dark:text-[#60a5fa]",
  green: "bg-[color-mix(in_oklab,#22c55e_14%,transparent)] text-[#15803d] dark:text-[#4ade80]",
  violet: "bg-[color-mix(in_oklab,#8b5cf6_14%,transparent)] text-[#7c3aed] dark:text-[#a78bfa]",
  gray: "bg-sunken text-fg-2",
};

export function useEnvMeta(name: string | null | undefined): Env | undefined {
  const { data } = useEnvs();
  return data?.find((e) => e.name === name);
}

export function EnvBadge({ env, className }: { env: string | null | undefined; className?: string }) {
  const meta = useEnvMeta(env);
  if (!env) return <span className="text-fg-3">—</span>;
  return (
    <span title={meta ? `${meta.title || env}${meta.protected ? " · 受保护" : ""}` : undefined}
      className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 font-mono text-[11px] font-semibold uppercase leading-none tracking-wide", ENV_TONE[meta?.color ?? "gray"], className)}>
      {meta?.protected && <LuShieldCheck className="size-3" />}
      {env}
    </span>
  );
}

export const TRIGGER: Record<string, { label: string; icon: ReactNode }> = {
  api: { label: "API", icon: <LuCode /> },
  chat: { label: "对话", icon: <LuMessageSquare /> },
  schedule: { label: "定时", icon: <LuCalendarClock /> },
  event: { label: "事件", icon: <LuWebhook /> },
  web: { label: "网页", icon: <LuGlobe /> },
  rerun: { label: "重跑", icon: <LuRotateCcw /> },
  resume: { label: "续跑", icon: <LuRotateCcw /> },
  correction: { label: "纠正", icon: <LuHand /> },
  replay: { label: "回归重放", icon: <LuFlaskConical /> },
};

export function TriggerBadge({ type, source, className }: { type: TriggerType | string; source?: string | null; className?: string }) {
  const t = TRIGGER[type] ?? { label: type, icon: <LuZap /> };
  return <Badge tone="outline" icon={t.icon} className={className}>{source ? `${source}` : t.label}</Badge>;
}

export function ResolutionTag({ resolution }: { resolution: Resolution }) {
  if (!resolution || resolution === "agent") return null;
  const m = { rule: { label: "规则", icon: <LuZap /> }, builtin: { label: "内建", icon: <LuTerminal /> } }[resolution];
  return <Badge tone="accent" icon={m.icon}>{m.label}</Badge>;
}

/** 回归重放的判定：fixed 绿 / same 琥珀 / worse 红 / unclear、error 灰 / null 判定中 */
export const REPLAY_VERDICT: Record<ReplayVerdict | "pending", { label: string; tone: Tone; icon: ReactNode }> = {
  fixed: { label: "已改好", tone: "ok", icon: <LuCircleCheck /> },
  same: { label: "没改好", tone: "warn", icon: <LuCircleMinus /> },
  worse: { label: "更差", tone: "bad", icon: <LuTrendingDown /> },
  unclear: { label: "判断不了", tone: "idle", icon: <LuCircleHelp /> },
  error: { label: "没跑成", tone: "idle", icon: <LuCircleX /> },
  pending: { label: "判定中", tone: "info", icon: <LuLoaderCircle className="animate-spin" /> },
};

/** 原运行没被 👎 的条目：把原答案当参照，判定读作"有没有退步" */
export const REPLAY_VERDICT_REGRESSION: typeof REPLAY_VERDICT = {
  ...REPLAY_VERDICT,
  fixed: { ...REPLAY_VERDICT.fixed, label: "更好" },
  same: { label: "持平", tone: "idle", icon: <LuCircleMinus /> },
  worse: { ...REPLAY_VERDICT.worse, label: "退步" },
};

export function verdictMeta(verdict: ReplayVerdict | "pending" | null, regression = false) {
  return (regression ? REPLAY_VERDICT_REGRESSION : REPLAY_VERDICT)[verdict ?? "pending"];
}

export function VerdictBadge({ verdict, regression, className }: { verdict: ReplayVerdict | null; regression?: boolean; className?: string }) {
  const v = verdictMeta(verdict, regression);
  return <Badge tone={v.tone} icon={v.icon} className={className}>{v.label}</Badge>;
}

export function RoleChip({ role }: { role: string | null }) {
  if (!role) return <span className="text-fg-3">—</span>;
  return <span className="inline-flex items-center gap-1 text-[12.5px] text-fg-2"><LuBot className="size-3.5 text-fg-3" />{role}</span>;
}
