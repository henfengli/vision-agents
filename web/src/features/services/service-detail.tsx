/**
 * 服务详情：先选环境（服务×环境是 agent 实际操作的单位），再看线上的代码目录与解释器、
 * 配置、日志、任务、运行、记忆；「配置」tab 填本环境给 agent 的只读版配置（?tab=config&env=；只有受保护的环境要填，
 * 不受保护的直接用项目的真实配置）
 * 与结构化编辑服务定义（&part=definition），「版本」看历史与 diff。
 */
import { useState } from "react";
import {
  LuBrain, LuCircleAlert, LuEllipsis, LuExternalLink, LuFileText, LuFolder, LuHistory, LuListTodo,
  LuPencilLine, LuPlay, LuPlug, LuPower, LuRefreshCw, LuScrollText, LuServer, LuSettings, LuActivity, LuLayers, LuLayoutDashboard,
} from "react-icons/lu";

import { api, useEnvs, useRuns, useService, useServiceEnv, useServiceTools, useTasks } from "@/api/hooks";
import type { ServiceEnvOverride, ServiceSummary, ServiceView } from "@/api/types";
import { Page, PageHeader } from "@/components/layout/shell";
import { DbList } from "@/components/databases";
import { LogList } from "@/components/logs";
import { EnvBadge } from "@/components/status";
import { VersionHistory } from "@/components/versions";
import { Button } from "@/components/ui/button";
import { CodeBlock, Markdown, Mono, Tabs, Table, Td, Th, Tr } from "@/components/ui/data";
import { Segmented, Switch } from "@/components/ui/form";
import { Drawer, Menu, Tooltip, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, DescList, Empty, ErrorState, Skeleton, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago } from "@/lib/format";
import { invalidate, setQueryData, useQuery } from "@/lib/query";
import { Link, useParams, useSearch } from "@/lib/router";
import { useUi } from "@/lib/store";
import { AssetList, KnowledgeList } from "../memory/memory";
import { ServiceAvatar } from "../overview/overview";
import { RunMiniList, RunsTable } from "../runs/runs-table";
import { RunTaskDialog } from "../tasks/run-dialog";
import { TasksTable, taskRowsOf } from "../tasks/tasks";
import { ConfigFilesView, ConfigStatusBadges } from "./config-files";
import { ServiceConfigEditor } from "./service-config";

type TabKey = "overview" | "envs" | "tasks" | "runs" | "memory" | "tools" | "config" | "versions";
/** 「配置」tab 的两部分：本环境给 agent 的配置文件（默认）/ 服务定义 */
type ConfigPart = "files" | "definition";

export function ServiceDetailPage() {
  const { name } = useParams<{ name: string }>();
  const [search, setSearch] = useSearch<{ tab: TabKey; env: string; part: ConfigPart }>();
  const { data: svc, error, refetch } = useService(name);
  const { data: envs } = useEnvs();
  const { env: globalEnv } = useUi();
  const [runOpen, setRunOpen] = useState(false);
  const allEnvs = envs ?? [];
  const env = search.env || (allEnvs.find((e) => e.name === globalEnv) ?? allEnvs.find((e) => !e.protected) ?? allEnvs[0])?.name || "test";
  /** 受保护（生产）要填给 agent 的只读版；不受保护（测试）直接用真实配置 */
  const envProtected = !!allEnvs.find((e) => e.name === env)?.protected;
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
    try {
      await api.update("services", svc.name, { enabled: !svc.enabled });
      toast(svc.enabled ? "服务已停用" : "服务已启用");
      invalidate("services");
    } catch (e) { toast.error(svc.enabled ? "停用失败" : "启用失败", (e as Error).message); }
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
          <span className="flex items-center gap-1 font-mono"><LuFolder className="size-3.5" />{svc.root || "未配置代码目录"}</span>
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
            const h = svc?.health[e.name];
            const off = h?.enabled === false;
            return (
              <button key={e.name} type="button" onClick={() => setSearch({ env: e.name })}
                title={off ? "该服务在此环境已停用" : undefined}
                className={cn("flex h-7 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors", env === e.name ? "bg-panel shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "hover:bg-hover", off && "opacity-55")}>
                <EnvBadge env={e.name} /><span className={cn(env === e.name ? "text-fg" : "text-fg-3", off && "line-through")}>{e.title}</span>
                {svc && !off && !!h?.failed_24h && (
                  <span className="size-1.5 rounded-full bg-bad" title={`近 24 小时失败 ${h.failed_24h} 次`} aria-label={`近 24 小时失败 ${h.failed_24h} 次`} />
                )}
              </button>
            );
          })}
        </div>
        <span className="text-xs text-fg-3">代码目录、配置文件、只读库、日志、记忆都按所选环境解析</span>
      </div>

      <Tabs className="mb-5" value={tab} onChange={(v) => setSearch({ tab: v === "overview" ? undefined : v })} tabs={[
        { value: "overview", label: "概览", icon: <LuLayoutDashboard /> },
        { value: "envs", label: "环境", icon: <LuLayers /> },
        { value: "tasks", label: "任务", icon: <LuListTodo />, count: tasks?.filter((t) => !t.extends).length },
        { value: "runs", label: "运行", icon: <LuActivity /> },
        { value: "memory", label: "记忆", icon: <LuBrain /> },
        { value: "tools", label: "工具", icon: <LuPlug />, count: svc && Object.keys(svc.mcp ?? {}).length ? Object.keys(svc.mcp).length : undefined,
          hint: svc && Object.keys(svc.mcp ?? {}).length ? `声明了 ${Object.keys(svc.mcp).length} 个 MCP server` : undefined },
        { value: "config", label: "配置", icon: <LuSettings /> },
        { value: "versions", label: "版本", icon: <LuHistory /> },
      ]} />

      {!svc ? <Skeleton className="h-96" /> : (
        <>
          {tab === "overview" && <OverviewTab svc={svc} env={env} onOpenEnvs={() => setSearch({ tab: "envs" })} onOpenTools={() => setSearch({ tab: "tools" })}
            onOpenConfig={() => setSearch({ tab: "config", part: undefined })} />}
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
          {tab === "tools" && <ToolsTab svc={svc} onOpenConfig={() => setSearch({ tab: "config", part: "definition" })} />}
          {tab === "config" && <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Segmented value={search.part === "definition" ? "definition" : "files"} onChange={(v) => setSearch({ part: v === "files" ? undefined : v })}
                options={[{ value: "files", label: "配置文件", icon: <LuFileText /> }, { value: "definition", label: "服务定义", icon: <LuSettings /> }]} />
              <span className="text-xs text-fg-3">{search.part === "definition" ? "代码目录、配置文件路径、日志、MCP、环境、档案…保存即新版本"
                : envProtected ? `${env} 给 agent 的只读版配置：项目内核在这些路径上读到的就是它` : `${env} 直接用项目的真实配置，不用填`}</span>
            </div>
            {search.part === "definition"
              ? <ServiceConfigEditor svc={svc} onSaved={refetch} />
              : <ConfigFilesView svc={svc} env={env} onOpenDefinition={() => setSearch({ part: "definition" })} />}
          </div>}
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

function OverviewTab({ svc, env, onOpenEnvs, onOpenTools, onOpenConfig }: { svc: ServiceSummary; env: string; onOpenEnvs: () => void; onOpenTools: () => void; onOpenConfig: () => void }) {
  const { data: view } = useServiceEnv(svc.name, env);
  const { data: recent } = useRuns({ service: svc.name, env, limit: 8 });
  const [peek, setPeek] = useState<string | null>(null);
  const h = svc.health[env];
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <div className="min-w-0 space-y-4">
        {h && !h.enabled && svc.enabled && (
          <div className="flex items-center gap-3 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-[13px] text-warn">
            <LuPower className="size-4 shrink-0" /><span className="flex-1">{svc.name} 在 {env} 环境已停用：不接收运行、不起项目内核、定时暂停。</span>
            <Button size="sm" onClick={onOpenEnvs}>去启用</Button>
          </div>
        )}
        <Card>
          <CardHeader title="服务×环境视图" description={`agent 在 ${env} 里看到的就是这些：它就在部署主机上，读的是线上的代码目录`} />
          <div className="p-4">
            {!view ? <Skeleton className="h-48" /> : <ViewList svc={svc} view={view} onOpenTools={onOpenTools} onOpenConfig={onOpenConfig} onPeek={setPeek} />}
          </div>
        </Card>
      </div>
      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader title="近期运行" description={`${env} · 近 24 小时 ${h?.runs_24h ?? 0} 次，失败 ${h?.failed_24h ?? 0} 次`} />
          <RunMiniList runs={recent?.items} limit={8} />
        </Card>
        <Card>
          <CardHeader title="服务档案" description={`置顶逐字注入该服务在 ${env} 的每次运行`} icon={<LuScrollText />} />
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
      <ConfigPeek service={svc.name} env={env} path={peek} onClose={() => setPeek(null)} />
    </div>
  );
}

/** 服务×环境视图：代码与解释器 → 配置 → 库、日志、地址、工具 */
function ViewList({ svc, view, onOpenTools, onOpenConfig, onPeek }: {
  svc: ServiceSummary; view: ServiceView; onOpenTools: () => void; onOpenConfig: () => void; onPeek: (path: string) => void;
}) {
  const extraPaths = view.code_paths.filter((p) => p !== view.root);
  return (
    <DescList items={[
      ["代码目录", (
        <div className="space-y-0.5">
          <Mono copy>{view.root || "未配置"}</Mono>
          {extraPaths.map((p) => <Mono key={p}>{p}</Mono>)}
        </div>
      )],
      ["解释器", (
        <div>
          <Mono copy>{view.python}</Mono>
          <div className="mt-0.5 text-[11.5px] text-fg-3">py 工具（项目内核）用线上这个解释器</div>
        </div>
      )],
      ["配置文件", view.config_files.length ? (
        <div className="space-y-1.5">
          {view.config_files.map((f) => (
            <div key={f.key} className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="min-w-0 truncate font-mono text-[12px] text-fg" title={f.path}>{f.path}</span>
              {view.protected && <ConfigStatusBadges file={f} />}
              {view.protected && f.version != null && <button type="button" onClick={() => onPeek(f.key)} className="text-[11.5px] text-accent hover:underline">查看</button>}
            </div>
          ))}
          {view.protected ? (
            <button type="button" onClick={onOpenConfig} className="flex items-center gap-1 text-[11.5px] text-fg-3 hover:text-accent">
              <LuPencilLine className="size-3" />受保护的环境：给 agent 的只读版在「配置 → 配置文件」里填；线上真实配置平台不读
            </button>
          ) : (
            <div className="text-[11.5px] text-fg-3">直接用项目的真实配置：bash、py 里都能读，不用填</div>
          )}
        </div>
      ) : <span className="text-fg-3">未声明（可在「配置 → 服务定义」里写项目读配置的路径）</span>],
      ["只读库", <DbList databases={view.databases ?? {}} empty={<span className="text-fg-3">未配置（db_query 不可用）</span>} />],
      ["日志", <LogList logs={view.logs ?? {}} empty={<span className="text-fg-3">未配置（logs 工具不可用）</span>} />],
      ["地址", Object.keys(view.urls ?? {}).length ? <UrlList urls={view.urls} /> : <span className="text-fg-3">未配置</span>],
      ["服务工具", (view.mcp_servers ?? []).length ? (
        <button type="button" onClick={onOpenTools} className="flex flex-wrap items-center gap-1 text-left hover:text-accent">
          {view.mcp_servers.map((m) => <Badge key={m} tone="outline" icon={<LuPlug />} className="font-mono">{m}</Badge>)}
          <span className="text-[11.5px] text-fg-3">MCP，运行里自动带上</span>
        </button>
      ) : <span className="text-fg-3">无（可在「配置 → MCP」声明）</span>],
      ["主机", view.hosts.length ? <span className="font-mono text-[12px]">{view.hosts.join("、")}</span> : <span className="text-fg-3">未登记（host_metrics 不可用；host_status 照常）</span>],
      ...(svc.hidden?.length ? [["遮蔽", <span className="text-[12px] text-fg-3">另有 {svc.hidden.length} 个含口令的文件对 agent 遮蔽</span>] as [string, React.ReactNode]] : []),
    ]} />
  );
}

/** 给 agent 的只读版（密钥打码后）：只读查看 */
function ConfigPeek({ service, env, path, onClose }: { service: string; env: string; path: string | null; onClose: () => void }) {
  const { data, error } = useQuery(["services", service, "config-masked", env, path], () => api.serviceConfig(service, env, path!), { enabled: !!path });
  return (
    <Drawer open={!!path} onClose={onClose} title={data?.path ?? path ?? ""} subtitle={`${service} · ${env} · 给 agent 的只读版（敏感值已打码）`} width="w-[720px]">
      <div className="p-4">{error ? <ErrorState error={error} /> : data ? <CodeBlock code={data.content} maxHeight={9999} /> : <Skeleton className="h-64" />}</div>
    </Drawer>
  );
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
          description="在「配置 → MCP」里加一个 server（名字 + 连接配置），这里就会列出它的工具；比如 dagster 服务接上线上 Dagster 的运行记录、日志与重跑。"
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
      description: enabled ? "启用后该环境立即接收运行，定时恢复。" : "停用后：该环境的新运行全部拒收（原因码 service_env_disabled），定时暂停，项目内核不能启动；其它环境不受影响。",
      confirmText: enabled ? "启用" : "停用", danger: !enabled,
    });
    if (ok) await save(env, { enabled: enabled ? undefined : false }, enabled ? `${env} 已启用` : `${env} 已停用`);
  };
  return (
    <Card>
      <CardHeader title="各环境" description="服务×环境是 agent 实际操作的单位。启用 = 接收运行、能起项目内核。代码目录、解释器、只读库、日志、地址、档案的环境差异在「配置 → 服务定义 → 环境」里改。" icon={<LuLayers />} />
      <ul className="divide-y divide-line">
        {(envs ?? []).map((e) => {
          const o = svc.envs[e.name] ?? {};
          const h = svc.health[e.name];
          const on = h?.enabled !== false;
          const has = (v: unknown) => !!v && (typeof v !== "object" || Object.keys(v as object).length > 0);
          const overrides = [
            has(o.root) && "代码目录", has(o.python) && "解释器", has(o.hosts) && "主机", has(o.databases) && "只读库",
            has(o.code_paths) && "其他代码目录", has(o.logs) && "日志", has(o.urls) && "地址", has(o.profile) && "档案",
          ].filter(Boolean);
          return (
            <li key={e.name} className={cn("flex flex-wrap items-center gap-4 px-4 py-3.5", !on && "bg-sunken/50")}>
              <EnvBadge env={e.name} className="h-6 px-2 text-[12px]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
                  {e.title}{e.protected && <Badge tone="warn">受保护</Badge>}{!on && <Badge tone="idle">已停用</Badge>}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-fg-3">
                  <span>{overrides.length ? `覆盖了：${overrides.join("、")}` : "全部沿用基座配置"}</span>
                  <span>· 近 24h {h?.runs_24h ?? 0} 次运行</span>
                </div>
                {h?.python && <div className="mt-0.5 truncate font-mono text-[11.5px] text-fg-3" title="该环境的解释器">{h.python}</div>}
              </div>
              <Tooltip content={on ? "停用后这个环境不接收运行" : "启用后立即接收运行"}>
                <span><Switch checked={on} disabled={!svc.enabled} onChange={(v) => toggle(e.name, v)} label={<span className="text-[12.5px]">{on ? "启用" : "停用"}</span>} /></span>
              </Tooltip>
            </li>
          );
        })}
      </ul>
      {!svc.enabled && <div className="border-t border-line px-4 py-2.5 text-[12px] text-fg-3">服务整体已停用（右上角菜单），各环境开关暂不生效。</div>}
      <div className="border-t border-line px-4 py-2.5 text-[12px] text-fg-3">
        环境本身（有哪些、谁受保护）在 <Link to="/settings/envs" className="text-accent hover:underline">设置 → 环境</Link>。
      </div>
    </Card>
  );
}
