/**
 * 领域徽标：运行状态、环境、触发类型、回归判定、停用、失败计数、记忆类型——全站一致的颜色与措辞。
 * 页面里不要再手写 tone→class 的状态图标、"N 失败"小红块或"已停用"文字：用这里的。
 */
import { type ReactNode } from "react";
import {
  LuBan, LuBookOpen, LuBot, LuCalendarClock, LuCircleCheck, LuCircleHelp, LuCircleMinus, LuCirclePause, LuCircleX, LuCode,
  LuFlaskConical, LuGlobe, LuHand, LuHistory, LuLightbulb, LuLoaderCircle, LuMessageSquare, LuRefreshCw, LuRotateCcw, LuShieldCheck, LuTerminal,
  LuTrendingDown, LuWebhook, LuWorkflow, LuZap,
} from "react-icons/lu";

import type { Env, KnowledgeKind, ReplayVerdict, Resolution, RunStatus, TickOutcome, TriggerType } from "@/api/types";
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

/** 紧凑状态点（表格、时间线、健康矩阵）。hint：悬停换成更完整的说明（"最近一次：失败 · 3 分钟前"） */
export function RunStatusDot({ status, hint }: { status: RunStatus; hint?: ReactNode }) {
  const s = RUN_STATUS[status];
  return (
    <Tooltip content={hint ?? s.label}>
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
  after: { label: "上游联动", icon: <LuWorkflow /> },
  retry: { label: "自动重试", icon: <LuRefreshCw /> },
};

/** 触发记录的判定结果：建了运行 / 为什么没建 */
export const TICK_OUTCOME: Record<TickOutcome, { label: string; tone: Tone }> = {
  fired: { label: "已触发", tone: "ok" },
  deduped: { label: "复用已有", tone: "neutral" },
  skipped: { label: "跳过", tone: "warn" },
  filtered: { label: "不满足过滤", tone: "idle" },
  waiting: { label: "等其它上游", tone: "info" },
  rejected: { label: "被拒", tone: "bad" },
  unmatched: { label: "没有任务接", tone: "warn" },
};

export function TickOutcomeBadge({ outcome, className }: { outcome: TickOutcome; className?: string }) {
  const o = TICK_OUTCOME[outcome] ?? { label: outcome, tone: "neutral" as Tone };
  return <Badge tone={o.tone} className={className}>{o.label}</Badge>;
}

/** 事件触发显示来源（dagster / gitlab）；上游联动的 source 是上游运行 id，显示「上游联动」 */
export function TriggerBadge({ type, source, className }: { type: TriggerType | string; source?: string | null; className?: string }) {
  const t = TRIGGER[type] ?? { label: type, icon: <LuZap /> };
  return <Badge tone="outline" icon={t.icon} className={className}>{source && type !== "after" ? `${source}` : t.label}</Badge>;
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

// ———————— 停用 / 失败计数 ————————

const DISABLED_LABEL = { service: "服务已停用", env: "该环境已停用", self: "已停用" } as const;

/**
 * 停用徽标：scope=service 服务整体停用；env 服务在某个环境停用；不给 = 对象自己停用（任务、子任务、方法、触发）。
 * 全站只用这一个写法，不再有「未启用」「已关闭」、纯文字 span 之类的变体。
 */
export function DisabledBadge({ scope = "self", hint, className }: { scope?: keyof typeof DISABLED_LABEL; hint?: ReactNode; className?: string }) {
  if (!hint) return <Badge tone="idle" icon={<LuBan />} className={className}>{DISABLED_LABEL[scope]}</Badge>;
  return <Tooltip content={hint} className={cn("shrink-0", className)}><Badge tone="idle" icon={<LuBan />}>{DISABLED_LABEL[scope]}</Badge></Tooltip>;
}

/** "3 失败"小红块：0 不显示。悬停说明数的是什么（默认近 24 小时） */
export function FailCount({ n, hint = "近 24 小时失败的运行", className }: { n: number | null | undefined; hint?: ReactNode; className?: string }) {
  if (!n) return null;
  // className 给外层（Tooltip 那层 span 才是父级 flex 里的一项：ml-auto 之类要落在它上面）
  return (
    <Tooltip content={hint} className={cn("shrink-0", className)}>
      <span className="inline-flex h-[18px] items-center rounded bg-bad-soft px-1 text-[11px] font-semibold tabular-nums leading-none text-bad">{n} 失败</span>
    </Tooltip>
  );
}

/** 反馈的问题类型（答错了、口径不对…）：红色胶囊。反馈条目、概览的负反馈共用 */
export function ReasonChip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-full bg-bad-soft px-2 py-0.5 text-[11px] leading-none text-bad", className)}>{children}</span>;
}

// ———————— 记忆 ————————

export const KNOWLEDGE_KIND: Record<KnowledgeKind, { label: string; tone: "neutral" | "accent" | "idle"; icon: ReactNode }> = {
  fact: { label: "事实", tone: "neutral", icon: <LuBookOpen /> },
  lesson: { label: "教训", tone: "accent", icon: <LuLightbulb /> },
  handoff: { label: "交接摘要", tone: "idle", icon: <LuHistory /> },
};

export function KindBadge({ kind, className }: { kind: KnowledgeKind; className?: string }) {
  const k = KNOWLEDGE_KIND[kind] ?? KNOWLEDGE_KIND.fact;
  return <Badge tone={k.tone} icon={k.icon} className={className}>{k.label}</Badge>;
}

/** 记忆的环境：空 = 对该服务所有环境成立 */
export function ScopeEnv({ env }: { env: string }) {
  return env ? <EnvBadge env={env} /> : <Badge tone="outline">所有环境</Badge>;
}
