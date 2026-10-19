/**
 * 服务详情：先选环境（服务×环境是 agent 实际操作的单位），再看进程、配置文件、
 * 任务、运行、记忆；「配置」tab 结构化编辑服务定义，「版本」看历史与 diff。
 */
import { useMemo, useState } from "react";
import {
  LuBrain, LuCircleStop, LuClock, LuEllipsis, LuFileText, LuFolder, LuGitBranch, LuHistory, LuListTodo,
  LuPlay, LuPower, LuRefreshCw, LuScrollText, LuServer, LuSettings, LuActivity, LuLayoutDashboard,
} from "react-icons/lu";

import { api, useEnvs, useInstances, useRuns, useService, useServiceView, useTasks } from "@/api/hooks";
import type { Instance, ServiceSummary } from "@/api/types";
import { Page, PageHeader } from "@/components/layout/shell";
import { EnvBadge, InstanceBadge } from "@/components/status";
import { VersionHistory } from "@/components/versions";
import { Button } from "@/components/ui/button";
import { CodeBlock, Markdown, Mono, Tabs, Table, Td, Th, Tr } from "@/components/ui/data";
import { Drawer, Menu, Tooltip, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, DescList, Empty, ErrorState, Skeleton, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, datetime, until } from "@/lib/format";
import { invalidate, useQuery } from "@/lib/query";
import { useParams, useSearch } from "@/lib/router";
import { useUi } from "@/lib/store";
import { KnowledgeList } from "../memory/memory";
import { ServiceAvatar } from "../overview/overview";
import { RunMiniList, RunsTable } from "../runs/runs-table";
import { RunTaskDialog } from "../tasks/run-dialog";
import { TasksTable } from "../tasks/tasks";
import { ServiceConfigEditor } from "./service-config";

type TabKey = "overview" | "tasks" | "runs" | "memory" | "config" | "versions";

export function ServiceDetailPage() {
  const { name } = useParams<{ name: string }>();
  const [search, setSearch] = useSearch<{ tab: TabKey; env: string }>();
  const { data: svc, error, refetch } = useService(name);
  const { data: envs } = useEnvs();
  const { env: globalEnv } = useUi();
  const [runOpen, setRunOpen] = useState(false);
  const enabledEnvs = (envs ?? []).filter((e) => e.enabled);
  const env = search.env || (enabledEnvs.find((e) => e.name === globalEnv) ?? enabledEnvs.find((e) => !e.protected) ?? enabledEnvs[0])?.name || "test";
  const tab = (search.tab as TabKey) || "overview";
  const { data: tasks } = useTasks(name);

  if (error) return <Page><ErrorState error={error} onRetry={refetch} /></Page>;

  const toggle = async () => {
    if (!svc) return;
    const ok = await confirm({
      title: svc.enabled ? `停用服务 ${svc.name}？` : `启用服务 ${svc.name}？`,
      description: svc.enabled ? "停用后：新提交与事件全部拒收（原因码 service_disabled），定时任务暂停；运行中的不受影响。" : "启用后立即接收提交与事件，定时任务恢复。",
      confirmText: svc.enabled ? "停用" : "启用", danger: svc.enabled, requireText: svc.enabled ? svc.name : undefined,
    });
    if (!ok) return;
    await api.putService(svc.name, { enabled: !svc.enabled });
    toast(svc.enabled ? "服务已停用" : "服务已启用");
    invalidate("services");
  };

  return (
    <Page wide>
      <PageHeader
        crumbs={[{ label: "服务", to: "/services" }, { label: name }]}
        icon={svc ? <ServiceAvatar name={svc.name} disabled={!svc.enabled} className="size-10 text-[16px]" /> : <LuServer />}
        title={<span className="flex items-center gap-2">{svc?.title ?? name}{svc && !svc.enabled && <Badge tone="idle">已停用</Badge>}</span>}
        description={svc?.description}
        meta={svc && <>
          <span className="font-mono">{svc.name}</span>
          <span className="flex items-center gap-1 font-mono"><LuFolder className="size-3.5" />{svc.root || "未配置部署目录"}</span>
          <span>v{svc.version} · {svc.updated_by} 更新于 {ago(svc.updated_at)}</span>
        </>}
        actions={<>
          <Button icon={<LuPlay />} variant="primary" onClick={() => setRunOpen(true)} disabled={!svc?.enabled}>运行任务</Button>
          <Menu trigger={<Button size="icon" variant="secondary" aria-label="更多"><LuEllipsis /></Button>} items={[
            { label: svc?.enabled ? "停用服务" : "启用服务", icon: <LuPower />, danger: svc?.enabled, onClick: toggle },
            { label: "版本历史", icon: <LuHistory />, onClick: () => setSearch({ tab: "versions" }) },
          ]} />
        </>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-fg-3">环境</span>
        <div className="inline-flex rounded-lg border border-line bg-sunken p-0.5">
          {enabledEnvs.map((e) => (
            <button key={e.name} type="button" onClick={() => setSearch({ env: e.name })}
              className={cn("flex h-7 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors", env === e.name ? "bg-panel shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "hover:bg-hover")}>
              <EnvBadge env={e.name} /><span className={cn(env === e.name ? "text-fg" : "text-fg-3")}>{e.title}</span>
              {svc && !!svc.health[e.name]?.failed_24h && <span className="size-1.5 rounded-full bg-bad" />}
            </button>
          ))}
        </div>
        <span className="text-xs text-fg-3">配置文件、只读库、进程、记忆都按所选环境解析</span>
      </div>

      <Tabs className="mb-5" value={tab} onChange={(v) => setSearch({ tab: v === "overview" ? undefined : v })} tabs={[
        { value: "overview", label: "概览", icon: <LuLayoutDashboard /> },
        { value: "tasks", label: "任务", icon: <LuListTodo />, count: tasks?.filter((t) => !t.extends).length },
        { value: "runs", label: "运行", icon: <LuActivity /> },
        { value: "memory", label: "记忆", icon: <LuBrain /> },
        { value: "config", label: "配置", icon: <LuSettings /> },
        { value: "versions", label: "版本", icon: <LuHistory /> },
      ]} />

      {!svc ? <Skeleton className="h-96" /> : (
        <>
          {tab === "overview" && <OverviewTab svc={svc} env={env} />}
          {tab === "tasks" && <Card><TasksTable tasks={tasks?.filter((t) => !t.extends)} all={tasks} hideService /></Card>}
          {tab === "runs" && <RunsTab service={svc.name} env={env} />}
          {tab === "memory" && <Card><KnowledgeList service={svc.name} env={env} /></Card>}
          {tab === "config" && <ServiceConfigEditor svc={svc} onSaved={refetch} />}
          {tab === "versions" && <VersionHistory kind="services" name={svc.name} onRestored={refetch} />}
        </>
      )}
      <RunTaskDialog open={runOpen} onClose={() => setRunOpen(false)} service={name} />
    </Page>
  );
}

function RunsTab({ service, env }: { service: string; env: string }) {
  const { data, loading } = useRuns({ service, env, limit: 30 });
  return <Card><RunsTable runs={data?.items} loading={loading} columns={["status", "task", "trigger", "duration", "tokens", "time"]} /></Card>;
}

function OverviewTab({ svc, env }: { svc: ServiceSummary; env: string }) {
  const { data: view } = useServiceView(svc.name, env);
  const { data: recent } = useRuns({ service: svc.name, env, limit: 8 });
  const h = svc.health[env];
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <div className="min-w-0 space-y-4">
        <Processes svc={svc} env={env} />
        <ConfigFiles svc={svc} env={env} files={view?.config_files} />
        <Card>
          <CardHeader title="近期运行" description={`${env} · 近 24 小时 ${h?.runs_24h ?? 0} 次，失败 ${h?.failed_24h ?? 0} 次`} />
          <RunMiniList runs={recent?.items} limit={8} />
        </Card>
      </div>
      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader title="服务×环境视图" description="agent 在这次环境里看到的就是这些" />
          <div className="p-4">
            {!view ? <Skeleton className="h-32" /> : (
              <DescList items={[
                ["部署目录", <Mono copy>{view.root}</Mono>],
                ["代码目录", <div className="space-y-0.5">{view.code_paths.map((p) => <Mono key={p}>{p}</Mono>)}</div>],
                ["主机", view.hosts.length ? view.hosts.join("、") : <span className="text-fg-3">未登记</span>],
                ["只读库", view.readonly_dsn ? <Mono copy>{view.readonly_dsn}</Mono> : <span className="text-fg-3">未配置（sql_query 不可用）</span>],
                ["代码版本", view.git ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <LuGitBranch className="size-3.5 text-fg-3" /><span className="font-mono text-[12px]">{view.git.branch}</span>
                    <span className="font-mono text-[12px] text-fg-3">@{view.git.commit}</span>
                    {view.git.dirty && <Badge tone="warn">有未提交改动</Badge>}
                  </span>
                ) : <span className="text-fg-3">不是 git 仓库</span>],
              ]} />
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="服务档案" description="置顶逐字注入该服务的所有 run" icon={<LuScrollText />} />
          <div className="p-4">
            {!view ? <Skeleton className="h-24" /> : Object.keys(view.profile).length === 0 ? (
              <div className="text-[12.5px] text-fg-3">还没有档案。在「配置」里补上代码和配置读不出来的事实：口径、禁区、环境差异、踩过的坑。</div>
            ) : (
              <dl className="space-y-3">
                {Object.entries(view.profile).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-[11.5px] font-medium text-fg-3">{PROFILE_LABEL[k] ?? k}</dt>
                    <dd className="mt-0.5"><Markdown text={v} className="text-[13px]" /></dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

export const PROFILE_LABEL: Record<string, string> = {
  conventions: "口径与术语", no_go: "禁区", env_notes: "环境差异", pitfalls: "常见坑", code_refs: "代码位置",
  upstream: "上游依赖", downstream: "下游影响", runbook: "运维备注",
};

// ———————— 进程 ————————

function Processes({ svc, env }: { svc: ServiceSummary; env: string }) {
  const { data, loading, refetch } = useInstances(svc.name);
  const { data: envs } = useEnvs();
  const [logs, setLogs] = useState<Instance | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = (data ?? []).filter((i) => i.env === env);
  const protectedEnv = envs?.find((e) => e.name === env)?.protected;

  const act = async (i: Instance, action: "start" | "stop" | "renew") => {
    if (action !== "renew") {
      const ok = await confirm({
        title: `${action === "start" ? "启动" : "停止"} ${i.process}@${env}？`,
        description: protectedEnv ? "受保护环境：会先创建审批单，审批通过后才执行。" : action === "start" ? `按 ${svc.processes[i.process]?.lease_hours ?? 2} 小时租约启动，到期自动停止（可续期）。` : "进程会收到 SIGTERM，10 秒后仍未退出则强制结束。",
        confirmText: protectedEnv ? "提交审批" : action === "start" ? "启动" : "停止", danger: action === "stop",
      });
      if (!ok) return;
    }
    setBusy(i.process + action);
    try {
      const res = await api.instanceAction(svc.name, env, i.process, action);
      if (res.approval) toast("已提交审批", { description: res.approval.title });
      else toast({ start: "已启动", stop: "已停止", renew: "租约已续期 2 小时" }[action]);
      await refetch();
      invalidate("services");
      invalidate("approvals");
    } catch (e) {
      toast.error("操作失败", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader title="进程" icon={<LuServer />} description={protectedEnv ? "受保护环境：启停需审批" : "按需启动、租约到期自动停止；systemd 托管，日志进 journald"}
        actions={<Button size="icon-sm" variant="ghost" onClick={() => refetch()} aria-label="刷新"><LuRefreshCw /></Button>} />
      {loading ? <SkeletonRows rows={2} /> : rows.length === 0 ? (
        <Empty title="没有托管进程" description="在「配置」里声明进程（启动命令、端口），即可在这里按环境启停" />
      ) : (
        <Table>
          <thead><tr><Th>进程</Th><Th>状态</Th><Th>端口</Th><Th>启动</Th><Th>租约</Th><Th className="text-right">操作</Th></tr></thead>
          <tbody>
            {rows.map((i) => {
              const def = svc.processes[i.process];
              return (
                <Tr key={i.process}>
                  <Td>
                    <div className="font-medium text-fg">{i.process}</div>
                    <div className="max-w-[220px] truncate font-mono text-[11px] text-fg-3" title={def?.cmd.join(" ")}>{def?.cmd.join(" ")}</div>
                  </Td>
                  <Td className="whitespace-nowrap">
                    <InstanceBadge state={i.state} />
                    {i.state === "failed" && i.last_exit && <div className="text-[11px] text-bad">exit {i.last_exit.code} · {ago(i.last_exit.at)}</div>}
                  </Td>
                  <Td className="font-mono text-[12px] text-fg-2">{i.port ?? "—"}</Td>
                  <Td className="whitespace-nowrap text-[12.5px] text-fg-2">{i.started_at ? <Tooltip content={`${datetime(i.started_at, true)} · ${i.started_by}`}><span>{ago(i.started_at)}</span></Tooltip> : <span className="text-fg-3">—</span>}</Td>
                  <Td className="whitespace-nowrap text-[12.5px]">{i.lease_until ? <span className="text-fg-2">{until(i.lease_until)}到期</span> : <span className="text-fg-3">—</span>}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1">
                      {i.state === "running" ? <>
                        <Tooltip content="续期 2 小时"><Button size="icon-xs" variant="ghost" onClick={() => act(i, "renew")} loading={busy === i.process + "renew"}><LuClock /></Button></Tooltip>
                        <Tooltip content="日志"><Button size="icon-xs" variant="ghost" onClick={() => setLogs(i)}><LuScrollText /></Button></Tooltip>
                        <Button size="xs" variant="danger-ghost" icon={<LuCircleStop />} onClick={() => act(i, "stop")} loading={busy === i.process + "stop"}>停止</Button>
                      </> : <>
                        {i.last_exit && <Tooltip content="上次运行的日志"><Button size="icon-xs" variant="ghost" onClick={() => setLogs(i)}><LuScrollText /></Button></Tooltip>}
                        <Button size="xs" icon={<LuPlay />} onClick={() => act(i, "start")} loading={busy === i.process + "start"} disabled={!svc.enabled}>启动</Button>
                      </>}
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <LogsDrawer instance={logs} onClose={() => setLogs(null)} />
    </Card>
  );
}

function LogsDrawer({ instance, onClose }: { instance: Instance | null; onClose: () => void }) {
  const { data } = useQuery(["logs", instance?.service, instance?.env, instance?.process], () => api.instanceLogs(instance!.service, instance!.env, instance!.process), { enabled: !!instance, refetchInterval: 5000 });
  return (
    <Drawer open={!!instance} onClose={onClose} width="w-[760px]" title={instance ? `${instance.service}/${instance.process}@${instance.env} 日志` : ""} subtitle="最近 200 行 · 每 5 秒刷新">
      <div className="p-4">
        {!data ? <Skeleton className="h-96" /> : (
          <pre className="max-h-[calc(100vh-140px)] overflow-auto rounded-md bg-[#0d0f13] p-3 font-mono text-[11.5px] leading-relaxed text-[#cfd3dc]">
            {data.lines.map((l, i) => (
              <div key={i} className={cn(l.includes(" WARN ") && "text-[#f0c36b]", l.includes(" ERROR ") && "text-[#ff8080]")}>{l}</div>
            ))}
          </pre>
        )}
      </div>
    </Drawer>
  );
}

// ———————— 配置文件 ————————

function ConfigFiles({ svc, env, files }: { svc: ServiceSummary; env: string; files: { canonical: string; path: string; exists: boolean; size: number | null }[] | undefined }) {
  const [open, setOpen] = useState<string | null>(null);
  const { data } = useQuery(["config", svc.name, env, open], () => api.serviceConfig(svc.name, env, open!), { enabled: !!open });
  const sorted = useMemo(() => files ?? [], [files]);
  return (
    <Card>
      <CardHeader title="配置文件" icon={<LuFileText />} description={`进程启动时把 ${env} 的文件 bind 到固定路径，其他环境的同名文件对进程不可见`} />
      {!files ? <SkeletonRows rows={2} /> : sorted.length === 0 ? <Empty title="没有声明配置文件" description="在「配置」里声明 固定路径 ← 各环境模板（含 {env}）" /> : (
        <ul className="divide-y divide-line">
          {sorted.map((f) => (
            <li key={f.canonical} className="flex items-center gap-3 px-4 py-2.5">
              <LuFileText className="size-4 shrink-0 text-fg-3" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12.5px] text-fg">{f.path}</div>
                <div className="truncate font-mono text-[11px] text-fg-3">→ {f.canonical}</div>
              </div>
              {f.exists ? <span className="text-[11.5px] text-fg-3">{f.size ? `${(f.size / 1024).toFixed(1)} KB` : ""}</span> : <Badge tone="bad">文件不存在</Badge>}
              <Button size="xs" variant="ghost" disabled={!f.exists} onClick={() => setOpen(f.path)}>查看</Button>
            </li>
          ))}
        </ul>
      )}
      <Drawer open={!!open} onClose={() => setOpen(null)} title={open ?? ""} subtitle={`${svc.name} · ${env} · 只读（敏感值已打码）`} width="w-[720px]">
        <div className="p-4">{data ? <CodeBlock code={data.content} maxHeight={9999} /> : <Skeleton className="h-64" />}</div>
      </Drawer>
    </Card>
  );
}

