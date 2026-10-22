/**
 * 服务详情：先选环境（服务×环境是 agent 实际操作的单位），再看进程、配置文件、
 * 任务、运行、记忆；「配置」tab 结构化编辑服务定义，「版本」看历史与 diff。
 */
import { useMemo, useState } from "react";
import {
  LuBrain, LuCircleAlert, LuCircleStop, LuClock, LuEllipsis, LuExternalLink, LuFileText, LuFolder, LuGitBranch, LuHistory, LuListTodo,
  LuPlay, LuPlug, LuPower, LuRefreshCw, LuScrollText, LuServer, LuSettings, LuActivity, LuLayers, LuLayoutDashboard,
  LuGitPullRequestArrow,
} from "react-icons/lu";

import { api, useEnvs, useMeta, useProcesses, useRuns, useService, useServiceEnv, useServiceTools, useSettings, useTasks } from "@/api/hooks";
import type { Instance, ServiceEnvOverride, ServiceSummary } from "@/api/types";
import { Page, PageHeader } from "@/components/layout/shell";
import { EnvBadge, InstanceBadge } from "@/components/status";
import { VersionHistory } from "@/components/versions";
import { Button } from "@/components/ui/button";
import { CodeBlock, Markdown, Mono, Tabs, Table, Td, Th, Tr } from "@/components/ui/data";
import { Input, Switch } from "@/components/ui/form";
import { Drawer, Menu, Tooltip, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, DescList, Empty, ErrorState, Skeleton, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, datetime, until } from "@/lib/format";
import { invalidate, setQueryData, useQuery } from "@/lib/query";
import { Link, navigate, useParams, useSearch } from "@/lib/router";
import { useUi } from "@/lib/store";
import { AssetList, KnowledgeList } from "../memory/memory";
import { ServiceAvatar } from "../overview/overview";
import { RunMiniList, RunsTable } from "../runs/runs-table";
import { RunTaskDialog } from "../tasks/run-dialog";
import { TasksTable, taskRowsOf } from "../tasks/tasks";
import { ServiceConfigEditor } from "./service-config";

type TabKey = "overview" | "envs" | "tasks" | "runs" | "memory" | "tools" | "config" | "versions";

export function ServiceDetailPage() {
  const { name } = useParams<{ name: string }>();
  const [search, setSearch] = useSearch<{ tab: TabKey; env: string }>();
  const { data: svc, error, refetch } = useService(name);
  const { data: envs } = useEnvs();
  const { env: globalEnv } = useUi();
  const [runOpen, setRunOpen] = useState(false);
  const allEnvs = envs ?? [];
  const env = search.env || (allEnvs.find((e) => e.name === globalEnv) ?? allEnvs.find((e) => !e.protected) ?? allEnvs[0])?.name || "test";
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
    await api.update("services", svc.name, { enabled: !svc.enabled });
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
          {allEnvs.map((e) => {
            const off = svc?.health[e.name]?.enabled === false;
            return (
              <button key={e.name} type="button" onClick={() => setSearch({ env: e.name })} title={off ? "该服务在此环境已停用" : undefined}
                className={cn("flex h-7 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors", env === e.name ? "bg-panel shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "hover:bg-hover", off && "opacity-55")}>
                <EnvBadge env={e.name} /><span className={cn(env === e.name ? "text-fg" : "text-fg-3", off && "line-through")}>{e.title}</span>
                {svc && !off && !!svc.health[e.name]?.failed_24h && <span className="size-1.5 rounded-full bg-bad" />}
              </button>
            );
          })}
        </div>
        <span className="text-xs text-fg-3">配置文件、只读库、进程、记忆都按所选环境解析</span>
      </div>

      <Tabs className="mb-5" value={tab} onChange={(v) => setSearch({ tab: v === "overview" ? undefined : v })} tabs={[
        { value: "overview", label: "概览", icon: <LuLayoutDashboard /> },
        { value: "envs", label: "环境", icon: <LuLayers /> },
        { value: "tasks", label: "任务", icon: <LuListTodo />, count: tasks?.filter((t) => !t.extends).length },
        { value: "runs", label: "运行", icon: <LuActivity /> },
        { value: "memory", label: "记忆", icon: <LuBrain /> },
        { value: "tools", label: "工具", icon: <LuPlug />, count: svc && Object.keys(svc.mcp ?? {}).length ? Object.keys(svc.mcp).length : undefined },
        { value: "config", label: "配置", icon: <LuSettings /> },
        { value: "versions", label: "版本", icon: <LuHistory /> },
      ]} />

      {!svc ? <Skeleton className="h-96" /> : (
        <>
          {tab === "overview" && <OverviewTab svc={svc} env={env} onOpenEnvs={() => setSearch({ tab: "envs" })} onOpenTools={() => setSearch({ tab: "tools" })} />}
          {tab === "envs" && <EnvsTab svc={svc} onSaved={refetch} />}
          {tab === "tasks" && <Card><TasksTable groups={[{ key: "all", rows: taskRowsOf(tasks) }]} /></Card>}
          {tab === "runs" && <RunsTab service={svc.name} env={env} />}
          {tab === "memory" && <div className="space-y-4">
            <div className="text-xs text-fg-3">
              {env} 的记忆连同对所有环境成立的条目一起列出。人写的约定在「配置 → 服务档案」；记忆被反复用到、确认无误后可以在条目里升格进档案（<Link to={`/memory?tab=promotable&service=${svc.name}`} className="text-accent hover:underline">看可升格的</Link>）。
            </div>
            <KnowledgeList filters={{ service: svc.name, env: env || undefined }} scope={{ service: svc.name }} />
            <AssetList filters={{ service: svc.name, env: env || undefined }} scope={{ service: svc.name }} />
          </div>}
          {tab === "tools" && <ToolsTab svc={svc} onOpenConfig={() => setSearch({ tab: "config" })} />}
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

function OverviewTab({ svc, env, onOpenEnvs, onOpenTools }: { svc: ServiceSummary; env: string; onOpenEnvs: () => void; onOpenTools: () => void }) {
  const { data: view } = useServiceEnv(svc.name, env);
  const { data: recent } = useRuns({ service: svc.name, env, limit: 8 });
  const h = svc.health[env];
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <div className="min-w-0 space-y-4">
        {h && !h.enabled && svc.enabled && (
          <div className="flex items-center gap-3 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-[13px] text-warn">
            <LuPower className="size-4 shrink-0" /><span className="flex-1">{svc.name} 在 {env} 环境已停用：不接收运行、不启动进程、定时暂停。</span>
            <Button size="sm" onClick={onOpenEnvs}>去启用</Button>
          </div>
        )}
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
                ["解释器", <div><Mono copy>{view.python}</Mono><div className="mt-0.5 text-[11.5px] text-fg-3">py 工具的项目内核、进程 cmd 里的 {"{python}"} 都用它</div></div>],
                ["地址", Object.keys(view.urls ?? {}).length ? <UrlList urls={view.urls} /> : <span className="text-fg-3">未配置</span>],
                ["服务工具", (view.mcp_servers ?? []).length ? (
                  <button type="button" onClick={onOpenTools} className="flex flex-wrap items-center gap-1 text-left hover:text-accent">
                    {view.mcp_servers.map((m) => <Badge key={m} tone="outline" icon={<LuPlug />} className="font-mono">{m}</Badge>)}
                    <span className="text-[11.5px] text-fg-3">MCP，运行里自动带上</span>
                  </button>
                ) : <span className="text-fg-3">无（可在「配置 → MCP」声明）</span>],
                ["主机", view.hosts.length ? view.hosts.join("、") : <span className="text-fg-3">未登记</span>],
                ["只读库", view.readonly_dsn ? <Mono copy>{view.readonly_dsn}</Mono> : <span className="text-fg-3">未配置（sql_query 不可用）</span>],
                ["代码版本", view.git ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <LuGitBranch className="size-3.5 text-fg-3" /><span className="font-mono text-[12px]">{view.git.branch}</span>
                    <span className="font-mono text-[12px] text-fg-3">@{view.git.commit}</span>
                    {view.git.dirty && <Badge tone="warn">有未提交改动</Badge>}
                  </span>
                ) : <span className="text-fg-3">{view.repo ? "还没拉取（点下面的同步代码）" : "不是 git 仓库"}</span>],
                ["跟踪", view.repo ? <span className="font-mono text-[12px]">{view.ref || "远端默认分支"}</span> : <span className="text-fg-3">未配置代码仓库</span>],
              ]} />
            )}
            {view?.repo && (
              <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
                <SyncCode service={svc.name} env={env} gitRef={view.ref} />
                <span className="text-[11.5px] text-fg-3">内建任务 code-sync，结果在运行里看</span>
              </div>
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

function SyncCode({ service, env, gitRef }: { service: string; env: string; gitRef: string }) {
  const [busy, setBusy] = useState(false);
  const sync = async () => {
    const ok = await confirm({
      title: `同步 ${service} 在 ${env} 的代码？`,
      description: `把 ${env} 的代码目录切到 ${gitRef || "远端默认分支"} 的最新提交。目录里有未提交改动时拒绝切换；正在运行的进程要重启才会用上新代码。`,
      confirmText: "同步",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.submitRun({ task: "code-sync", service, env, input: {} });
      toast("已发起代码同步", { description: res.dedup ? "命中去重：刚同步过" : undefined });
      navigate(`/runs/${res.run_id}`);
    } catch (e) {
      toast.error("发起失败", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <Button size="sm" icon={<LuGitPullRequestArrow />} loading={busy} onClick={sync}>同步代码</Button>;
}

/** 该环境的地址：http(s) 的可以点开（新窗口） */
function UrlList({ urls }: { urls: Record<string, string> }) {
  return (
    <ul className="space-y-0.5">
      {Object.entries(urls).map(([name, url]) => (
        <li key={name} className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-mono text-[11.5px] text-fg-3">{name}</span>
          {/^https?:\/\//.test(url)
            ? <a href={url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 font-mono text-[12px] text-accent hover:underline">
                <span className="truncate">{url}</span><LuExternalLink className="size-3 shrink-0" />
              </a>
            : <Mono copy>{url}</Mono>}
        </li>
      ))}
    </ul>
  );
}

// ———————— 工具：服务自己声明的 MCP ————————

function ToolsTab({ svc, onOpenConfig }: { svc: ServiceSummary; onOpenConfig: () => void }) {
  const { data, loading, error, refetch } = useServiceTools(svc.name);
  const [reloading, setReloading] = useState(false);
  const reload = async () => {
    setReloading(true);
    try {
      const next = await api.serviceTools(svc.name, true);
      setQueryData(["services", svc.name, "tools"], () => next);
      if (next.failed.length) toast.error("已重新连接，仍有连接失败", next.failed.join("、"));
      else toast("已重新连接", { description: `${next.tools.length} 个工具` });
    } catch (e) {
      toast.error("重新连接失败", (e as Error).message);
    } finally {
      setReloading(false);
    }
  };
  const servers = data?.servers ?? Object.keys(svc.mcp ?? {});
  return (
    <Card>
      <CardHeader title="服务工具（MCP）" icon={<LuPlug />}
        description="服务自己声明的 MCP server（在「配置 → MCP」里写）：运行在本服务上时这些工具自动出现，调用按运行的环境连接；角色关了「自动带上服务工具」就不带。"
        actions={servers.length > 0 && <Button size="sm" icon={<LuRefreshCw />} loading={reloading} onClick={reload}>重新连接</Button>} />
      {error ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={4} /> : !servers.length ? (
        <Empty icon={<LuPlug />} title="这个服务没有声明 MCP"
          description="在「配置 → MCP」里加一个 server（名字 + 连接配置），这里就会列出它的工具；比如 dagster 服务接上 Dagster 的运行记录与日志。"
          action={<Button size="sm" onClick={onOpenConfig}>去配置</Button>} />
      ) : (
        <>
          {!!data?.failed.length && (
            <div className="flex gap-2 border-b border-line bg-warn-soft px-4 py-2.5 text-[12.5px] text-warn">
              <LuCircleAlert className="mt-0.5 size-4 shrink-0" />
              <span>这些连接失败：<span className="font-mono">{data.failed.join("、")}</span>。检查连接配置、环境变量与服务端是否在线，改好后点「重新连接」。</span>
            </div>
          )}
          {data && !data.loaded && <div className="border-b border-line px-4 py-2.5 text-[12.5px] text-fg-3">还没连过：点「重新连接」现连一次。</div>}
          {!data?.tools.length ? (
            <Empty title="没有可用的工具" description={`声明了 ${servers.join("、")}，但没有拿到工具：看上面的连接失败提示，或检查 MCP 服务端`} />
          ) : (
            <Table>
              <thead><tr><Th>工具</Th><Th>说明</Th><Th>Server</Th><Th>可用环境</Th></tr></thead>
              <tbody>
                {data.tools.map((t) => (
                  <Tr key={t.name}>
                    <Td className="whitespace-nowrap"><code className="font-mono text-[12.5px] font-medium text-fg">{t.name}</code></Td>
                    <Td className="max-w-[460px] text-[12.5px] text-fg-2">{t.description || <span className="text-fg-3">—</span>}</Td>
                    <Td>{t.server ? <Badge tone="outline" className="font-mono">{t.server}</Badge> : <span className="text-fg-3">—</span>}</Td>
                    <Td><span className="flex flex-wrap gap-1">{t.envs.length ? t.envs.map((e) => <EnvBadge key={e} env={e} />) : <span className="text-[12px] text-fg-3">—</span>}</span></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}
    </Card>
  );
}

export const PROFILE_LABEL: Record<string, string> = {
  conventions: "口径与术语", no_go: "禁区", env_notes: "环境差异", pitfalls: "常见坑", code_refs: "代码位置",
  upstream: "上游依赖", downstream: "下游影响", runbook: "运维备注",
};

// ———————— 环境：服务在每个环境是否启用、覆盖了什么 ————————

function EnvsTab({ svc, onSaved }: { svc: ServiceSummary; onSaved: () => void }) {
  const { data: envs } = useEnvs();
  const [refs, setRefs] = useState<Record<string, string>>({});
  const save = async (env: string, patch: Partial<ServiceEnvOverride>, message: string) => {
    const merged: ServiceEnvOverride = { ...(svc.envs[env] ?? {}), ...patch };
    for (const k of Object.keys(merged) as (keyof ServiceEnvOverride)[]) if (merged[k] === undefined) delete merged[k];
    const next = { ...svc.envs, [env]: merged };
    if (!Object.keys(merged).length) delete next[env];
    try {
      await api.update("services", svc.name, { envs: next });
      toast(message);
      invalidate("services");
      onSaved();
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  };
  const toggle = async (env: string, enabled: boolean) => {
    const ok = await confirm({
      title: enabled ? `在 ${env} 启用 ${svc.name}？` : `在 ${env} 停用 ${svc.name}？`,
      description: enabled ? "启用后该环境立即接收运行，定时恢复，可以按需起进程。" : "停用后：该环境的新运行全部拒收（原因码 service_env_disabled），定时暂停，进程与项目内核不能启动；其它环境不受影响。",
      confirmText: enabled ? "启用" : "停用", danger: !enabled,
    });
    if (ok) await save(env, { enabled: enabled ? undefined : false }, enabled ? `${env} 已启用` : `${env} 已停用`);
  };
  const saveRef = async (env: string) => {
    if (!(env in refs)) return;
    const value = refs[env].trim();
    setRefs((r) => { const n = { ...r }; delete n[env]; return n; });
    if (value === (svc.envs[env]?.ref ?? "")) return;
    await save(env, { ref: value || undefined }, value ? `${env} 跟踪 ${value}` : `${env} 跟随基座分支`);
  };
  return (
    <Card>
      <CardHeader title="各环境" description="服务×环境是 agent 实际操作的单位。启用 = 接收运行、能起进程和项目内核；跟踪 = 代码同步的默认分支。主机、只读库、解释器、地址、档案的环境差异在「配置」里改。" icon={<LuLayers />} />
      <ul className="divide-y divide-line">
        {(envs ?? []).map((e) => {
          const o = svc.envs[e.name] ?? {};
          const h = svc.health[e.name];
          const on = h?.enabled !== false;
          const overrides = [o.hosts && "主机", o.readonly_dsn && "只读库", o.code_paths && "代码目录", o.python && "解释器", o.urls && Object.keys(o.urls).length && "地址", o.profile && Object.keys(o.profile).length && "档案"].filter(Boolean);
          return (
            <li key={e.name} className={cn("flex flex-wrap items-center gap-4 px-4 py-3.5", !on && "bg-sunken/50")}>
              <EnvBadge env={e.name} className="h-6 px-2 text-[12px]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
                  {e.title}{e.protected && <Badge tone="warn">受保护</Badge>}{!on && <Badge tone="idle">已停用</Badge>}
                </div>
                <div className="mt-0.5 text-[12px] text-fg-3">
                  {overrides.length ? `覆盖了：${overrides.join("、")}` : "全部沿用基座配置"} · 近 24h {h?.runs_24h ?? 0} 次运行 · 进程 {h?.running_processes ?? 0}/{h?.total_processes ?? 0} 运行中
                </div>
                {h?.python && <div className="mt-0.5 truncate font-mono text-[11.5px] text-fg-3" title="该环境的解释器">{h.python}</div>}
              </div>
              {svc.repo && (
                <label className="flex items-center gap-1.5 text-[12px] text-fg-3">跟踪
                  <Input mono className="h-7 w-32 text-[12px]" value={refs[e.name] ?? o.ref ?? ""} placeholder={svc.ref || "默认分支"}
                    onChange={(ev) => setRefs((r) => ({ ...r, [e.name]: ev.target.value }))}
                    onBlur={() => saveRef(e.name)} onKeyDown={(ev) => { if (ev.key === "Enter") ev.currentTarget.blur(); }} />
                </label>
              )}
              <Switch checked={on} disabled={!svc.enabled} onChange={(v) => toggle(e.name, v)} label={<span className="text-[12.5px]">{on ? "启用" : "停用"}</span>} />
            </li>
          );
        })}
      </ul>
      {!svc.enabled && <div className="border-t border-line px-4 py-2.5 text-[12px] text-fg-3">服务整体已停用（右上角菜单），各环境开关暂不生效。</div>}
      <div className="border-t border-line px-4 py-2.5 text-[12px] text-fg-3">环境本身（有哪些、谁受保护）在 <Link to="/settings/envs" className="text-accent hover:underline">设置 → 环境</Link>。</div>
    </Card>
  );
}

// ———————— 进程 ————————

function Processes({ svc, env }: { svc: ServiceSummary; env: string }) {
  const { data, loading, refetch } = useProcesses(svc.name);
  const { data: envs } = useEnvs();
  const { data: settings } = useSettings();
  const { data: meta } = useMeta();
  const defaultLease = settings?.processes.default_lease_hours ?? 2;
  const [logs, setLogs] = useState<Instance | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = (data ?? []).filter((i) => i.env === env);
  const backend = meta?.features.process_control;
  const controlOff = backend === "off";
  /** 能不能起：只看服务在该环境是否启用（实例上的 enabled）与平台是否开了进程启停 */
  const envOff = !svc.enabled || svc.health[env]?.enabled === false;
  const protectedEnv = !!envs?.find((e) => e.name === env)?.protected;
  const approvalIn = settings?.approvals.required_in ?? "off";
  const needsApproval = approvalIn === "all" || (approvalIn === "protected" && protectedEnv);

  const act = async (i: Instance, action: "start" | "stop" | "renew") => {
    if (action !== "renew") {
      const ok = await confirm({
        title: `${action === "start" ? "启动" : "停止"} ${i.process}@${env}？`,
        description: needsApproval ? "设置里打开了审批：会先创建审批单，有人放行后才执行。" : action === "start" ? `按 ${svc.processes[i.process]?.lease_hours ?? defaultLease} 小时租约启动，到期自动停止（可续期）。` : "进程会收到 SIGTERM，15 秒后仍未退出则强制结束。",
        confirmText: needsApproval ? "提交审批" : action === "start" ? "启动" : "停止", danger: action === "stop",
      });
      if (!ok) return;
    }
    setBusy(i.process + action);
    try {
      const res = await api.processAction(svc.name, env, i.process, action);
      if (res.approval) toast("已提交审批", { description: res.approval.title });
      else toast({ start: "已启动", stop: "已停止", renew: `租约已续期 ${svc.processes[i.process]?.lease_hours ?? defaultLease} 小时` }[action]);
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
      <CardHeader title="进程" icon={<LuServer />} description={
        controlOff ? "平台未开启进程启停（部署配置 process_control.backend=off）：只能看状态和日志"
          : envOff ? `${svc.name} 在 ${env} 已停用：不能启动进程`
            : needsApproval ? "已开启审批（设置 → 审批）：启停要人放行"
              : `按需启动、租约到期自动停止；${backend === "local" ? "本机子进程托管" : "systemd 托管，日志进 journald"}`}
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
                        <Tooltip content={`续期 ${svc.processes[i.process]?.lease_hours ?? defaultLease} 小时`}><Button size="icon-xs" variant="ghost" onClick={() => act(i, "renew")} loading={busy === i.process + "renew"} disabled={controlOff}><LuClock /></Button></Tooltip>
                        <Tooltip content="日志"><Button size="icon-xs" variant="ghost" onClick={() => setLogs(i)}><LuScrollText /></Button></Tooltip>
                        <Button size="xs" variant="danger-ghost" icon={<LuCircleStop />} onClick={() => act(i, "stop")} loading={busy === i.process + "stop"} disabled={controlOff}>停止</Button>
                      </> : <>
                        {i.last_exit && <Tooltip content="上次运行的日志"><Button size="icon-xs" variant="ghost" onClick={() => setLogs(i)}><LuScrollText /></Button></Tooltip>}
                        {controlOff || envOff || !i.enabled
                          ? <Tooltip content={controlOff ? "平台未开启进程启停" : `${svc.name} 在 ${env} 已停用（服务 → 环境）`}><span><Button size="xs" icon={<LuPlay />} disabled>启动</Button></span></Tooltip>
                          : <Button size="xs" icon={<LuPlay />} onClick={() => act(i, "start")} loading={busy === i.process + "start"}>启动</Button>}
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
  const { data } = useQuery(["logs", instance?.service, instance?.env, instance?.process], () => api.processLogs(instance!.service, instance!.env, instance!.process), { enabled: !!instance, refetchInterval: 5000, live: true });
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
      <CardHeader title="配置文件" icon={<LuFileText />} description={`进程启动时把 ${env} 的文件 bind 到固定路径，其他环境的文件对进程不可见；agent 的 bash 里一律遮蔽，只能经 service_info 读（密钥打码）`} />
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

