/**
 * 概览：一眼看全"现在平台怎么样"——运行量与成功率、服务×环境健康矩阵、
 * 失败聚焦、最近的负反馈、最近运行、即将触发的定时任务。全部受顶栏全局环境过滤。
 */
import { useState } from "react";
import {
  LuActivity, LuArrowRight, LuCalendarClock, LuCircleCheck, LuCircleX, LuCoins, LuCpu, LuLoaderCircle, LuPlay, LuServer, LuServerOff, LuThumbsDown,
} from "react-icons/lu";

import { useEnvs, useFeedbackInbox, useMeta, useRuns, useServices, useStats, useTasks, useWorkers } from "@/api/hooks";
import type { Stats, StatsPoint } from "@/api/types";
import { RunsChart, RunsLegend } from "@/components/charts";
import { Page, PageHeader } from "@/components/layout/shell";
import { DisabledBadge, EnvBadge, FailCount, RUN_STATUS, ReasonChip, RunStatusDot } from "@/components/status";
import { TimeAgo, TimeUntil } from "@/components/time";
import { Button, LinkButton } from "@/components/ui/button";
import { Segmented } from "@/components/ui/form";
import { Card, CardHeader, Empty, ErrorState, Skeleton, Stat } from "@/components/ui/primitives";
import { Tooltip } from "@/components/ui/overlay";
import { cn } from "@/lib/cn";
import { ago, num, pct, slot } from "@/lib/format";
import { Link, navigate } from "@/lib/router";
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
  const { data: recent, error: recentError, refetch: refetchRecent } = useRuns({ env, limit: 10 });
  /** 靠 stats 的卡片：stats 出错时卡片里也给错误态，不能一直转骨架（顶部的错误条只说一次） */
  const statsFailed = !!error && !stats;
  const retryStats = () => void refetch();
  const { data: tasks } = useTasks();
  const [runOpen, setRunOpen] = useState(false);
  const t = stats?.totals;
  const finished = t ? t.success + t.failed : 0;
  const envTitle = envs?.find((e) => e.name === env)?.title;
  const titleOf = (task: string) => tasks?.find((x) => x.name === task)?.title || task;
  const failedHref = withEnv(`/runs?status=failed&hours=${hours}`, env);
  /** 点趋势图的一根柱子：看那段时间发起的运行；最后一根不封口（之后新发起的也算这一段） */
  const openSlot = (p: StatsPoint, last: boolean) => {
    const q = new URLSearchParams({ since: new Date(p.t).toISOString() });
    if (!last) q.set("until", new Date(p.end).toISOString());
    navigate(withEnv(`/runs?${q}`, env));
  };

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
          <CardHeader title="运行趋势" actions={<RunsLegend />}
            description={`按发起时间，${stats && stats.series_step_s !== 3600 ? `每 ${stats.series_step_s / 3600} 小时` : "每小时"}一根，最右一根到现在为止；点柱子看那段时间的运行`} />
          <div className="flex min-h-[220px] flex-1 flex-col px-4 pb-3 pt-4">
            {stats ? <RunsChart data={stats.series} step={stats.series_step_s} onSelect={openSlot} className="min-h-0 flex-1" />
              : statsFailed ? <ErrorState error={error!} onRetry={retryStats} className="py-6" /> : <Skeleton className="min-h-0 flex-1" />}
          </div>
        </Card>
        <Upcoming stats={stats} error={statsFailed ? error : undefined} onRetry={retryStats} />
      </div>

      <HealthMatrix />

      <HostsCard env={env} />

      {/* 两张卡同高（宽屏），列表在卡片里滚动：条数不同也不会有一张底下空一大截 */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card className={ROW_CARD}>
          <CardHeader title="失败聚焦" description="按任务汇总，带最近一次的错误" actions={<LinkButton to={failedHref} size="xs" variant="ghost">全部 <LuArrowRight /></LinkButton>} />
          {statsFailed ? <ErrorState error={error!} onRetry={retryStats} className="py-6" />
            : !stats ? <div className="p-4"><Skeleton className="h-24" /></div> : stats.top_failures.length === 0 ? (
            <Empty icon={<LuCircleCheck className="text-ok" />} title="没有失败" description={`近 ${hours === "24" ? "24 小时" : "3 天"}全部成功`} />
          ) : (
            <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
              {stats.top_failures.map((f) => (
                <li key={f.task + f.service}>
                  <Link to={withEnv(`/runs?status=failed&hours=${hours}&task=${encodeURIComponent(f.task)}${f.service ? "&service=" + encodeURIComponent(f.service) : ""}`, env)} className="block px-4 py-2.5 hover:bg-hover/70">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 truncate text-[13px] font-medium text-fg" title={f.task}>{titleOf(f.task)}</span>
                      <span className="shrink-0 text-xs text-fg-3">{f.service ?? "平台任务"}</span>
                      <FailCount n={f.failed} hint={`近 ${hours === "24" ? "24 小时" : "3 天"}失败 ${f.failed} 次`} className="ml-auto" />
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
        {recentError && !recent ? <ErrorState error={recentError} onRetry={() => void refetchRecent()} className="py-6" />
          : <RunsTable runs={recent?.items} loading={!recent} compact columns={["status", "task", "service", "env", "time"]}
              empty={<Empty icon={<LuActivity />} title="还没有运行" className="py-6" />} />}
      </Card>

      <RunTaskDialog open={runOpen} onClose={() => setRunOpen(false)} />
    </Page>
  );
}

const UPCOMING_MAX = 6;
/** 底下两张并排的卡片：宽屏同高，内容在卡片里滚动 */
const ROW_CARD = "flex flex-col lg:h-[380px]";

function Upcoming({ stats, error, onRetry }: { stats: Stats | undefined; error?: Error; onRetry: () => void }) {
  const items = stats?.upcoming;
  const shown = items?.slice(0, UPCOMING_MAX) ?? [];
  const more = (stats?.upcoming_total ?? 0) - shown.length;
  return (
    <Card className="flex flex-col">
      {/* 「全部 →」放卡片头，和其它卡片一样；还有多少次写进说明 */}
      <CardHeader title="即将触发" icon={<LuCalendarClock />} description={`接下来的定时运行（不含夜间维护）${more > 0 ? ` · 还有 ${more} 次` : ""}`}
        actions={<LinkButton to="/tasks?trigger=schedule" size="xs" variant="ghost">全部 <LuArrowRight /></LinkButton>} />
      {error ? <ErrorState error={error} onRetry={onRetry} className="py-6" /> : !items ? <div className="p-4"><Skeleton className="h-32" /></div> : items.length === 0 ? (
        <Empty title="没有即将触发的定时运行" />
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((u) => {
            // 和任务详情、编辑器的定时预览同一种写法（今天 / 明天 / MM-DD + HH:mm），这里拆成两行
            const [day, time] = slot(u.at).split(" ");
            return (
              <li key={`${u.task}/${u.trigger_id}/${u.env}`}>
                <Link to={`/tasks/${encodeURIComponent(u.task)}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-hover/70">
                  <div className="w-[52px] shrink-0 text-center">
                    <div className="text-[13px] font-semibold tabular-nums text-fg">{time}</div>
                    <div className="text-[10.5px] text-fg-3">{day}</div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-fg" title={u.task}>{u.task_title || u.task}</div>
                    <div className="truncate text-[11.5px] text-fg-3">{u.service ?? "平台任务"} · <TimeUntil at={u.at} /></div>
                  </div>
                  <EnvBadge env={u.env} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** 服务×环境健康矩阵：最近一次运行、近 24 小时运行 / 失败（固定 24 小时，不跟页面上的时间范围） */
function HealthMatrix() {
  const { data: services, error, refetch } = useServices({ refetchInterval: 30_000 });
  const { data: envs } = useEnvs();
  const { env: focus } = useUi();
  const cols = envs ?? [];
  return (
    <Card>
      <CardHeader title="服务健康 · 近 24 小时" icon={<LuServer />} description="每个服务在各环境的最近一次运行、运行次数和失败"
        actions={<LinkButton to="/services" size="xs" variant="ghost">全部 <LuArrowRight /></LinkButton>} />
      {error && !services ? <ErrorState error={error} onRetry={() => void refetch()} className="py-6" />
        : !services ? <div className="p-4"><Skeleton className="h-40" /></div>
          : !services.length ? <Empty icon={<LuServer />} title="还没有服务" className="py-6" action={<LinkButton size="sm" to="/services">去新建</LinkButton>} /> : (
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
                          {!s.enabled && <DisabledBadge scope="service" />}
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
                        <Link to={`/services/${s.name}?tab=envs`} className="block rounded-md px-1.5 py-1 hover:bg-hover"><DisabledBadge scope="env" /></Link>
                      </td>
                    );
                    const last = h?.last_run;
                    return (
                      <td key={e.name} className={cn("border-b border-l border-line px-3 py-2", focus && focus !== e.name && "opacity-50")}>
                        <Link to={`/services/${s.name}?env=${e.name}`} className="block rounded-md px-1.5 py-1 hover:bg-hover">
                          <div className="flex items-center gap-1.5">
                            {last ? <RunStatusDot status={last.status} hint={`最近一次：${RUN_STATUS[last.status].label} · ${ago(last.created_at)}`} />
                              : <Tooltip content="还没有运行"><span className="inline-flex size-4 items-center justify-center"><span className="size-3.5 rounded-full border border-dashed border-line-strong" /></span></Tooltip>}
                            <span className="tabular-nums text-fg">{h?.runs_24h ?? 0}</span>
                            <span className="text-[11.5px] text-fg-3">次</span>
                            <FailCount n={h?.failed_24h} />
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

/**
 * 执行主机与排队：哪台主机在负责哪个环境（和哪些服务）、在跑几个；排着队的按 环境×服务 分组，
 * 标出没有在线主机负责的（那些会一直排着）和排太久告警过的。顶栏选了环境时只看那个环境。
 */
function HostsCard({ env }: { env: string }) {
  const { data, error, refetch } = useWorkers();
  const hosts = (data?.workers ?? []).filter((w) => !env || !w.env || w.env === env || w.remote_envs?.includes(env));
  const groups = (data?.queue.groups ?? []).filter((g) => !env || g.env === env);
  const orphan = groups.filter((g) => !g.served);
  const offline = hosts.filter((w) => !w.online);
  return (
    <Card className="mt-4">
      <CardHeader title="执行主机与排队" icon={<LuCpu />}
        description={data ? `${hosts.filter((w) => w.online).length} 台在线${offline.length ? ` · ${offline.length} 台离线` : ""} · ${groups.reduce((n, g) => n + g.queued, 0)} 个排队${orphan.length ? ` · ${orphan.length} 组没有主机负责` : ""}` : "每台部署主机上的 agent 服务每 20 秒报一次到"}
        actions={<LinkButton to={withEnv("/runs?status=queued", env)} size="xs" variant="ghost">排队的运行 <LuArrowRight /></LinkButton>} />
      {error && !data ? <ErrorState error={error} onRetry={() => void refetch()} className="py-6" /> : !data ? <div className="p-4"><Skeleton className="h-24" /></div> : (
        <div className="grid divide-line lg:grid-cols-[1.4fr_1fr] lg:divide-x">
          <div className="min-w-0">
            {hosts.length === 0 ? <Empty title="还没有主机报到" description="部署主机上的 agent 服务启动后每 20 秒报一次到；没有主机，运行会一直排着" className="py-6" /> : (
              <ul className="divide-y divide-line">
                {hosts.map((w) => (
                  <li key={w.worker_id} className={cn("flex items-center gap-3 px-4 py-2.5", !w.online && "opacity-60")}>
                    <Tooltip content={w.online ? "在线" : w.stopped_at ? "已正常退出" : "90 秒没报到"}>
                      <span className={cn("size-2 shrink-0 rounded-full", w.online ? "bg-ok" : "bg-idle")} />
                    </Tooltip>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-[12.5px] text-fg">{w.host}</span>
                        {w.env ? <EnvBadge env={w.env} /> : <span className="text-[11px] text-fg-3">所有环境</span>}
                        {w.remote_envs?.length > 0 && (
                          <Tooltip content={`代管 ${w.remote_envs.join("、")}：这台不是它的部署主机，也执行它的运行。看不到那边主机上的日志和主机状况，代码以这台上的为参考，配置用给 agent 的只读版`}>
                            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-fg-3">代管 {w.remote_envs.map((e) => <EnvBadge key={e} env={e} />)}</span>
                          </Tooltip>
                        )}
                      </div>
                      <div className="truncate text-[11.5px] text-fg-3">{w.services.length ? w.services.join("、") : "全部服务"} · v{w.version}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[12.5px] tabular-nums text-fg-2">{w.online ? `${w.running} / ${w.max_concurrent} 在跑` : "离线"}</div>
                      <TimeAgo at={w.online ? w.seen_at : w.stopped_at ?? w.seen_at} prefix={w.online ? "报到 " : ""} className="text-[11px] text-fg-3" />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="min-w-0 border-t border-line lg:border-t-0">
            {groups.length === 0 ? <Empty icon={<LuCircleCheck className="text-ok" />} title="没有排队的运行" className="py-6" /> : (
              <ul className="divide-y divide-line">
                {groups.map((g) => (
                  <li key={`${g.env}|${g.service}`}>
                    <Link to={`/runs?status=queued&env=${g.env}${g.service ? `&service=${encodeURIComponent(g.service)}` : ""}`} className="flex items-center gap-2 px-4 py-2.5 hover:bg-hover/70">
                      <EnvBadge env={g.env} />
                      <span className="min-w-0 truncate text-[12.5px] text-fg-2">{g.service ?? "平台任务"}</span>
                      {!g.served && <Tooltip content="没有在线的主机负责它：会一直排着"><span className="inline-flex items-center gap-1 text-[11.5px] text-bad"><LuServerOff className="size-3.5" />没有主机</span></Tooltip>}
                      {g.stuck > 0 && <Tooltip content={`排队超过 ${Math.round((data.queued_alert_s ?? 600) / 60)} 分钟、已经告警过`}><span className="text-[11.5px] text-warn">{g.stuck} 个排太久</span></Tooltip>}
                      <span className="ml-auto shrink-0 text-right">
                        <span className="block text-[12.5px] tabular-nums text-fg">{g.queued} 个</span>
                        <span className="block text-[11px] text-fg-3">{g.waiting_upstream ? `${g.waiting_upstream} 个在等上游 · ` : ""}最早 <TimeAgo at={g.oldest_at} /></span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

/** 最近 3 天的负反馈：agent 最近哪里做得不好，点进去看现场 */
function RecentNegative({ env, titleOf }: { env: string; titleOf: (task: string) => string }) {
  const { data, error, refetch } = useFeedbackInbox({ score: -1, env: env || undefined, hours: 72 });
  const { data: meta } = useMeta();
  const reason = (r: string) => meta?.feedback_reasons.find((x) => x.value === r)?.label ?? r;
  return (
    <Card className={ROW_CARD}>
      <CardHeader title="最近的负反馈" icon={<LuThumbsDown />} description="近 3 天有人点了 👎 的运行"
        actions={<LinkButton to="/runs?view=feedback" size="xs" variant="ghost">全部 <LuArrowRight /></LinkButton>} />
      {error && !data ? <ErrorState error={error} onRetry={() => void refetch()} className="py-6" />
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
                    <span className="ml-auto shrink-0">{f.created_by} · <TimeAgo at={f.updated_at} /></span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-[12.5px] text-fg" title={f.summary}>{f.summary}</div>
                  {/* 问题类型用和反馈条目一样的红色胶囊，说明另起一行 */}
                  {f.reasons.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{f.reasons.map((r) => <ReasonChip key={r}>{reason(r)}</ReasonChip>)}</div>}
                  {f.comment && <div className="mt-0.5 line-clamp-2 text-[11.5px] text-fg-2" title={f.comment}>{f.comment}</div>}
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
