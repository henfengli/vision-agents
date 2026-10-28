/**
 * 服务详情：先选环境（服务×环境是 agent 实际操作的单位），再看线上的代码目录与解释器、
 * 配置、日志、任务、运行、记忆；「配置」tab 填本环境给 agent 的只读版配置（?tab=config&env=；只有受保护的环境要填，
 * 不受保护的直接用项目的真实配置）
 * 与结构化编辑服务定义（&part=definition），「版本」看历史与 diff。
 * 进来时 URL 没写环境就把解析出的环境写进去：页面看的是哪个环境一目了然，顶栏换视角也不会悄悄换掉页面内容。
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  LuArrowRight, LuBrain, LuCircleAlert, LuCircleDashed, LuEllipsis, LuExternalLink, LuFileText, LuFolder, LuHistory, LuListTodo,
  LuPause, LuPencilLine, LuPlay, LuPlug, LuPlus, LuPower, LuRefreshCw, LuScrollText, LuServer, LuSettings, LuActivity, LuLayers, LuLayoutDashboard,
  LuTrash2,
} from "react-icons/lu";

import { api, useEnvs, useRuns, useService, useServiceEnv, useServiceTools, useTasks } from "@/api/hooks";
import type { ServiceEnvOverride, ServiceSummary, ServiceView } from "@/api/types";
import { Page, PageHeader } from "@/components/layout/shell";
import { DbList } from "@/components/databases";
import { LogList } from "@/components/logs";
import { IdCopy, MetaVersion } from "@/components/meta";
import { DetailError } from "@/components/states";
import { DisabledBadge, EnvBadge, FailCount } from "@/components/status";
import { VersionHistory } from "@/components/versions";
import { Button, LinkButton } from "@/components/ui/button";
import { CodeBlock, Markdown, Mono, Tabs, Table, Td, Th, Tr } from "@/components/ui/data";
import { Segmented, Switch } from "@/components/ui/form";
import { Drawer, Menu, Tooltip, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, DescList, Empty, ErrorState, Skeleton, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { invalidate, setQueryData, useQuery } from "@/lib/query";
import { Link, navigate, useParams, useSearch } from "@/lib/router";
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
/** 打开某个标签（概览里的待办清单、提示条用） */
type Open = (to: { tab: TabKey; part?: ConfigPart; env?: string }) => void;

export function ServiceDetailPage() {
  const { name } = useParams<{ name: string }>();
  const [search, setSearch] = useSearch<{ tab: TabKey; env: string; part: ConfigPart }>();
  const { data: svc, error, refetch } = useService(name);
  const { data: envs } = useEnvs();
  const { env: globalEnv } = useUi();
  const [runOpen, setRunOpen] = useState(false);
  const allEnvs = envs ?? [];
  /** URL 没写环境时：顶栏的环境视角 > 第一个不受保护的 > 第一个 */
  const resolved = (allEnvs.find((e) => e.name === globalEnv) ?? allEnvs.find((e) => !e.protected) ?? allEnvs[0])?.name ?? "";
  const env = search.env || resolved || "test";
  /** 受保护（生产）要填给 agent 的只读版；不受保护（测试）直接用真实配置 */
  const envProtected = !!allEnvs.find((e) => e.name === env)?.protected;
  const tab = (search.tab as TabKey) || "overview";
  const tasksQ = useTasks(name);
  const tasks = tasksQ.data;
  // 进来就把环境写进 URL（替换当前记录，不多一步回退）：页面看的是哪个环境是明确的，
  // 顶栏切环境视角不会悄悄换掉页面内容——配置文件编辑器里没保存的修改也就不会不经确认就丢了
  useEffect(() => { if (!search.env && resolved) setSearch({ env: resolved }); }, [search.env, resolved]); // eslint-disable-line react-hooks/exhaustive-deps

  // 出错（含 404）时面包屑照常在，正文给"服务不存在 / 加载失败"和回到列表的入口
  if (error && !svc) return (
    <Page>
      <PageHeader crumbs={[{ label: "服务", to: "/services" }, { label: name }]} icon={<LuServer />} title={name} />
      <DetailError error={error} onRetry={refetch} what="服务" back={{ to: "/services", label: "回到服务列表" }} />
    </Page>
  );

  const open: Open = ({ tab: t, part, env: e }) => setSearch({ tab: t === "overview" ? undefined : t, part, ...(e ? { env: e } : {}) });

  /** 停用可逆（随时能启用回来）：danger 确认就够了，不用输名字（和任务、环境、方法的停用一致） */
  const toggle = async () => {
    if (!svc) return;
    const ok = await confirm({
      title: svc.enabled ? `停用服务 ${svc.name}？` : `启用服务 ${svc.name}？`,
      description: svc.enabled ? "停用后不再接收新的运行和事件，定时任务暂停；正在跑的不受影响，随时可以再启用。" : "启用后马上开始接收运行，定时任务恢复。",
      confirmText: svc.enabled ? "停用" : "启用", danger: svc.enabled,
    });
    if (!ok) return;
    try {
      await api.update("services", svc.name, { enabled: !svc.enabled });
      toast(svc.enabled ? `已停用服务 ${svc.name}` : `已启用服务 ${svc.name}`);
      invalidate("services");
    } catch (e) { toast.error(svc.enabled ? "停用失败" : "启用失败", (e as Error).message); }
  };

  const remove = async () => {
    if (!svc) return;
    const ok = await confirm({
      title: `删除服务 ${svc.name}？`, danger: true, confirmText: "删除", requireText: svc.name,
      description: "删除后不能再在这个服务上运行；历史运行、记忆和版本记录都保留。还有它的专属任务时删不掉，要先删掉或改掉那些任务。",
    });
    if (!ok) return;
    try {
      await api.remove("services", svc.name);
      toast(`已删除服务 ${svc.name}`);
      navigate("/services", { force: true });
      invalidate("services");
    } catch (e) { toast.error("删除失败", (e as Error).message); }
  };

  const ownTasks = (tasks ?? []).filter((t) => t.service === name);
  const genericTasks = (tasks ?? []).filter((t) => t.service === "*");
  const taskGroups = [
    { key: "own", title: "本服务专属", hint: "", rows: taskRowsOf(ownTasks) },
    { key: "generic", title: "通用任务（调用时指定服务）", hint: "每个服务都能用", rows: taskRowsOf(genericTasks) },
  ].filter((g) => g.rows.length);
  const taskCount = taskGroups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <Page wide>
      <PageHeader
        crumbs={[{ label: "服务", to: "/services" }, { label: name }]}
        icon={svc ? <ServiceAvatar name={svc.name} disabled={!svc.enabled} className="size-10 text-[16px]" /> : <LuServer />}
        title={<span className="flex items-center gap-2">{svc?.title ?? name}{svc && !svc.enabled && <DisabledBadge scope="service" />}</span>}
        description={svc?.description}
        meta={svc && <>
          <IdCopy value={svc.name} />
          {svc.root
            ? <span className="flex min-w-0 items-center gap-1"><LuFolder className="size-3.5 shrink-0" /><IdCopy value={svc.root} /></span>
            : <span className="flex items-center gap-1"><LuFolder className="size-3.5" />未配置代码目录</span>}
          <MetaVersion version={svc.version} by={svc.updated_by} at={svc.updated_at} />
        </>}
        actions={<>
          {/* 槽位固定：服务停用时禁用并说明原因（不隐藏）；加载中先灰着 */}
          <Button icon={<LuPlay />} variant="primary" onClick={() => setRunOpen(true)} disabled={!svc}
            reason={svc && !svc.enabled ? "服务已停用：先启用服务" : undefined}>运行任务</Button>
          {/* ⋯ 只放对这个服务的动作，版本走「版本」标签 */}
          <Menu trigger={<Button size="icon" variant="secondary" aria-label="更多"><LuEllipsis /></Button>} items={[
            { label: svc && !svc.enabled ? "启用服务" : "停用服务", icon: <LuPower />, danger: !!svc?.enabled, disabled: !svc, onClick: toggle },
            { separator: true, label: "" },
            { label: "删除服务", icon: <LuTrash2 />, danger: true, disabled: !svc, onClick: remove },
          ]} />
        </>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-fg-3">环境</span>
        <div className="inline-flex rounded-lg border border-line bg-sunken p-0.5">
          {allEnvs.map((e) => {
            const h = svc?.health[e.name];
            // 只看该环境自己的开关；服务整体停用在标题上说一次
            const off = h?.env_enabled === false;
            return (
              <button key={e.name} type="button" onClick={() => setSearch({ env: e.name })} aria-pressed={env === e.name}
                className={cn("flex h-7 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors", env === e.name ? "bg-panel shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "hover:bg-hover", off && "opacity-55")}>
                <EnvBadge env={e.name} /><span className={cn(env === e.name ? "text-fg" : "text-fg-3")}>{e.title}</span>
                {off && <DisabledBadge hint="这个服务在该环境已停用" />}
                {svc && !off && <FailCount n={h?.failed_24h} />}
              </button>
            );
          })}
        </div>
        <span className="text-xs text-fg-3">{svc && !svc.enabled ? "服务已停用：各环境都不接收运行" : "下面的内容都是所选环境的"}</span>
      </div>

      <Tabs className="mb-5" value={tab} onChange={(v) => setSearch({ tab: v === "overview" ? undefined : v })} tabs={[
        { value: "overview", label: "概览", icon: <LuLayoutDashboard /> },
        { value: "envs", label: "环境", icon: <LuLayers /> },
        { value: "tasks", label: "任务", icon: <LuListTodo />, count: tasks ? taskCount : undefined, hint: tasks ? `专属 ${ownTasks.filter((t) => !t.extends).length} 个 · 通用 ${genericTasks.filter((t) => !t.extends).length} 个` : undefined },
        { value: "runs", label: "运行", icon: <LuActivity /> },
        { value: "memory", label: "记忆", icon: <LuBrain /> },
        { value: "tools", label: "工具", icon: <LuPlug />, count: svc && Object.keys(svc.mcp ?? {}).length ? Object.keys(svc.mcp).length : undefined,
          hint: svc && Object.keys(svc.mcp ?? {}).length ? `声明了 ${Object.keys(svc.mcp).length} 个 MCP server` : undefined },
        { value: "config", label: "配置", icon: <LuSettings /> },
        { value: "versions", label: "版本", icon: <LuHistory /> },
      ]} />

      {!svc ? <Skeleton className="h-96" /> : (
        <>
          {tab === "overview" && <OverviewTab svc={svc} env={env} open={open} onToggleService={toggle} />}
          {tab === "envs" && <EnvsTab svc={svc} onSaved={refetch} onToggleService={toggle} />}
          {tab === "tasks" && <Card>{tasksQ.error && !tasks ? <ErrorState error={tasksQ.error} onRetry={() => void tasksQ.refetch()} />
            : !tasks ? <SkeletonRows rows={4} /> : taskGroups.length ? <TasksTable groups={taskGroups} /> : (
              <Empty icon={<LuListTodo />} title="还没有任务" description="新建一个属于这个服务的任务；通用任务每个服务都能用，也会列在这里"
                action={<LinkButton size="sm" icon={<LuPlus />} to={`/tasks/_new?service=${encodeURIComponent(svc.name)}`}>新建任务</LinkButton>} />
            )}</Card>}
          {tab === "runs" && <RunsTab service={svc.name} env={env} />}
          {tab === "memory" && <div className="space-y-4">
            <div className="text-xs text-fg-3">
              {env} 的记忆，加上对所有环境都成立的。被反复用到的记忆可以升格进档案（<Link to={`/memory?tab=promotable&service=${svc.name}`} className="text-accent hover:underline">看可升格的</Link>）。
            </div>
            <KnowledgeList filters={{ service: svc.name, env: env || undefined }} scope={{ service: svc.name }} />
            <AssetList filters={{ service: svc.name, env: env || undefined }} scope={{ service: svc.name }} />
          </div>}
          {tab === "tools" && <ToolsTab svc={svc} onOpenConfig={() => open({ tab: "config", part: "definition" })} />}
          {tab === "config" && <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Segmented value={search.part === "definition" ? "definition" : "files"} onChange={(v) => setSearch({ part: v === "files" ? undefined : v })}
                options={[{ value: "files", label: "配置文件", icon: <LuFileText /> }, { value: "definition", label: "服务定义", icon: <LuSettings /> }]} />
              <span className="text-xs text-fg-3">{search.part === "definition" ? "服务的全部配置，保存即生成新版本"
                : envProtected ? `${env} 受保护：agent 读到的是这里填的只读版配置` : `${env} 直接用项目的真实配置，不用填`}</span>
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

/** 「全部 →」：卡片头右侧的统一写法（不放卡片底部） */
const runsHref = (service: string, env: string) => `/runs?service=${encodeURIComponent(service)}&env=${encodeURIComponent(env)}`;
const AllRuns = ({ service, env }: { service: string; env: string }) => (
  <LinkButton to={runsHref(service, env)} size="xs" variant="ghost">全部 <LuArrowRight /></LinkButton>
);

function RunsTab({ service, env }: { service: string; env: string }) {
  const { data, loading, error, refetch } = useRuns({ service, env, limit: 30 });
  return (
    <Card>
      <CardHeader title="运行" description={`${env} 最近 30 次`} actions={<AllRuns service={service} env={env} />} />
      {error && !data ? <ErrorState error={error} onRetry={() => void refetch()} />
        : <RunsTable runs={data?.items} loading={loading} columns={["status", "task", "trigger", "duration", "tokens", "time"]}
            empty={<Empty icon={<LuActivity />} title="还没有运行" description={`${service} 在 ${env} 还没有运行过`} />} />}
    </Card>
  );
}

function OverviewTab({ svc, env, open, onToggleService }: { svc: ServiceSummary; env: string; open: Open; onToggleService: () => void }) {
  const { data: view, error: viewError, refetch: refetchView } = useServiceEnv(svc.name, env);
  const { data: recent, error: recentError, refetch: refetchRecent } = useRuns({ service: svc.name, env, limit: 20 });
  const [peek, setPeek] = useState<string | null>(null);
  const h = svc.health[env];
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <div className="min-w-0 space-y-4">
        {!svc.enabled ? (
          <div className="flex items-center gap-3 rounded-lg border border-line bg-sunken px-4 py-3 text-[13px] text-fg-2">
            <LuPower className="size-4 shrink-0 text-fg-3" /><span className="flex-1">服务已停用：所有环境都不接收运行，定时任务暂停。</span>
            <Button size="sm" onClick={onToggleService}>启用服务</Button>
          </div>
        ) : h && !h.env_enabled && (
          <div className="flex items-center gap-3 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-[13px] text-warn">
            <LuPower className="size-4 shrink-0" /><span className="flex-1">{svc.name} 在 {env} 已停用：这个环境不接收运行，定时暂停。</span>
            <Button size="sm" onClick={() => open({ tab: "envs" })}>去启用</Button>
          </div>
        )}
        {svc.enabled && h?.env_enabled && h.triggers_paused && (
          <div className="flex items-center gap-3 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-[13px] text-warn">
            <LuPause className="size-4 shrink-0" /><span className="flex-1">{svc.name} 在 {env} 暂停了自动触发：定时、事件、上游联动都不建运行，手动运行和 API 照常。</span>
            <Button size="sm" onClick={() => open({ tab: "envs" })}>去恢复</Button>
          </div>
        )}
        <SetupChecklist svc={svc} open={open} />
        <Card>
          <CardHeader title="环境详情" description={`${env} 里 agent 能读的代码、配置、库和日志`} />
          {viewError && !view ? <ErrorState error={viewError} onRetry={() => void refetchView()} /> : (
            <div className="p-4">
              {!view ? <Skeleton className="h-48" /> : <ViewList svc={svc} view={view} onOpenTools={() => open({ tab: "tools" })} onOpenConfig={() => open({ tab: "config" })} onPeek={setPeek} />}
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title="服务档案" description="人写的固定说明，每次运行都原样带上" icon={<LuScrollText />} />
          <div className="p-4">
            {viewError && !view ? <div className="text-[12.5px] text-fg-3">环境详情没加载出来，档案也看不了；上面点「重试」。</div>
              : !view ? <Skeleton className="h-24" /> : Object.keys(view.profile).length === 0 ? (
              <div className="text-[12.5px] text-fg-3">还没有档案。去「配置 → 服务定义 → 服务档案」写下代码里看不出来的口径、禁区和踩过的坑。</div>
            ) : (
              <dl className="grid gap-x-6 gap-y-3 md:grid-cols-2">
                {Object.entries(view.profile).map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-[11.5px] font-medium text-fg-3">{PROFILE_LABEL[k] ?? k}</dt>
                    <dd className="mt-0.5 break-words"><Markdown text={v} className="text-[13px]" /></dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </Card>
      </div>
      {/* 宽屏时和左边一样高、列表在卡片里滚动：两栏底部对齐，不会一边空一大截 */}
      <div className="relative min-w-0 xl:min-h-[360px]">
        <Card className="flex flex-col xl:absolute xl:inset-0">
          <CardHeader title="近期运行" description={`${env} · 近 24 小时 ${h?.runs_24h ?? 0} 次，失败 ${h?.failed_24h ?? 0} 次`} actions={<AllRuns service={svc.name} env={env} />} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* RunMiniList 在没数据时一直转骨架：出错先在这里接住 */}
            {recentError && !recent ? <ErrorState error={recentError} onRetry={() => void refetchRecent()} className="py-6" /> : <RunMiniList runs={recent?.items} limit={20} />}
          </div>
        </Card>
      </div>
      <ConfigPeek service={svc.name} env={env} path={peek} onClose={() => setPeek(null)} />
    </div>
  );
}

// ———————— 概览：还没配完的项 ————————

interface SetupItem { key: string; text: ReactNode; optional?: boolean; action: string; to: Parameters<Open>[0] }

/**
 * 新建的服务（或缺东西的服务）：列出还要补的配置，每项一个直达的链接。都配好了就不显示。
 * 必填：代码目录、受保护环境给 agent 的只读版配置；建议：项目 Python、只读库、日志。
 */
function SetupChecklist({ svc, open }: { svc: ServiceSummary; open: Open }) {
  const { data: envs } = useEnvs();
  const overrides = Object.values(svc.envs ?? {});
  const protectedEnvs = (envs ?? []).filter((e) => e.protected && svc.health[e.name]?.enabled !== false).map((e) => e.name);
  const needConfigs = svc.configs.length > 0 && protectedEnvs.length > 0;
  const { data: views } = useQuery(["services", svc.name, "setup", protectedEnvs, svc.version],
    () => Promise.all(protectedEnvs.map((e) => api.serviceEnv(svc.name, e))), { enabled: needConfigs });
  const definition = { tab: "config" as const, part: "definition" as const };
  const items: SetupItem[] = [];
  if (!svc.root && !overrides.some((o) => o.root)) items.push({ key: "root", text: "还没填代码目录：agent 读不到线上代码", action: "去填", to: definition });
  for (const v of views ?? []) {
    const missing = v.config_files.filter((f) => f.version == null).length;
    if (missing) items.push({ key: "configs-" + v.env, text: <>{v.env} 还有 {missing} 个配置文件没填只读版：在 {v.env} 跑不了项目代码</>, action: "去填", to: { tab: "config", env: v.env } });
  }
  if (!svc.python && !overrides.some((o) => o.python)) items.push({ key: "python", optional: true, text: "项目 Python 用的是默认的 python3：项目有自己的虚拟环境就填上", action: "去填", to: definition });
  const hasDbs = Object.values(svc.databases ?? {}).some(Boolean) || overrides.some((o) => Object.values(o.databases ?? {}).some(Boolean));
  if (!hasDbs) items.push({ key: "databases", optional: true, text: "还没配只读库：agent 查不了库", action: "去配置", to: definition });
  const hasLogs = Object.keys(svc.logs ?? {}).length > 0 || overrides.some((o) => Object.values(o.logs ?? {}).some(Boolean));
  if (!hasLogs) items.push({ key: "logs", optional: true, text: "还没配日志：agent 看不了线上日志", action: "去配置", to: definition });
  if (!items.length) return null;
  return (
    <Card>
      <CardHeader title="还没配完" description="补上这些，agent 才能完整地排查这个服务" icon={<LuCircleAlert className="text-warn" />} />
      <ul className="divide-y divide-line">
        {items.map((it) => (
          <li key={it.key} className="flex items-center gap-2.5 px-4 py-2 text-[12.5px]">
            {it.optional ? <LuCircleDashed className="size-3.5 shrink-0 text-fg-3" /> : <LuCircleAlert className="size-3.5 shrink-0 text-warn" />}
            <span className={cn("min-w-0 flex-1", it.optional ? "text-fg-2" : "text-fg")}>{it.text}</span>
            {it.optional && <span className="shrink-0 text-[11px] text-fg-3">建议</span>}
            <Button size="xs" variant="ghost" className="text-accent" onClick={() => open(it.to)}>{it.action}</Button>
          </li>
        ))}
      </ul>
    </Card>
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
          <div className="mt-0.5 text-[11.5px] text-fg-3">跑项目代码用这个 Python</div>
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
              <LuPencilLine className="size-3" />受保护的环境：agent 用的只读版在「配置 → 配置文件」里填
            </button>
          ) : (
            <div className="text-[11.5px] text-fg-3">直接用项目的真实配置，不用填</div>
          )}
        </div>
      ) : <span className="text-fg-3">未声明</span>],
      ["只读库", <DbList databases={view.databases ?? {}} empty={<span className="text-fg-3">未配置（查不了库）</span>} />],
      ["日志", <LogList logs={view.logs ?? {}} empty={<span className="text-fg-3">未配置（看不了日志）</span>} />],
      ["地址", Object.keys(view.urls ?? {}).length ? <UrlList urls={view.urls} /> : <span className="text-fg-3">未配置</span>],
      ["服务工具", (view.mcp_servers ?? []).length ? (
        <button type="button" onClick={onOpenTools} className="flex flex-wrap items-center gap-1 text-left hover:text-accent">
          {view.mcp_servers.map((m) => <Badge key={m} tone="outline" icon={<LuPlug />} className="font-mono">{m}</Badge>)}
          <span className="text-[11.5px] text-fg-3">运行时自动可用</span>
        </button>
      ) : <span className="text-fg-3">无</span>],
      ...(svc.hidden?.length ? [["遮蔽", <span className="text-[12px] text-fg-3">另有 {svc.hidden.length} 个含口令的文件 agent 看不到</span>] as [string, React.ReactNode]] : []),
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
        description="服务自己声明的工具，运行在这个服务上时自动可用。"
        actions={servers.length > 0 && <Button size="sm" icon={<LuRefreshCw />} loading={reloading} onClick={reload}>重新连接</Button>} />
      {error ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={4} /> : !servers.length ? (
        <Empty icon={<LuPlug />} title="这个服务没有声明 MCP"
          description="在「配置 → 服务定义 → MCP」里加一个，这里就会列出它的工具。"
          action={<Button size="sm" onClick={onOpenConfig}>去配置</Button>} />
      ) : (
        <>
          {!!data?.failed.length && (
            <div className="flex gap-2 border-b border-line bg-warn-soft px-4 py-2.5 text-[12.5px] text-warn">
              <LuCircleAlert className="mt-0.5 size-4 shrink-0" />
              <span>这些连接失败：<span className="font-mono">{data.failed.join("、")}</span>。检查连接配置和服务端是否在线，改好后点「重新连接」。</span>
            </div>
          )}
          {data && !data.loaded && <div className="border-b border-line px-4 py-2.5 text-[12.5px] text-fg-3">还没连过：点「重新连接」现连一次。</div>}
          {!data?.tools.length ? (
            <Empty title="没有可用的工具" description={`声明了 ${servers.join("、")}，但没拿到工具：看上面的连接失败提示，或检查 MCP 服务端`} />
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

function EnvsTab({ svc, onSaved, onToggleService }: { svc: ServiceSummary; onSaved: () => void; onToggleService: () => void }) {
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
      description: enabled ? "启用后这个环境马上开始接收运行，定时恢复。" : "停用后这个环境不再接收运行，定时暂停；其它环境不受影响。",
      confirmText: enabled ? "启用" : "停用", danger: !enabled,
    });
    if (ok) await save(env, { enabled: enabled ? undefined : false }, enabled ? `已在 ${env} 启用 ${svc.name}` : `已在 ${env} 停用 ${svc.name}`);
  };
  /** 暂停自动触发：维护窗口（库重启、发版）里定时、事件、上游联动都不建运行，人手动跑、API、对话照常 */
  const pause = async (env: string, paused: boolean) => {
    const ok = await confirm({
      title: paused ? `暂停 ${svc.name} 在 ${env} 的自动触发？` : `恢复 ${svc.name} 在 ${env} 的自动触发？`,
      description: paused
        ? "定时、事件、上游联动在这个环境都不再建运行（触发记录里记成「被拒」）；手动运行、API、对话照常。维护完记得恢复。"
        : "恢复后定时按下一个时刻触发、事件和联动马上照常建运行；暂停期间错过的不会补。",
      confirmText: paused ? "暂停" : "恢复", danger: paused,
    });
    if (ok) await save(env, { triggers_paused: paused ? true : undefined }, paused ? `已暂停 ${env} 的自动触发` : `已恢复 ${env} 的自动触发`);
  };
  return (
    <Card>
      <CardHeader title="各环境" description="每个环境可以单独启用或停用、暂停自动触发；各环境不同的配置在「配置 → 服务定义 → 环境」里改。" icon={<LuLayers />} />
      {/* 直接给按钮，不指路去「⋯」 */}
      {!svc.enabled && (
        <div className="flex items-center gap-3 border-b border-line bg-sunken/60 px-4 py-2.5 text-[12.5px] text-fg-2">
          <LuPower className="size-4 shrink-0 text-fg-3" /><span className="flex-1">服务已停用：下面的开关要等服务启用后才生效。</span>
          <Button size="sm" onClick={onToggleService}>启用服务</Button>
        </div>
      )}
      <ul className="divide-y divide-line">
        {(envs ?? []).map((e) => {
          const o = svc.envs[e.name] ?? {};
          const h = svc.health[e.name];
          // 该环境自己的开关（服务整体停用不算在这里）
          const on = h?.env_enabled !== false;
          const has = (v: unknown) => !!v && (typeof v !== "object" || Object.keys(v as object).length > 0);
          const overrides = [
            has(o.root) && "代码目录", has(o.python) && "解释器", has(o.databases) && "只读库",
            has(o.code_paths) && "其他代码目录", has(o.logs) && "日志", has(o.urls) && "地址", has(o.profile) && "档案",
          ].filter(Boolean);
          return (
            <li key={e.name} className={cn("flex flex-wrap items-center gap-4 px-4 py-3.5", !on && "bg-sunken/50")}>
              <span className="w-[72px] shrink-0"><EnvBadge env={e.name} className="h-6 px-2 text-[12px]" /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
                  {e.title}{e.protected && <Badge tone="warn">受保护</Badge>}{!on && <DisabledBadge scope="env" />}
                  {on && o.triggers_paused && <Badge tone="warn" icon={<LuPause />}>自动触发已暂停</Badge>}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-fg-3">
                  <span>{overrides.length ? `单独配置了：${overrides.join("、")}` : "和其它环境用同一套配置"}</span>
                  <span>· 近 24 小时 {h?.runs_24h ?? 0} 次运行</span>
                </div>
                {h?.python && <div className="mt-0.5 truncate font-mono text-[11.5px] text-fg-3" title="该环境的解释器">{h.python}</div>}
              </div>
              <Tooltip content={!on ? "环境停用时什么都不跑，不用单独暂停" : o.triggers_paused ? "恢复定时、事件、上游联动" : "维护窗口用：定时、事件、上游联动都不建运行，手动运行和 API 照常"}>
                <span><Switch checked={!!o.triggers_paused} disabled={!on || !svc.enabled} onChange={(v) => pause(e.name, v)}
                  label={<span className="text-[12.5px]">暂停自动触发</span>} /></span>
              </Tooltip>
              <Tooltip content={!svc.enabled ? "服务已停用，先启用服务" : on ? "停用后这个环境不接收运行" : "启用后马上接收运行"}>
                <span><Switch checked={on} disabled={!svc.enabled} onChange={(v) => toggle(e.name, v)} label={<span className="text-[12.5px]">{on ? "启用" : "停用"}</span>} /></span>
              </Tooltip>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-line px-4 py-2.5 text-[12px] text-fg-3">
        有哪些环境、哪些受保护，在 <Link to="/settings/envs" className="text-accent hover:underline">设置 → 环境</Link> 里改。
      </div>
    </Card>
  );
}
