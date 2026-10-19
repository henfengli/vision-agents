/**
 * 概览：一眼看全"现在平台怎么样"——运行量与成功率、服务×环境健康矩阵、
 * 失败聚焦、即将触发的定时任务、待审批。全部受顶栏全局环境过滤。
 */
import { useState } from "react";
import {
  LuActivity, LuArrowRight, LuCalendarClock, LuCircleCheck, LuCircleX, LuCoins, LuLoaderCircle, LuPlay, LuServer, LuShieldCheck,
} from "react-icons/lu";

import { useApprovals, useEnvs, useRuns, useServices, useStats } from "@/api/hooks";
import { RunsChart } from "@/components/charts";
import { Page, PageHeader } from "@/components/layout/shell";
import { APPROVAL_KIND, EnvBadge, RUN_STATUS } from "@/components/status";
import { Button, LinkButton } from "@/components/ui/button";
import { Segmented } from "@/components/ui/form";
import { Card, CardHeader, Empty, Skeleton, Stat } from "@/components/ui/primitives";
import { Tooltip } from "@/components/ui/overlay";
import { cn } from "@/lib/cn";
import { ago, dayjs, num, pct, until } from "@/lib/format";
import { Link } from "@/lib/router";
import { useUi } from "@/lib/store";
import { RunMiniList } from "../runs/runs-table";
import { RunTaskDialog } from "../tasks/run-dialog";

export function OverviewPage() {
  const { env } = useUi();
  const [hours, setHours] = useState<"24" | "72">("24");
  const { data: stats } = useStats({ hours: Number(hours), env });
  const { data: recent } = useRuns({ env, limit: 8 });
  const [runOpen, setRunOpen] = useState(false);
  const t = stats?.totals;
  const finished = t ? t.success + t.failed : 0;

  return (
    <Page wide>
      <PageHeader title="概览" description={`近 ${hours} 小时 · ${env ? env.toUpperCase() + " 环境" : "全部环境"}`}
        actions={<>
          <Segmented size="sm" value={hours} onChange={setHours} options={[{ value: "24", label: "24 小时" }, { value: "72", label: "3 天" }]} />
          <Button variant="primary" icon={<LuPlay />} onClick={() => setRunOpen(true)}>运行任务</Button>
        </>} />

      <Card className="mb-4 grid grid-cols-2 divide-line md:grid-cols-3 lg:grid-cols-6 lg:divide-x">
        {[
          <Stat key="a" icon={<LuActivity />} label="运行" value={t ? num(t.runs) : <Skeleton className="h-7 w-16" />} hint={stats && Object.entries(stats.by_env).filter(([, v]) => v.runs).map(([k, v]) => `${k} ${v.runs}`).join(" · ")} />,
          <Stat key="b" icon={<LuCircleCheck />} label="成功率" value={t ? pct(t.success, finished) : <Skeleton className="h-7 w-14" />} tone={t && finished && t.success / finished < 0.85 ? "warn" : "ok"} hint={t && `${t.success} / ${finished} 已结束`} />,
          <Stat key="c" icon={<LuCircleX />} label="失败" value={t ? t.failed : <Skeleton className="h-7 w-10" />} tone={t?.failed ? "bad" : undefined} hint={<Link to={`/runs?status=failed&hours=${hours}`} className="hover:text-accent">查看失败 →</Link>} />,
          <Stat key="d" icon={<LuLoaderCircle />} label="运行中" value={t ? t.running : <Skeleton className="h-7 w-10" />} hint="实时" />,
          <Stat key="e" icon={<LuShieldCheck />} label="待审批" value={t ? t.awaiting : <Skeleton className="h-7 w-10" />} tone={t?.awaiting ? "warn" : undefined} hint={<Link to="/approvals" className="hover:text-accent">去处理 →</Link>} />,
          <Stat key="f" icon={<LuCoins />} label="Tokens" value={stats ? num(stats.tokens) : <Skeleton className="h-7 w-16" />} hint="模型用量" />,
        ].map((el, i) => <div key={i} className="px-5 py-4">{el}</div>)}
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
                      {f.service && <span className="text-xs text-fg-3">{f.service}</span>}
                      <span className="ml-auto rounded bg-bad-soft px-1.5 text-[11.5px] font-semibold tabular-nums text-bad">{f.failed}</span>
                    </div>
                    <div className="mt-1 truncate font-mono text-[11.5px] text-fg-3">{f.last_error || "—"}</div>
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
        <PendingApprovals />
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

function Upcoming({ items }: { items: { task: string; service: string | null; env: string; at: string }[] | undefined }) {
  return (
    <Card>
      <CardHeader title="即将触发" icon={<LuCalendarClock />} description="定时任务的下一次运行（按环境展开）" />
      {!items ? <div className="p-4"><Skeleton className="h-32" /></div> : items.length === 0 ? (
        <Empty title="没有定时任务" />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((u, i) => (
            <li key={i}>
              <Link to={`/tasks/${encodeURIComponent(u.task)}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-hover/70">
                <div className="w-[52px] text-center">
                  <div className="text-[13px] font-semibold tabular-nums text-fg">{dayjs(u.at).format("HH:mm")}</div>
                  <div className="text-[10.5px] text-fg-3">{dayjs(u.at).isSame(dayjs(), "day") ? "今天" : dayjs(u.at).format("MM-DD")}</div>
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

/** 服务×环境健康矩阵：最近一次运行、24h 运行/失败、进程在跑几个 */
function HealthMatrix() {
  const { data: services } = useServices({ refetchInterval: 30_000 });
  const { data: envs } = useEnvs();
  const { env: focus } = useUi();
  const cols = (envs ?? []).filter((e) => e.enabled);
  return (
    <Card>
      <CardHeader title="服务健康" icon={<LuServer />} description="每格是一个 服务×环境：最近一次运行、近 24 小时运行与失败、在跑的进程"
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
                          <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-fg-3">
                            <span className={cn("size-1.5 rounded-full", h?.running_processes ? "bg-ok" : "bg-line-strong")} />
                            进程 {h?.running_processes ?? 0}/{h?.total_processes ?? 0}
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

function PendingApprovals() {
  const { data } = useApprovals("pending");
  return (
    <Card>
      <CardHeader title="待审批" icon={<LuShieldCheck />} actions={<LinkButton to="/approvals" size="xs" variant="ghost">收件箱 <LuArrowRight /></LinkButton>} />
      {!data ? <div className="p-4"><Skeleton className="h-24" /></div> : data.length === 0 ? (
        <Empty icon={<LuCircleCheck className="text-ok" />} title="没有待办" />
      ) : (
        <ul className="divide-y divide-line">
          {data.slice(0, 5).map((a) => (
            <li key={a.id}>
              <Link to={`/approvals?id=${a.id}`} className="block px-4 py-2.5 hover:bg-hover/70">
                <div className="flex items-center gap-2 text-[11.5px] text-fg-3 [&_svg]:size-3.5">
                  {APPROVAL_KIND[a.kind].icon}{APPROVAL_KIND[a.kind].label}
                  {a.env && <EnvBadge env={a.env} />}
                  <span className="ml-auto">等待 {ago(a.created_at).replace("前", "")}</span>
                </div>
                <div className="mt-1 truncate font-mono text-[12px] text-fg">{a.detail.split("\n")[0]}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const AVATAR_COLORS = ["bg-[#6366f1]", "bg-[#0ea5e9]", "bg-[#10b981]", "bg-[#f59e0b]", "bg-[#ec4899]", "bg-[#8b5cf6]", "bg-[#14b8a6]"];

export function ServiceAvatar({ name, disabled, className }: { name: string; disabled?: boolean; className?: string }) {
  const color = AVATAR_COLORS[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
  return (
    <span className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-md text-[12px] font-bold uppercase text-white", disabled ? "bg-idle" : color, className)}>
      {name.slice(0, 1)}
    </span>
  );
}
