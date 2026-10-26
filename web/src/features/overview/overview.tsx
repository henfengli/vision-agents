/**
 * 概览：一眼看全"现在平台怎么样"——运行量与成功率、服务×环境健康矩阵、
 * 失败聚焦、最近运行、最近的 👎、即将触发的定时任务。全部受顶栏全局环境过滤。
 */
import { useState } from "react";
import {
  LuActivity, LuArrowRight, LuCalendarClock, LuCircleCheck, LuCircleX, LuCoins, LuLoaderCircle, LuPlay, LuServer, LuThumbsDown,
} from "react-icons/lu";

import { useEnvs, useFeedbackInbox, useMeta, useRuns, useServices, useStats } from "@/api/hooks";
import type { UpcomingFire } from "@/api/types";
import { RunsChart } from "@/components/charts";
import { Page, PageHeader } from "@/components/layout/shell";
import { EnvBadge, NodeChip, RUN_STATUS, RunStatusDot } from "@/components/status";
import { Button, LinkButton } from "@/components/ui/button";
import { Segmented } from "@/components/ui/form";
import { Card, CardHeader, Empty, ErrorState, Skeleton, Stat } from "@/components/ui/primitives";
import { Tooltip } from "@/components/ui/overlay";
import { cn } from "@/lib/cn";
import { ago, dayjs, num, pct, until } from "@/lib/format";
import { Link } from "@/lib/router";
import { useUi } from "@/lib/store";
import { RunMiniList } from "../runs/runs-table";
import { RunTaskDialog } from "../tasks/run-dialog";

export function OverviewPage() {
  const { env } = useUi();
  const { data: envs } = useEnvs();
  const [hours, setHours] = useState<"24" | "72">("24");
  const { data: stats, error, refetch } = useStats({ hours: Number(hours), env: env || undefined });
  const { data: recent } = useRuns({ env, limit: 8 });
  const [runOpen, setRunOpen] = useState(false);
  const t = stats?.totals;
  const finished = t ? t.success + t.failed : 0;
  const envTitle = envs?.find((e) => e.name === env)?.title;

  return (
    <Page wide>
      <PageHeader title="概览" description={`近 ${hours} 小时 · ${env ? `${envTitle ?? env}（${env}）` : "全部环境"}`}
        actions={<>
          <Segmented size="sm" value={hours} onChange={setHours} options={[{ value: "24", label: "24 小时" }, { value: "72", label: "3 天" }]} />
          <Button variant="primary" icon={<LuPlay />} onClick={() => setRunOpen(true)}>运行任务</Button>
        </>} />

      {error && <Card className="mb-4"><ErrorState error={error} onRetry={refetch} className="py-8" /></Card>}
      <Card className="mb-4 grid grid-cols-2 divide-line sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
        {[
          <Stat key="a" icon={<LuActivity />} label="运行" value={t ? num(t.runs) : <Skeleton className="h-7 w-16" />} hint={stats && (Object.entries(stats.by_env).filter(([, v]) => v.runs).map(([k, v]) => `${k} ${num(v.runs)}`).join(" · ") || "没有运行")} />,
          <Stat key="b" icon={<LuCircleCheck />} label="成功率" value={t ? pct(t.success, finished) : <Skeleton className="h-7 w-14" />} tone={t && finished && t.success / finished < 0.85 ? "warn" : "ok"} hint={t && `${num(t.success)} / ${num(finished)} 已结束`} />,
          <Stat key="c" icon={<LuCircleX />} label="失败" value={t ? num(t.failed) : <Skeleton className="h-7 w-10" />} tone={t?.failed ? "bad" : undefined} hint={<Link to={`/runs?status=failed&hours=${hours}`} className="hover:text-accent">查看失败 →</Link>} />,
          <Stat key="d" icon={<LuLoaderCircle />} label="运行中" value={t ? num(t.running) : <Skeleton className="h-7 w-10" />} hint={<Link to="/runs?status=running" className="hover:text-accent">看运行中的 →</Link>} />,
          <Stat key="f" icon={<LuCoins />} label="Tokens" value={stats ? num(stats.tokens) : <Skeleton className="h-7 w-16" />} hint="模型用量" />,
        ].map((el, i) => <div key={i} className="min-w-0 px-5 py-4">{el}</div>)}
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader title="运行趋势" description="按小时统计：成功 / 失败 / 进行中与其他" actions={<Legend />} />
          <div className="px-4 pb-3 pt-4">{stats ? <RunsChart data={stats.series} height={180} /> : <Skeleton className="h-[180px]" />}</div>
        </Card>
        <Upcoming items={stats?.upcoming} />
      </div>

      <HealthMatrix />

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1fr_360px]">
        <Card>
          <CardHeader title="失败聚焦" description="按任务聚合，最近一次的错误" actions={<LinkButton to={`/runs?status=failed&hours=${hours}`} size="xs" variant="ghost">全部 <LuArrowRight /></LinkButton>} />
          {!stats ? <div className="p-4"><Skeleton className="h-24" /></div> : stats.top_failures.length === 0 ? (
            <Empty icon={<LuCircleCheck className="text-ok" />} title="没有失败" description={`近 ${hours} 小时全部成功`} />
          ) : (
            <ul className="divide-y divide-line">
              {stats.top_failures.map((f) => (
                <li key={f.task + f.service}>
                  <Link to={`/runs?status=failed&task=${encodeURIComponent(f.task)}${f.service ? "&service=" + f.service : ""}`} className="block px-4 py-2.5 hover:bg-hover/70">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-fg">{f.task}</span>
                      {f.service && <span className="truncate text-xs text-fg-3">{f.service}</span>}
                      <span className="ml-auto shrink-0 rounded bg-bad-soft px-1.5 text-[11.5px] font-semibold tabular-nums text-bad">{f.failed}</span>
                    </div>
                    <div className="mt-1 truncate font-mono text-[11.5px] text-fg-3" title={f.last_error || undefined}>{f.last_error || "—"}</div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="最近运行" actions={<LinkButton to="/runs" size="xs" variant="ghost">全部 <LuArrowRight /></LinkButton>} />
          <RunMiniList runs={recent?.items} limit={7} />
        </Card>
        <RecentNegative env={env} />
      </div>

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

function Upcoming({ items }: { items: UpcomingFire[] | undefined }) {
  return (
    <Card>
      <CardHeader title="即将触发" icon={<LuCalendarClock />} description="定时任务的下一次运行（按环境展开）" />
      {!items ? <div className="p-4"><Skeleton className="h-32" /></div> : items.length === 0 ? (
        <Empty title="没有定时任务" />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((u) => (
            <li key={`${u.task}/${u.trigger_id}/${u.env}`}>
              <Link to={`/tasks/${encodeURIComponent(u.task)}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-hover/70">
                <div className="w-[52px] text-center">
                  <div className="text-[13px] font-semibold tabular-nums text-fg">{dayjs(u.at).format("HH:mm")}</div>
                  <div className="text-[10.5px] text-fg-3">{dayjs(u.at).isSame(dayjs(), "day") ? "今天" : dayjs(u.at).isSame(dayjs().add(1, "day"), "day") ? "明天" : dayjs(u.at).format("MM-DD")}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-fg">{u.task}</div>
                  <div className="text-[11.5px] text-fg-3">{u.service ?? "平台任务"} · {until(u.at)}</div>
                </div>
                <EnvBadge env={u.env} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** 服务×环境健康矩阵：最近一次运行、24h 运行/失败、部署节点在不在线 */
function HealthMatrix() {
  const { data: services } = useServices({ refetchInterval: 30_000 });
  const { data: envs } = useEnvs();
  const { env: focus } = useUi();
  const cols = envs ?? [];
  return (
    <Card>
      <CardHeader title="服务健康" icon={<LuServer />} description="每格是一个 服务×环境：最近一次运行、近 24 小时运行与失败、部署节点在不在线"
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
                <tr key={s.name} className="group">
                  <td className="border-b border-line px-4 py-2.5">
                    <Link to={`/services/${s.name}`} className="flex items-center gap-2.5">
                      <ServiceAvatar name={s.name} disabled={!s.enabled} />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-fg group-hover:text-accent">{s.title}</div>
                        <div className="text-[11.5px] text-fg-3">{s.name} · {s.task_count} 个任务{!s.enabled && " · 已停用"}</div>
                      </div>
                    </Link>
                  </td>
                  {cols.map((e) => {
                    const h = s.health[e.name];
                    if (h && !h.enabled) return (
                      <td key={e.name} className="border-b border-l border-line px-3 py-2 text-[11.5px] text-fg-3">
                        <Link to={`/services/${s.name}?tab=envs`} className="block rounded-md px-1.5 py-1 hover:bg-hover">未启用</Link>
                      </td>
                    );
                    const last = h?.last_run;
                    const st = last ? RUN_STATUS[last.status] : null;
                    return (
                      <td key={e.name} className={cn("border-b border-l border-line px-3 py-2", focus && focus !== e.name && "opacity-50")}>
                        <Link to={`/services/${s.name}?env=${e.name}`} className="block rounded-md px-1.5 py-1 hover:bg-hover">
                          <div className="flex items-center gap-1.5">
                            {st ? (
                              <Tooltip content={`最近：${st.label} · ${ago(last!.created_at)}`}>
                                <span className={cn("inline-flex [&_svg]:size-3.5", { ok: "text-ok", bad: "text-bad", warn: "text-warn", info: "text-info", idle: "text-idle", neutral: "", accent: "", outline: "" }[st.tone])}>{st.icon}</span>
                              </Tooltip>
                            ) : <span className="size-3.5 rounded-full border border-dashed border-line-strong" />}
                            <span className="tabular-nums text-fg">{h?.runs_24h ?? 0}</span>
                            <span className="text-[11.5px] text-fg-3">次</span>
                            {!!h?.failed_24h && <span className="rounded bg-bad-soft px-1 text-[11px] font-semibold tabular-nums text-bad">{h.failed_24h} 失败</span>}
                          </div>
                          <div className="mt-0.5 min-w-0 text-[11.5px]">
                            <NodeChip name={h?.node} online={h?.node_online} className="text-[11.5px]" />
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

/** 最近 3 天的 👎：agent 最近哪里做得不好，点进去看现场 */
function RecentNegative({ env }: { env: string }) {
  const { data, error } = useFeedbackInbox({ score: -1, env: env || undefined, hours: 72 });
  const { data: meta } = useMeta();
  const reason = (r: string) => meta?.feedback_reasons.find((x) => x.value === r)?.label ?? r;
  return (
    <Card>
      <CardHeader title="最近的 👎" icon={<LuThumbsDown />} description="近 3 天对运行或某一步的负反馈"
        actions={<LinkButton to="/runs?view=feedback" size="xs" variant="ghost">反馈 <LuArrowRight /></LinkButton>} />
      {error ? <div className="px-4 py-6 text-center text-xs text-bad">加载失败：{error.message}</div>
        : !data ? <div className="p-4"><Skeleton className="h-24" /></div> : data.length === 0 ? (
          <Empty icon={<LuCircleCheck className="text-ok" />} title="没有负反馈" description="近 3 天没有人点 👎" />
        ) : (
          <ul className="divide-y divide-line">
            {data.slice(0, 6).map((f) => (
              <li key={`${f.run_id}/${f.step_seq}/${f.created_by}`}>
                <Link to={`/runs/${f.run_id}`} className="block px-4 py-2.5 hover:bg-hover/70">
                  <div className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
                    <RunStatusDot status={f.run_status} />
                    <span className="truncate font-mono">{f.task}</span>
                    <EnvBadge env={f.env} />
                    <span className="ml-auto shrink-0">{f.created_by} · {ago(f.updated_at)}</span>
                  </div>
                  <div className="mt-1 truncate text-[12.5px] text-fg" title={f.summary}>{f.summary}</div>
                  {(f.reasons.length > 0 || f.comment) && (
                    <div className="mt-0.5 truncate text-[11.5px] text-bad" title={f.comment || undefined}>
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
