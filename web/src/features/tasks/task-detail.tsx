/**
 * 任务详情。父任务与子任务共用一页，标签按身份取舍：
 *   概览 · 档案 · 子任务（仅父任务）· 记忆 · 定义 / 覆盖 · 运行 · 版本
 * 接口返回的子任务已经是"父任务 + 自己的差异"合并后的样子，overrides 指出哪些字段是它自己写的。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LuActivity, LuArrowRight, LuBraces, LuBrain, LuCalendarClock, LuCopy, LuEllipsis, LuGitBranch, LuHistory, LuLayoutDashboard, LuListTodo, LuPencil,
  LuPlay, LuPlus, LuPower, LuScrollText, LuSettings, LuTrash2, LuWebhook, LuZap,
} from "react-icons/lu";

import { api, useEnvs, useRuns, useSubtasks, useTask, useTasks } from "@/api/hooks";
import type { TaskSummary, Trigger } from "@/api/types";
import { EnvFilter, ServiceFilter } from "@/components/filters";
import { Page, PageHeader } from "@/components/layout/shell";
import { SaveBar } from "@/components/save-bar";
import { EnvBadge, RoleChip, RunStatusDot, TRIGGER } from "@/components/status";
import { VersionHistory } from "@/components/versions";
import { Button } from "@/components/ui/button";
import { CodeBlock, KeyValueEditor, Markdown, Tabs, Table, Td, Th, Tr } from "@/components/ui/data";
import { Checkbox, Input, SearchInput, Textarea, objectNameError } from "@/components/ui/form";
import { Menu, Tooltip, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, DescList, Empty, ErrorState, Skeleton, Stat } from "@/components/ui/primitives";
import { describeCron, nextRuns } from "@/lib/cron";
import { cn } from "@/lib/cn";
import { ago, dayjs, duration, pct, seconds } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { Link, navigate, useParams, useSearch } from "@/lib/router";
import { useUi } from "@/lib/store";
import { AssetList, KnowledgeList } from "../memory/memory";
import { RunsTable, type RunColumn } from "../runs/runs-table";
import { PROFILE_LABEL } from "../services/service-detail";
import { ASK_TASK, RunTaskDialog } from "./run-dialog";
import { TaskDefinitionEditor } from "./task-editor";
import { FORM_META } from "./tasks";

type TabKey = "overview" | "profile" | "subtasks" | "memory" | "definition" | "runs" | "versions";

const PROFILE_SUGGESTIONS = Object.entries(PROFILE_LABEL).map(([key, label]) => ({ key, label }));

export const taskHref = (name: string, tab?: TabKey) => `/tasks/${encodeURIComponent(name)}${tab ? `?tab=${tab}` : ""}`;

export function TaskDetailPage() {
  const { name } = useParams<{ name: string }>();
  const [search, setSearch] = useSearch<{ tab: TabKey }>();
  const { data: task, error, refetch } = useTask(name);
  const { data: all } = useTasks();
  const [runOpen, setRunOpen] = useState(false);

  const [parentName, object] = name.includes(":") ? name.split(":", 2) : [null, null];
  const isSub = !!parentName;
  const parent = isSub ? all?.find((t) => t.name === parentName) : undefined;
  const tab = search.tab || "overview";

  if (error) return <Page><ErrorState error={error} onRetry={refetch} /></Page>;

  const toggle = async () => {
    if (!task) return;
    const ok = await confirm({
      title: task.enabled ? `停用 ${task.name}？` : `启用 ${task.name}？`,
      description: task.enabled ? "停用后新提交与事件拒收（task_disabled），定时暂停。" : "启用后立即恢复。",
      danger: task.enabled, confirmText: task.enabled ? "停用" : "启用",
    });
    if (!ok) return;
    try {
      await api.update("tasks", task.name, { enabled: !task.enabled });
      toast(task.enabled ? "已停用" : "已启用");
      invalidate("tasks");
    } catch (e) { toast.error(task.enabled ? "停用失败" : "启用失败", (e as Error).message); }
  };

  const remove = async () => {
    if (!task) return;
    const ok = await confirm({
      title: `删除 ${task.name}？`, danger: true, confirmText: "删除", requireText: task.name,
      description: <>删除后不能再提交，历史运行保留。{task.subtask_count > 0 && <>它的 <b>{task.subtask_count}</b> 个子任务会一起删除。</>}版本台账也保留，要恢复得调接口 <code className="font-mono">POST /v1/tasks/{"{name}"}/versions/{"{v}"}/restore</code>（控制台里删掉的任务打不开）。</>,
    });
    if (!ok) return;
    try {
      const r = await api.remove("tasks", task.name);
      toast(`已删除 ${r.deleted.length} 个任务`);
      invalidate("tasks");
      navigate(parentName ? taskHref(parentName, "subtasks") : "/tasks");
    } catch (e) { toast.error("删除失败", (e as Error).message); }
  };

  /** 内建任务和通用入口没有子任务 */
  const hasSubtasks = !isSub && !!task && task.form === "agent" && task.name !== ASK_TASK;
  const pendingProfile = isSub && !!task && !task.overrides.includes("profile");
  const tabs = [
    { value: "overview" as TabKey, label: "概览", icon: <LuLayoutDashboard /> },
    { value: "profile" as TabKey, label: "档案", icon: <LuScrollText />, count: task ? Object.keys(task.profile).length : undefined },
    ...(hasSubtasks ? [{ value: "subtasks" as TabKey, label: "子任务", icon: <LuGitBranch />, count: task?.subtask_count }] : []),
    { value: "memory" as TabKey, label: "记忆", icon: <LuBrain /> },
    { value: "definition" as TabKey, label: isSub ? "覆盖" : "定义", icon: <LuSettings /> },
    { value: "runs" as TabKey, label: "运行", icon: <LuActivity /> },
    { value: "versions" as TabKey, label: "版本", icon: <LuHistory /> },
  ];

  return (
    <Page wide>
      <PageHeader
        crumbs={[{ label: "任务", to: "/tasks" }, ...(parentName ? [{ label: parentName, to: taskHref(parentName) }] : []), { label: object ?? name }]}
        icon={isSub ? <LuGitBranch /> : <LuListTodo />}
        title={<span className="flex items-center gap-2">
          {isSub ? <span className="font-mono">{object}</span> : task?.title || name}
          {isSub && task?.overrides.includes("title") && task.title && <span className="text-[15px] font-normal text-fg-3">{task.title}</span>}
          {task && !task.enabled && <Badge tone="idle">已停用</Badge>}
          {pendingProfile && (
            <Tooltip content={task?.auto_created ? "运行时自动建的对象，还没写它的专属档案" : "还没写它的专属档案"}>
              <button type="button" onClick={() => setSearch({ tab: "profile" })}><Badge tone="warn">档案待补</Badge></button>
            </Tooltip>
          )}
        </span>}
        description={isSub
          ? <><Link to={taskHref(parentName!)} className="text-accent hover:underline">{parent?.title || parentName}</Link> 针对这个对象的子任务：其余都跟随父任务，这里放它自己的档案和记忆</>
          : task?.description}
        meta={task && <>
          <span className="font-mono">{task.name}</span>
          <span>{task.service === "*" ? "通用任务" : task.service ? <>服务 <Link to={`/services/${task.service}`} className="text-fg-2 hover:text-accent">{task.service}</Link></> : "平台任务"}</span>
          <span>{FORM_META[task.form].label}</span>
          <RoleChip role={task.role} />
          <span>v{task.version} · {task.updated_by} · {ago(task.updated_at)}</span>
        </>}
        actions={<>
          <Button variant="primary" icon={<LuPlay />} onClick={() => setRunOpen(true)} disabled={!task?.enabled || (isSub && parent?.enabled === false)}
            title={!task?.enabled ? "任务已停用" : isSub && parent?.enabled === false ? "父任务已停用" : undefined}>运行</Button>
          <Menu trigger={<Button size="icon" aria-label="更多"><LuEllipsis /></Button>} items={[
            { label: task?.enabled ? "停用任务" : "启用任务", icon: <LuPower />, onClick: toggle },
            ...(!isSub ? [{ label: "复制为新任务", icon: <LuCopy />, onClick: () => navigate(`/tasks/_new?from=${encodeURIComponent(name)}`) }] : []),
            { label: "查看全部运行", icon: <LuActivity />, onClick: () => navigate(`/runs?task=${encodeURIComponent(name)}`) },
            { separator: true, label: "" },
            { label: "删除任务", icon: <LuTrash2 />, danger: true, onClick: remove },
          ]} />
        </>}
      />
      <Tabs className="mb-5" value={tab} onChange={(v) => setSearch({ tab: v === "overview" ? undefined : v })} tabs={tabs} />
      {!task ? <Skeleton className="h-96" /> : (
        <>
          {tab === "overview" && <OverviewTab task={task} parent={parent} onEditProfile={() => setSearch({ tab: "profile" })} />}
          {tab === "profile" && (isSub && !parent ? <Skeleton className="h-64" /> : <ProfileTab task={task} parent={parent} />)}
          {tab === "subtasks" && hasSubtasks && <SubtasksTab task={task} />}
          {tab === "memory" && <MemoryTab task={task} />}
          {tab === "definition" && (isSub ? <OverridesTab task={task} parent={parent} /> : <TaskDefinitionEditor task={task} onSaved={refetch} />)}
          {tab === "runs" && <TaskRuns task={task} />}
          {tab === "versions" && <VersionHistory kind="tasks" name={name} onRestored={refetch} stats />}
        </>
      )}
      <RunTaskDialog open={runOpen} onClose={() => setRunOpen(false)} task={parentName ?? name} subtask={object ?? undefined} />
    </Page>
  );
}

/** 任务页里的运行列：专属任务不用列服务；有子任务的父任务列出是哪个对象 */
const runColumns = (task: TaskSummary, wide: boolean): RunColumn[] => [
  "status", ...(task.subtask_count > 0 && !task.extends ? ["task" as const] : []), ...(task.service === "*" ? ["service" as const] : []),
  "env", ...(wide ? ["trigger" as const] : []), "duration", "time",
];

function TaskRuns({ task }: { task: TaskSummary }) {
  // 和运行页一样跟随顶栏的环境视角（"查看全部运行"跳过去看到的是同一批）
  const { env } = useUi();
  const { data, loading } = useRuns({ task: task.name, env: env || undefined, limit: 30 });
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs text-fg-3">
        {env ? `只看 ${env} 的（顶栏的环境视角）` : "最近 30 次"}
        <Link to={`/runs?task=${encodeURIComponent(task.name)}${env ? `&env=${env}` : ""}`} className="ml-auto flex items-center gap-1 hover:text-accent">在运行页看全部 <LuArrowRight className="size-3" /></Link>
      </div>
      <RunsTable runs={data?.items} loading={loading} columns={runColumns(task, true)} />
    </Card>
  );
}

// ———————— 概览 ————————

function OverviewTab({ task, parent, onEditProfile }: { task: TaskSummary; parent: TaskSummary | undefined; onEditProfile: () => void }) {
  const { env } = useUi();
  const { data: runs } = useRuns({ task: task.name, env: env || undefined, limit: 10 });
  const s = task.stats_24h;
  const sub = !!task.extends;
  const ownTriggers = !sub || task.overrides.includes("triggers");
  const object = task.name.split(":")[1];
  const objectInput = parent?.object_input ?? task.object_input;
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <div className="min-w-0 space-y-4">
        <Card className="grid grid-cols-2 sm:grid-cols-4 sm:divide-x sm:divide-line">
          <div className="px-4 py-3.5"><Stat label="近 24h 运行" value={s.runs} /></div>
          <div className="px-4 py-3.5"><Stat label="成功率" value={pct(s.success, s.success + s.failed)} tone={s.failed ? "warn" : "ok"} /></div>
          <div className="px-4 py-3.5"><Stat label="失败" value={s.failed} tone={s.failed ? "bad" : undefined} /></div>
          <div className="px-4 py-3.5"><Stat label="耗时 P50" value={duration(s.p50_ms)} /></div>
        </Card>
        <Card>
          <CardHeader title="触发" icon={<LuZap />} description={ownTriggers ? "这个任务会被什么启动" : "这个对象没有自己的触发：由父任务接收"} />
          {!ownTriggers ? (
            <div className="space-y-1.5 px-4 py-3.5 text-[12.5px] text-fg-2">
              <div>定时、事件都由父任务 <Link to={taskHref(task.extends!)} className="text-accent hover:underline">{parent?.title || task.extends}</Link> 接收。</div>
              {objectInput
                ? <div className="text-fg-3">事件或 API 调用里 <code className="font-mono">{objectInput}</code> 是 <code className="font-mono">{object}</code> 时，运行会落到这里，带上这个对象的档案。</div>
                : <div className="text-fg-3">调用时点名这个对象（subtask 字段）才会落到这里；在控制台可以直接点「运行」。</div>}
            </div>
          ) : task.triggers.length === 0 ? <Empty title="没有触发" description="只能在控制台手动运行" /> : (
            <ul className="divide-y divide-line">{task.triggers.map((tr) => <TriggerRow key={tr.id} tr={tr} />)}</ul>
          )}
        </Card>
        <Card>
          <CardHeader title="近期运行" description={env ? `只看 ${env}（顶栏的环境视角）` : undefined}
            actions={<Link to={`/runs?task=${encodeURIComponent(task.name)}${env ? `&env=${env}` : ""}`} className="flex items-center gap-1 text-xs text-fg-3 hover:text-accent">全部 <LuArrowRight className="size-3" /></Link>} />
          <RunsTable runs={runs?.items} columns={runColumns(task, false)} compact empty={<Empty title="还没有运行" description={env ? `${env} 环境下还没跑过` : "点右上角「运行」手动跑一次"} />} />
        </Card>
      </div>
      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader title="任务档案" icon={<LuScrollText />} description="置顶逐字注入每次运行"
            actions={<Button size="sm" variant="ghost" icon={<LuPencil />} onClick={onEditProfile}>编辑</Button>} />
          <div className="p-4"><ProfileView profile={task.profile} /></div>
        </Card>
        <Card>
          <CardHeader title="定义摘要" />
          <div className="p-4">
            <DescList items={[
              ...(task.form === "builtin"
                ? [["处理器", <code className="font-mono text-[12px]">{task.handler}</code>] as [ReactNode, ReactNode]]
                : [["角色", task.role ? <Link to={`/settings/roles/${task.role}`} className="text-accent hover:underline">{task.role}</Link> : "—"] as [ReactNode, ReactNode]]),
              ["归属", task.service === "*" ? "通用（运行时指定服务）" : task.service ?? "平台任务"],
              ["环境", task.envs.length ? <span className="flex flex-wrap gap-1">{task.envs.map((e) => <EnvBadge key={e} env={e} />)}</span> : "所有环境"],
              ["结果", <DeliverText task={task} />],
              ...(task.form === "agent" ? [["记忆", <MemoryText task={task} />] as [ReactNode, ReactNode]] : []),
              ...(objectInput ? [["对象字段", <span><code className="font-mono text-[12px]">{objectInput}</code><span className="text-fg-3"> 的值就是子任务</span></span>] as [ReactNode, ReactNode]] : []),
              ["去重", task.dedup ? <span>同样的 <code className="font-mono text-[12px]">{task.dedup.key}</code> {seconds(task.dedup.window_s)}内只跑一次</span> : "不去重"],
              ["超时", seconds(task.timeout_s)],
            ]} />
          </div>
        </Card>
        <Card>
          <CardHeader title="输入" description="运行时要给的参数" />
          {Object.keys(task.input).length === 0 ? <div className="px-4 py-4 text-[12.5px] text-fg-3">没有输入：运行时不用填参数</div> : (
            <ul className="divide-y divide-line">
              {Object.entries(task.input).map(([k, f]) => (
                <li key={k} className="px-4 py-2">
                  <div className="flex items-center gap-2"><code className="font-mono text-[12.5px] text-fg">{k}</code><span className="text-[11.5px] text-fg-3">{TYPE_LABEL[f.type] ?? f.type}</span>
                    {f.required && <Badge tone="warn">必填</Badge>}{k === objectInput && <Badge tone="accent">对象</Badge>}
                    {f.default != null && f.default !== "" && <span className="text-[11.5px] text-fg-3">默认 {String(f.default)}</span>}</div>
                  {f.description && <div className="mt-0.5 text-xs text-fg-3">{f.description}</div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        {task.output_schema && (
          <Card>
            <CardHeader title="结构化输出" icon={<LuBraces />} description="agent 最后按它交回结果，通过校验的放在 output.data" />
            <div className="p-3"><CodeBlock code={JSON.stringify(task.output_schema, null, 2)} maxHeight={300} /></div>
          </Card>
        )}
      </div>
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = { str: "文本", text: "长文本", int: "整数", bool: "开关", enum: "枚举", json: "JSON" };

function DeliverText({ task }: { task: TaskSummary }) {
  if (task.deliver?.channel) return <>推送到 <code className="font-mono text-[12px]">{task.deliver.channel}</code></>;
  if (task.deliver?.url) return <span className="break-all font-mono text-[12px]">POST {task.deliver.url}</span>;
  return <>不推送（在运行详情里看）</>;
}

function MemoryText({ task }: { task: TaskSummary }) {
  const word = (v: boolean | null | undefined) => (v === true ? "开" : v === false ? "关" : "跟随平台");
  return <>召回{word(task.memory?.recall)} · 沉淀{word(task.memory?.save)}</>;
}

function ProfileView({ profile }: { profile: Record<string, string> }) {
  if (!Object.keys(profile).length) return <div className="text-[12.5px] text-fg-3">还没有档案。写下代码和配置里读不出来的东西：口径、禁区、常见坑。</div>;
  return (
    <dl className="space-y-3">{Object.entries(profile).map(([k, v]) => (
      <div key={k}><dt className="text-[11.5px] font-medium text-fg-3">{PROFILE_LABEL[k] ?? k}</dt><dd className="mt-0.5"><Markdown text={v} /></dd></div>
    ))}</dl>
  );
}

function TriggerRow({ tr }: { tr: Trigger }) {
  const meta = TRIGGER[tr.type];
  return (
    <li className={cn("px-4 py-3", tr.enabled === false && "opacity-50")}>
      <div className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-sunken text-fg-2 [&_svg]:size-3.5">{meta.icon}</span>
        <span className="text-[13px] font-medium text-fg">{meta.label}</span>
        <code className="font-mono text-[11px] text-fg-3">{tr.id}</code>
        {tr.enabled === false && <Badge tone="idle">已关闭</Badge>}
        {(tr.type === "schedule" || tr.type === "event") && tr.service && <Badge tone="outline">服务 {tr.service}</Badge>}
      </div>
      {tr.type === "api" && <div className="mt-1.5 pl-8 text-[12.5px] text-fg-3">业务项目经 <code className="font-mono">POST /v1/runs</code> 或 SDK 调用</div>}
      {tr.type === "chat" && <div className="mt-1.5 pl-8 text-[12.5px] text-fg-3">出现在对话页，可多轮追问</div>}
      {tr.type === "schedule" && <ScheduleDetail tr={tr} />}
      {tr.type === "event" && (
        <div className="mt-2 space-y-2 pl-8">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <LuWebhook className="size-3.5 text-fg-3" /><code className="font-mono text-fg">{tr.source}.{tr.event}</code>
            {tr.filter && Object.entries(tr.filter).map(([k, v]) => <Badge key={k} tone="outline">{k} ~ /{v}/</Badge>)}
            {tr.session && <span className="text-xs text-fg-3">会话：<code className="font-mono">{tr.session}</code></span>}
          </div>
          {tr.map && <div className="text-xs text-fg-3">字段映射：{Object.entries(tr.map).map(([k, v]) => <code key={k} className="mr-2 font-mono">{k}←{v}</code>)}</div>}
          {!!tr.rules?.length && (
            <div className="overflow-hidden rounded-md border border-line">
              <div className="border-b border-line bg-sunken/60 px-3 py-1.5 text-[11.5px] text-fg-3">规则先行：命中直接给结论（也记一条运行，resolution=rule），未命中才交给 agent</div>
              <Table>
                <tbody>
                  {tr.rules.map((r, i) => (
                    <Tr key={i}>
                      <Td className="w-[38%] font-mono text-[11.5px] text-fg-2">/{r.pattern}/</Td>
                      <Td className="w-[80px]"><Badge>{r.category}</Badge></Td>
                      <Td className="text-[12.5px] text-fg-2">{r.conclusion}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function ScheduleDetail({ tr }: { tr: Extract<Trigger, { type: "schedule" }> }) {
  let next: Date[] = [];
  try { next = nextRuns(tr.cron, 3); } catch { /* 非法表达式 */ }
  return (
    <div className="mt-2 pl-8">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <LuCalendarClock className="size-3.5 text-fg-3" />
        <span className="text-fg">{describeCron(tr.cron)}</span>
        <code className="rounded bg-sunken px-1.5 font-mono text-[11.5px] text-fg-3">{tr.cron}</code>
        <span className="text-xs text-fg-3">每个环境各跑一份：</span>
        {tr.envs.map((e) => <EnvBadge key={e} env={e} />)}
      </div>
      {next.length > 0 && <div className="mt-1.5 text-xs text-fg-3">接下来：{next.map((d) => dayjs(d).format("MM-DD HH:mm")).join("　")}</div>}
      {Object.keys(tr.input ?? {}).length > 0 && <div className="mt-1 text-xs text-fg-3">固定输入：<code className="font-mono">{JSON.stringify(tr.input)}</code></div>}
    </div>
  );
}

// ———————— 档案：就地编辑 ————————

/**
 * 父任务：整份档案就是自己的。
 * 子任务：接口给的是合并后的档案；与父任务相同的键算继承，不同或新增的键才是自己写的。
 * 保存只写自己的那部分（profile 整体替换）。
 */
function ProfileTab({ task, parent }: { task: TaskSummary; parent: TaskSummary | undefined }) {
  const inherited = useMemo(() => parent?.profile ?? {}, [parent]);
  const own = useMemo(() => Object.fromEntries(Object.entries(task.profile).filter(([k, v]) => inherited[k] !== v)), [task.profile, inherited]);
  const [draft, setDraft] = useState(own);
  const ownKey = JSON.stringify(own);
  useEffect(() => setDraft(own), [ownKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== ownKey;

  const save = useMutation(async () => {
    try {
      // 子任务把自己的档案删光 = 去掉这项覆盖（null），重新只跟随父任务；存成 {} 会被当成「写过档案」，档案待补的标记也没了
      const profile = task.extends && !Object.keys(draft).length ? null : draft;
      const r = await api.update<TaskSummary>("tasks", task.name, { profile } as Partial<TaskSummary>);
      toast(`已保存为 v${r.version}`);
      invalidate("tasks");
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  });

  const inheritedOnly = Object.entries(inherited).filter(([k]) => !(k in draft));
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <Card className="h-fit">
        <CardHeader title={parent ? "这个对象的档案" : "任务档案"} icon={<LuScrollText />}
          description={parent ? "与父任务档案按键合并，同名键以这里为准" : "每次运行置顶逐字注入。只写代码和配置里读不出来的东西。"} />
        <div className="p-4">
          <KeyValueEditor value={draft} onChange={setDraft} suggestions={PROFILE_SUGGESTIONS} keyPlaceholder="键，如 pitfalls" valuePlaceholder="内容（支持 Markdown）" />
        </div>
      </Card>
      <div className="space-y-4">
        {parent && (
          <Card>
            <CardHeader title="继承自父任务" description={<Link to={taskHref(parent.name, "profile")} className="text-accent hover:underline">{parent.title || parent.name}</Link>} />
            {inheritedOnly.length === 0 ? <div className="px-4 py-4 text-[12.5px] text-fg-3">父任务的档案键都已被覆盖，或父任务没有档案</div> : (
              <ul className="divide-y divide-line">
                {inheritedOnly.map(([k, v]) => (
                  <li key={k} className="group px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[11.5px] font-medium text-fg-3">{PROFILE_LABEL[k] ?? k}</span>
                      <Button size="xs" variant="ghost" className="ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => setDraft({ ...draft, [k]: v })}>覆盖</Button>
                    </div>
                    <div className="mt-0.5 line-clamp-3 text-[12.5px] text-fg-2">{v}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        <Card>
          <CardHeader title="注入顺序" />
          <ol className="space-y-1.5 px-4 pb-4 text-[12.5px] text-fg-2">
            <li>1. 服务档案{task.service && task.service !== "*" ? <>（<Link to={`/services/${task.service}`} className="text-accent hover:underline">{task.service}</Link>）</> : "（调用时指定的服务）"}</li>
            {parent && <li>2. 父任务档案</li>}
            <li>{parent ? 3 : 2}. {parent ? "这个对象的档案" : "任务档案"}</li>
            <li className="pt-1 text-xs text-fg-3">之后才是召回的记忆与本次输入。档案越准，agent 越少走弯路。</li>
          </ol>
        </Card>
      </div>
      <SaveBar visible={dirty} saving={save.pending} onSave={() => save.mutate(undefined)} onDiscard={() => setDraft(own)} />
    </div>
  );
}

// ———————— 子任务：一行新建 ————————

function SubtasksTab({ task }: { task: TaskSummary }) {
  const { data: subs, loading } = useSubtasks(task.name);
  const [object, setObject] = useState("");
  const [q, setQ] = useState("");
  const [runFor, setRunFor] = useState<string | null>(null);
  const exists = subs?.some((s) => s.name === `${task.name}:${object}`);
  const error = object ? objectNameError(object) ?? (exists ? "这个对象已经有子任务了" : null) : null;

  const create = useMutation(async () => {
    try {
      const sub = await api.createSubtask(task.name, { object });
      setObject("");
      invalidate("tasks");
      navigate(taskHref(sub.name, "profile"));
    } catch (e) { toast.error("创建失败", (e as Error).message); }
  });

  const list = (subs ?? []).filter((s) => !q || s.name.includes(q) || s.title.includes(q));
  return (
    <Card>
      <CardHeader title="子任务" icon={<LuGitBranch />}
        description={task.object_input
          ? <>每个 <code className="font-mono">{task.object_input}</code> 一个子任务，各有自己的档案和记忆，其余跟随这个任务。运行时没见过的对象会自动建出来。</>
          : <>针对具体对象（一张表、一个报表）的变体：各有自己的档案和记忆，其余跟随这个任务。运行时点名没见过的对象会自动建出来。</>} />
      <form className="flex flex-wrap items-start gap-2 border-b border-line px-4 py-3"
        onSubmit={(e) => { e.preventDefault(); if (object && !error) create.mutate(undefined); }}>
        <div className="flex min-w-0 flex-1 items-center rounded-md border border-line bg-panel focus-within:border-accent">
          <span className="select-none pl-2.5 font-mono text-[12.5px] text-fg-3">{task.name}:</span>
          <input value={object} onChange={(e) => setObject(e.target.value.trim())} placeholder="对象名，回车创建并去写档案"
            className="h-8 min-w-0 flex-1 bg-transparent px-1 font-mono text-[12.5px] text-fg outline-none placeholder:text-fg-3" />
        </div>
        <Button type="submit" variant="primary" icon={<LuPlus />} disabled={!object || !!error} loading={create.pending}>新建</Button>
        {(subs?.length ?? 0) > 8 && <SearchInput value={q} onChange={setQ} placeholder="筛选对象…" className="w-48" />}
        {error && <div className="w-full text-xs text-bad">{error}</div>}
      </form>
      {loading ? <Skeleton className="m-4 h-24" /> : !list.length ? (
        <Empty icon={<LuGitBranch />} title={q ? "没有匹配的对象" : "还没有子任务"} description="某个对象的业务信息多且重要时，为它建子任务、写档案" />
      ) : (
        <Table>
          <thead><tr><Th>对象</Th><Th>档案</Th><Th>近 24 小时</Th><Th>最近</Th><Th>更新</Th><Th /></tr></thead>
          <tbody>
            {list.map((s) => {
              const obj = s.name.split(":")[1];
              return (
                <Tr key={s.name} onClick={() => navigate(taskHref(s.name))}>
                  <Td>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[12.5px] font-medium text-fg">{obj}</span>
                      {!s.enabled && <Badge tone="idle">已停用</Badge>}
                    </div>
                    {s.overrides.includes("title") && s.title && <div className="text-[11.5px] text-fg-3">{s.title}</div>}
                  </Td>
                  <Td>{s.overrides.includes("profile") ? <span className="text-[12.5px] text-fg-2">已写</span> : (
                    <Link to={taskHref(s.name, "profile")} className="text-[12.5px] text-warn hover:underline" onClick={(e) => e.stopPropagation()}>{s.auto_created ? "自动建的，" : ""}待补 →</Link>
                  )}</Td>
                  <Td className="tabular-nums text-fg-2">{s.stats_24h.runs || "—"}</Td>
                  <Td>{s.last_run ? <span className="flex items-center gap-1.5 text-[12.5px] text-fg-3"><RunStatusDot status={s.last_run.status} />{ago(s.last_run.created_at)}</span> : "—"}</Td>
                  <Td className="text-[12.5px] text-fg-3">v{s.version} · {ago(s.updated_at)}</Td>
                  <Td className="w-10 text-right" onClick={(e) => e.stopPropagation()}>
                    <Button size="icon-sm" variant="ghost" aria-label={`运行 ${obj}`} disabled={!s.enabled} onClick={() => setRunFor(obj)}><LuPlay /></Button>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <RunTaskDialog open={!!runFor} onClose={() => setRunFor(null)} task={task.name} subtask={runFor ?? undefined} />
    </Card>
  );
}

// ———————— 记忆：这个任务名下的记忆（事实 / 教训）与方法 ————————

function MemoryTab({ task }: { task: TaskSummary }) {
  const ui = useUi();
  const fixedService = task.service && task.service !== "*" ? task.service : undefined;
  const [service, setService] = useState("");
  const [env, setEnv] = useState(ui.env);
  const filters = { task: task.name, service: fixedService ?? (service || undefined), env: env || undefined };
  const scope = { task: task.name, service: fixedService };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {!fixedService && <ServiceFilter value={service} onChange={setService} />}
        <EnvFilter value={env} onChange={setEnv} includeShared />
        <span className="text-xs text-fg-3">
          {task.extends ? "只看这个对象名下的条目" : "包括子任务名下的条目"}；选某个环境时连同对所有环境成立的条目一起列出，召回时还会带上服务通用的条目。
          人写的约定在「档案」标签里；记忆被反复用到、确认无误后可以升格进档案。
        </span>
      </div>
      <KnowledgeList filters={filters} scope={scope} />
      <AssetList filters={filters} scope={scope} />
    </div>
  );
}

// ———————— 子任务的覆盖项 ————————

/** 子任务能单独设置的几项：没设置的跟随父任务（父任务以后改了也跟着变） */
const OVERRIDABLE = ["title", "description", "envs", "timeout_s"] as const;
type Overridable = (typeof OVERRIDABLE)[number];
type OverrideDraft = { [K in Overridable]?: TaskSummary[K] };

function OverridesTab({ task, parent }: { task: TaskSummary; parent: TaskSummary | undefined }) {
  const { data: envs } = useEnvs();
  /** 只有自己设置了的字段在草稿里；不在 = 跟随父任务 */
  const pick = (): OverrideDraft => Object.fromEntries(OVERRIDABLE.filter((k) => task.overrides.includes(k)).map((k) => [k, structuredClone(task[k])]));
  const [d, setD] = useState<OverrideDraft>(pick);
  useEffect(() => setD(pick()), [task.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(d) !== JSON.stringify(pick());

  const save = useMutation(async () => {
    const before = pick();
    // 改了的写新值；取消了的写 null（后端去掉这项覆盖，重新跟随父任务）；没动的不发
    const patch: Record<string, unknown> = {};
    for (const k of OVERRIDABLE) {
      if (!(k in d) && k in before) patch[k] = null;
      else if (k in d && JSON.stringify(d[k]) !== JSON.stringify(before[k])) patch[k] = d[k];
    }
    try {
      const r = await api.update<TaskSummary>("tasks", task.name, patch);
      toast(`已保存为 v${r.version}`);
      invalidate("tasks");
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  });

  const row = (k: Overridable, label: string, control: ReactNode, inherited: ReactNode) => {
    const own = k in d;
    return (
      <div className="py-3.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[12.5px] font-medium text-fg">{label}</span>
          {own ? <Badge tone="accent">单独设置</Badge> : <span className="text-[11.5px] text-fg-3">跟随父任务</span>}
          <Button size="xs" variant="ghost" className="ml-auto" disabled={!parent}
            onClick={() => setD((s) => {
              if (own) { const n = { ...s }; delete n[k]; return n; }
              return { ...s, [k]: structuredClone(parent![k]) };
            })}>{own ? "恢复跟随" : "单独设置"}</Button>
        </div>
        {own ? control : <div className="rounded-md border border-dashed border-line px-2.5 py-1.5 text-[12.5px] text-fg-3">{inherited}</div>}
      </div>
    );
  };
  const envList = d.envs ?? [];
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader title="单独设置" icon={<LuSettings />} description="这个对象和父任务不一样的地方。没设置的都跟随父任务，父任务改了也跟着变" />
        <div className="divide-y divide-line px-4">
          {row("title", "显示名",
            <Input value={d.title ?? ""} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="如：账户收益日表" />,
            parent?.title || "（父任务没有显示名）")}
          {row("description", "说明",
            <Textarea rows={3} value={d.description ?? ""} onChange={(e) => setD({ ...d, description: e.target.value })} placeholder="替换父任务的说明：agent 看到的是这一份" />,
            parent?.description || "（父任务没有说明）")}
          {row("envs", "环境",
            <div className="flex flex-wrap gap-4">
              {(envs ?? []).map((e) => (
                <Checkbox key={e.name} checked={envList.includes(e.name)} label={<EnvBadge env={e.name} />}
                  onChange={(v) => setD({ ...d, envs: v ? [...envList, e.name] : envList.filter((x) => x !== e.name) })} />
              ))}
              {!envList.length && <span className="text-[12px] text-fg-3">都不勾 = 所有环境</span>}
            </div>,
            parent?.envs.length ? <span className="flex gap-1">{parent.envs.map((e) => <EnvBadge key={e} env={e} />)}</span> : "所有环境")}
          {row("timeout_s", "超时",
            <div className="flex items-center gap-2"><Input className="w-24" inputMode="numeric" value={Math.round((d.timeout_s ?? 0) / 60) || ""}
              onChange={(e) => setD({ ...d, timeout_s: Math.min(120, Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1)) * 60 })} /><span className="text-[12.5px] text-fg-3">分钟</span></div>,
            parent ? seconds(parent.timeout_s) : "—")}
        </div>
      </Card>
      <Card className="h-fit">
        <CardHeader title="其余跟随父任务" description={parent ? <>在 <Link to={taskHref(parent.name, "definition")} className="text-accent hover:underline">{parent.title || parent.name}</Link> 的「定义」里改</> : "—"} />
        <div className="p-4">
          {parent && <DescList items={[
            ["角色", parent.role ?? "—"],
            ["触发", parent.triggers.map((t) => TRIGGER[t.type].label).join("、") || "—"],
            ["结果", <DeliverText task={parent} />],
            ["输入", Object.keys(parent.input).join("、") || "—"],
          ]} />}
          <p className="mt-3 text-[12px] leading-relaxed text-fg-3">这个对象自己的事实写在「档案」标签：和父任务的档案按键合并，同名的以这里为准。</p>
        </div>
      </Card>
      <SaveBar visible={dirty} saving={save.pending} onSave={() => save.mutate(undefined)} onDiscard={() => setD(pick())} />
    </div>
  );
}
