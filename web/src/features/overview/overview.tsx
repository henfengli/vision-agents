/**
 * 概览：一眼看全"现在平台怎么样"——运行量与成功率、服务×环境健康矩阵、
 * 失败聚焦、最近的负反馈、最近运行、即将触发的定时任务。全部受顶栏全局环境过滤。
 */
import { useState } from "react";
import {
  LuActivity, LuArrowRight, LuCalendarClock, LuCircleCheck, LuCircleX, LuCoins, LuLoaderCircle, LuPlay, LuServer, LuThumbsDown,
} from "react-icons/lu";

import { useEnvs, useFeedbackInbox, useMeta, useRuns, useServices, useStats, useTasks } from "@/api/hooks";
import type { Stats } from "@/api/types";
import { RunsChart } from "@/components/charts";
import { Page, PageHeader } from "@/components/layout/shell";
import { EnvBadge, RUN_STATUS, RunStatusDot } from "@/components/status";
import { Button, LinkButton } from "@/components/ui/button";
import { Segmented } from "@/components/ui/form";
import { Card, CardHeader, Empty, ErrorState, Skeleton, Stat } from "@/components/ui/primitives";
import { Tooltip } from "@/components/ui/overlay";
import { cn } from "@/lib/cn";
import { ago, dayjs, num, pct, until } from "@/lib/format";
import { Link } from "@/lib/router";
import { useUi } from "@/lib/store";
import { RunsTable } from "../runs/runs-table";
import { RunTaskDialog } from "../tasks/run-dialog";

/** 链接上带上当前的环境视角（"" = 全部环境） */
const withEnv = (path: string, env: string) => (env ? `${path}${path.includes("?") ? "&" : "?"}env=${encodeURIComponent(env)}` : path);

export function OverviewPage() {
  const { env } = useUi();
  const { data: envs } = useEnvs();
  const [hours, setHours] = useState<"24" | "72">("24");
  const { data: stats, error, refetch } = useStats({ hours: Number(hours), env: env || undefined });
  const { data: recent } = useRuns({ env, limit: 10 });
  const { data: tasks } = useTasks();
  const [runOpen, setRunOpen] = useState(false);
  const t = stats?.totals;
  const finished = t ? t.success + t.failed : 0;
  const envTitle = envs?.find((e) => e.name === env)?.title;
  const titleOf = (task: string) => tasks?.find((x) => x.name === task)?.title || task;
  const failedHref = withEnv(`/runs?status=failed&hours=${hours}`, env);

  return (
    <Page wide>
      <PageHeader title="概览" description={`近 ${hours === "24" ? "24 小时" : "3 天"} · ${env ? `${envTitle ?? env}（${env}）` : "全部环境"}`}
        actions={<>
          <Segmented size="sm" value={hours} onChange={setHours} options={[{ value: "24", label: "24 小时" }, { value: "72", label: "3 天" }]} />
          <Button variant="primary" icon={<LuPlay />} onClick={() => setRunOpen(true)}>运行任务</Button>
        </>} />

      {error && <Card className="mb-4"><ErrorState error={error} onRetry={refetch} className="py-8" /></Card>}
      <Card className="mb-4 grid grid-cols-2 divide-line sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
        {[
          <Stat key="a" icon={<LuActivity />} label="运行" value={t ? num(t.runs) : <Skeleton className="h-7 w-16" />} hint={stats && (Object.entries(stats.by_env).filter(([, v]) => v.runs).map(([k, v]) => `${k} ${num(v.runs)}`).join(" · ") || "没有运行")} />,
          <Stat key="b" icon={<LuCircleCheck />} label="成功率" value={t ? pct(t.success, finished) : <Skeleton className="h-7 w-14" />} tone={t && finished && t.success / finished < 0.85 ? "warn" : "ok"} hint={t && `${num(t.success)} / ${num(finished)} 已结束`} />,
          <Stat key="c" icon={<LuCircleX />} label="失败" value={t ? num(t.failed) : <Skeleton className="h-7 w-10" />} tone={t?.failed ? "bad" : undefined} hint={<Link to={failedHref} className="hover:text-accent">查看失败 →</Link>} />,
          <Stat key="d" icon={<LuLoaderCircle />} label="运行中" value={t ? num(t.running) : <Skeleton className="h-7 w-10" />} hint={<Link to={withEnv("/runs?status=running", env)} className="hover:text-accent">看运行中的 →</Link>} />,
          <Stat key="f" icon={<LuCoins />} label="Tokens" value={stats ? num(stats.tokens) : <Skeleton className="h-7 w-16" />} hint="模型用量" />,
        ].map((el, i) => <div key={i} className="min-w-0 px-5 py-4">{el}</div>)}
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-[1fr_360px]">
        {/* 图撑满卡片：和右边「即将触发」同高时底下不留空白 */}
        <Card className="flex flex-col">
          <CardHeader title="运行趋势" description="成功、失败与其他" actions={<Legend />} />
          <div className="flex min-h-[220px] flex-1 flex-col px-4 pb-3 pt-4">
            {stats ? <RunsChart data={stats.series} className="min-h-0 flex-1" /> : <Skeleton className="min-h-0 flex-1" />}
          </div>
        </Card>
        <Upcoming stats={stats} />
      </div>

      <HealthMatrix />

      {/* 两张卡同高（宽屏），列表在卡片里滚动：条数不同也不会有一张底下空一大截 */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card className={ROW_CARD}>
          <CardHeader title="失败聚焦" description="按任务汇总，带最近一次的错误" actions={<LinkButton to={failedHref} size="xs" variant="ghost">全部 <LuArrowRight /></LinkButton>} />
          {!stats ? <div className="p-4"><Skeleton className="h-24" /></div> : stats.top_failures.length === 0 ? (
            <Empty icon={<LuCircleCheck className="text-ok" />} title="没有失败" description={`近 ${hours === "24" ? "24 小时" : "3 天"}全部成功`} />
          ) : (
            <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
              {stats.top_failures.map((f) => (
                <li key={f.task + f.service}>
                  <Link to={withEnv(`/runs?status=failed&hours=${hours}&task=${encodeURIComponent(f.task)}${f.service ? "&service=" + encodeURIComponent(f.service) : ""}`, env)} className="block px-4 py-2.5 hover:bg-hover/70">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 truncate text-[13px] font-medium text-fg" title={f.task}>{titleOf(f.task)}</span>
                      <span className="shrink-0 text-xs text-fg-3">{f.service ?? "平台任务"}</span>
                      <span className="ml-auto shrink-0 rounded bg-bad-soft px-1.5 text-[11.5px] font-semibold tabular-nums text-bad">{f.failed} 次</span>
                    </div>
                    <div className="mt-1 line-clamp-2 break-all font-mono text-[11.5px] text-fg-3" title={f.last_error || undefined}>{f.last_error || "—"}</div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <RecentNegative env={env} titleOf={titleOf} />
      </div>

      <Card className="mt-4">
        <CardHeader title="最近运行" actions={<LinkButton to={withEnv("/runs", env)} size="xs" variant="ghost">全部 <LuArrowRight /></LinkButton>} />
        <RunsTable runs={recent?.items} loading={!recent} compact columns={["status", "task", "service", "env", "time"]}
          empty={<div className="px-4 py-6 text-center text-xs text-fg-3">暂无运行</div>} />
      </Card>

      <RunTaskDialog open={runOpen} onClose={() => setRunOpen(false)} />
    </Page>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-[11.5px] text-fg-3">
      <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-ok" />成功</span>
      <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-bad" />失败</span>
      <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-info/60" />其他</span>
    </div>
  );
}

const UPCOMING_MAX = 6;
/** 底下两张并排的卡片：宽屏同高，内容在卡片里滚动 */
const ROW_CARD = "flex flex-col lg:h-[380px]";

const dayLabel = (at: string) => dayjs(at).isSame(dayjs(), "day") ? "今天" : dayjs(at).isSame(dayjs().add(1, "day"), "day") ? "明天" : dayjs(at).format("MM-DD");

function Upcoming({ stats }: { stats: Stats | undefined }) {
  const items = stats?.upcoming;
  const shown = items?.slice(0, UPCOMING_MAX) ?? [];
  const more = (stats?.upcoming_total ?? 0) - shown.length;
  return (
    <Card className="flex flex-col">
      <CardHeader title="即将触发" icon={<LuCalendarClock />} description="接下来的定时运行（不含夜间维护）" />
      {!items ? <div className="p-4"><Skeleton className="h-32" /></div> : items.length === 0 ? (
        <Empty title="没有定时任务" />
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((u) => (
            <li key={`${u.task}/${u.trigger_id}/${u.env}`}>
              <Link to={`/tasks/${encodeURIComponent(u.task)}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-hover/70">
                <div className="w-[52px] shrink-0 text-center">
                  <div className="text-[13px] font-semibold tabular-nums text-fg">{dayjs(u.at).format("HH:mm")}</div>
                  <div className="text-[10.5px] text-fg-3">{dayLabel(u.at)}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-fg" title={u.task}>{u.task_title || u.task}</div>
                  <div className="truncate text-[11.5px] text-fg-3">{u.service ?? "平台任务"} · {until(u.at)}</div>
                </div>
                <EnvBadge env={u.env} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to="/tasks?trigger=schedule" className="mt-auto border-t border-line px-4 py-2 text-center text-[12px] text-fg-3 hover:text-accent">
        {more > 0 ? `还有 ${more} 次 · ` : ""}看全部定时任务
      </Link>
    </Card>
  );
}

/** 服务×环境健康矩阵：最近一次运行、近 24 小时运行 / 失败（固定 24 小时，不跟页面上的时间范围） */
function HealthMatrix() {
  const { data: services } = useServices({ refetchInterval: 30_000 });
  const { data: envs } = useEnvs();
  const { env: focus } = useUi();
  const cols = envs ?? [];
  return (
    <Card>
      <CardHeader title="服务健康 · 近 24 小时" icon={<LuServer />} description="每个服务在各环境的最近一次运行、运行次数和失败"
        actions={<LinkButton to="/services" size="xs" variant="ghost">管理服务 <LuArrowRight /></LinkButton>} />
      {!services ? <div className="p-4"><Skeleton className="h-40" /></div> : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="h-9 border-b border-line px-4 text-left text-[11.5px] font-medium text-fg-3">服务</th>
                {cols.map((e) => <th key={e.name} className={cn("h-9 border-b border-l border-line px-3 text-left", focus && focus !== e.name && "opacity-50")}><EnvBadge env={e.name} /></th>)}
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.name} className={cn("group", !s.enabled && "opacity-70")}>
                  <td className="border-b border-line px-4 py-2.5">
                    <Link to={`/services/${s.name}`} className="flex items-center gap-2.5">
                      <ServiceAvatar name={s.name} disabled={!s.enabled} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 truncate font-medium text-fg group-hover:text-accent">{s.title || s.name}
                          {!s.enabled && <span className="text-[11px] font-normal text-fg-3">服务已停用</span>}
                        </div>
                        <div className="text-[11.5px] text-fg-3">{s.name} · {s.task_count} 个专属任务{s.generic_task_count ? ` · ${s.generic_task_count} 个通用` : ""}</div>
                      </div>
                    </Link>
                  </td>
                  {cols.map((e) => {
                    const h = s.health[e.name];
                    // 只看该环境自己的开关；服务整体停用在服务名旁边说一次
                    if (h && !h.env_enabled) return (
                      <td key={e.name} className="border-b border-l border-line px-3 py-2 text-[11.5px] text-fg-3">
                        <Link to={`/services/${s.name}?tab=envs`} className="block rounded-md px-1.5 py-1 hover:bg-hover">该环境未启用</Link>
                      </td>
                    );
                    const last = h?.last_run;
                    const st = last ? RUN_STATUS[last.status] : null;
                    return (
                      <td key={e.name} className={cn("border-b border-l border-line px-3 py-2", focus && focus !== e.name && "opacity-50")}>
                        <Link to={`/services/${s.name}?env=${e.name}`} className="block rounded-md px-1.5 py-1 hover:bg-hover">
                          <div className="flex items-center gap-1.5">
                            {st ? (
                              <Tooltip content={`最近一次：${st.label} · ${ago(last!.created_at)}`}>
                                <span className={cn("inline-flex [&_svg]:size-3.5", { ok: "text-ok", bad: "text-bad", warn: "text-warn", info: "text-info", idle: "text-idle", neutral: "", accent: "", outline: "" }[st.tone])}>{st.icon}</span>
                              </Tooltip>
                            ) : <span className="size-3.5 rounded-full border border-dashed border-line-strong" title="还没有运行" />}
                            <span className="tabular-nums text-fg">{h?.runs_24h ?? 0}</span>
                            <span className="text-[11.5px] text-fg-3">次</span>
                            {!!h?.failed_24h && <span className="rounded bg-bad-soft px-1 text-[11px] font-semibold tabular-nums text-bad">{h.failed_24h} 失败</span>}
                          </div>
                        </Link>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** 最近 3 天的负反馈：agent 最近哪里做得不好，点进去看现场 */
function RecentNegative({ env, titleOf }: { env: string; titleOf: (task: string) => string }) {
  const { data, error } = useFeedbackInbox({ score: -1, env: env || undefined, hours: 72 });
  const { data: meta } = useMeta();
  const reason = (r: string) => meta?.feedback_reasons.find((x) => x.value === r)?.label ?? r;
  return (
    <Card className={ROW_CARD}>
      <CardHeader title="最近的负反馈" icon={<LuThumbsDown />} description="近 3 天有人点了 👎 的运行"
        actions={<LinkButton to="/runs?view=feedback" size="xs" variant="ghost">全部 <LuArrowRight /></LinkButton>} />
      {error ? <div className="px-4 py-6 text-center text-xs text-bad">加载失败：{error.message}</div>
        : !data ? <div className="p-4"><Skeleton className="h-24" /></div> : data.length === 0 ? (
          <Empty icon={<LuCircleCheck className="text-ok" />} title="没有负反馈" description="近 3 天没有人点 👎" />
        ) : (
          <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
            {data.slice(0, 12).map((f) => (
              <li key={`${f.run_id}/${f.step_seq}/${f.created_by}`}>
                <Link to={`/runs/${f.run_id}`} className="block px-4 py-2.5 hover:bg-hover/70">
                  <div className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
                    <RunStatusDot status={f.run_status} />
                    <span className="min-w-0 truncate text-fg-2" title={f.task}>{titleOf(f.task.split(":")[0])}</span>
                    {f.service && <span className="shrink-0">{f.service}</span>}
                    <EnvBadge env={f.env} />
                    <span className="ml-auto shrink-0">{f.created_by} · {ago(f.updated_at)}</span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-[12.5px] text-fg" title={f.summary}>{f.summary}</div>
                  {(f.reasons.length > 0 || f.comment) && (
                    <div className="mt-0.5 line-clamp-2 text-[11.5px] text-bad" title={f.comment || undefined}>
                      {[f.reasons.map(reason).join("、"), f.comment].filter(Boolean).join("：")}
                    </div>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
}

const AVATAR_COLORS = ["bg-[#6366f1]", "bg-[#0ea5e9]", "bg-[#10b981]", "bg-[#f59e0b]", "bg-[#ec4899]", "bg-[#8b5cf6]", "bg-[#14b8a6]"];

/** 服务的首字母头像：取最后一段（vision-board → B），同前缀的服务也分得开 */
export function ServiceAvatar({ name, disabled, className }: { name: string; disabled?: boolean; className?: string }) {
  const color = AVATAR_COLORS[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
  const initial = (name.split(/[-_.]/).filter(Boolean).pop() ?? name).slice(0, 1);
  return (
    <span aria-hidden className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-md text-[12px] font-bold uppercase text-white", disabled ? "bg-idle" : color, className)}>
      {initial}
    </span>
  );
}
