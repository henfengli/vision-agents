/**
 * 任务详情。父任务与子任务共用一页，标签按身份取舍：
 *   概览 · 档案 · 子任务（仅父任务）· 记忆 · 定义 / 覆盖 · 运行 · 版本
 * 接口返回的子任务已经是"父任务 + 自己的差异"合并后的样子，overrides 指出哪些字段是它自己写的。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LuActivity, LuArrowLeft, LuArrowRight, LuBraces, LuBrain, LuCalendarClock, LuCopy, LuEllipsis, LuGitBranch, LuHistory, LuLayoutDashboard, LuListTodo, LuPencil,
  LuPlay, LuPlus, LuPower, LuRadar, LuScrollText, LuSettings, LuTrash2, LuWebhook, LuWorkflow, LuZap,
} from "react-icons/lu";

import { api, useEnvs, useRuns, useServices, useSubtasks, useTask, useTasks } from "@/api/hooks";
import type { AfterTrigger, TaskSummary, Trigger } from "@/api/types";
import { EnvFilter, ServiceFilter } from "@/components/filters";
import { Page, PageHeader } from "@/components/layout/shell";
import { IdCopy, MetaVersion } from "@/components/meta";
import { SaveBar } from "@/components/save-bar";
import { DetailError, EmptyFiltered } from "@/components/states";
import { DisabledBadge, EnvBadge, RoleChip, RunStatusDot, TRIGGER } from "@/components/status";
import { VersionHistory } from "@/components/versions";
import { Button } from "@/components/ui/button";
import { CodeBlock, KeyValueEditor, Markdown, Tabs, Table, Td, Th, Tr } from "@/components/ui/data";
import { Checkbox, Field, Input, SearchInput, Select, Textarea, objectNameError } from "@/components/ui/form";
import { Dialog, Menu, Tooltip, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, DescList, Empty, Skeleton, Stat } from "@/components/ui/primitives";
import { describeCron, nextRuns } from "@/lib/cron";
import { cn } from "@/lib/cn";
import { ago, dayjs, duration, pct, seconds } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { Link, navigate, useParams, useSearch } from "@/lib/router";
import { useUi } from "@/lib/store";
import { AssetList, KnowledgeList } from "../memory/memory";
import { RunsTable, type RunColumn } from "../runs/runs-table";
import { TaskTicksCard } from "../runs/ticks";
import { PROFILE_LABEL } from "../services/service-detail";
import { InputControl, initialValues, inputErrors, inputValue } from "./input-control";
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

  if (error && !task) return (
    <Page>
      <PageHeader crumbs={[{ label: "任务", to: "/tasks" }, ...(parentName ? [{ label: parentName, to: taskHref(parentName) }] : []), { label: object ?? name }]} title={object ?? name} />
      <DetailError error={error} onRetry={refetch} what={isSub ? "子任务" : "任务"} back={parentName ? { to: taskHref(parentName, "subtasks"), label: "回到父任务" } : { to: "/tasks", label: "回到任务列表" }} />
    </Page>
  );

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
          {task && !task.enabled && <DisabledBadge />}
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
          <IdCopy value={task.name} />
          <span>{task.service === "*" ? "通用任务" : task.service ? <>服务 <Link to={`/services/${task.service}`} className="text-fg-2 hover:text-accent">{task.service}</Link></> : "平台任务"}</span>
          <span>{FORM_META[task.form].label}</span>
          <RoleChip role={task.role} />
          <MetaVersion version={task.version} by={task.updated_by} at={task.updated_at} />
        </>}
        actions={<>
          <Button variant="primary" icon={<LuPlay />} onClick={() => setRunOpen(true)}
            reason={!task ? undefined : !task.enabled ? "任务已停用" : isSub && parent?.enabled === false ? "父任务已停用" : undefined}>运行</Button>
          <Menu trigger={<Button size="icon" aria-label="更多"><LuEllipsis /></Button>} items={[
            ...(!isSub ? [
              { label: "复制为新任务", icon: <LuCopy />, onClick: () => navigate(`/tasks/_new?from=${encodeURIComponent(name)}`) },
              { label: "新建下游任务", icon: <LuWorkflow />, onClick: () => navigate(`/tasks/_new?after=${encodeURIComponent(name)}`) },
            ] : []),
            { label: "查看全部运行", icon: <LuActivity />, onClick: () => navigate(`/runs?task=${encodeURIComponent(name)}`) },
            { label: "查看触发记录", icon: <LuRadar />, onClick: () => navigate(`/runs?view=ticks&task=${encodeURIComponent(name)}`) },
            { separator: true, label: "" },
            { label: task?.enabled ? (isSub ? "停用子任务" : "停用任务") : (isSub ? "启用子任务" : "启用任务"), icon: <LuPower />, danger: !!task?.enabled, onClick: toggle },
            { label: isSub ? "删除子任务" : "删除任务", icon: <LuTrash2 />, danger: true, onClick: remove },
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
  const runsQ = useRuns({ task: task.name, env: env || undefined, limit: 10 });
  const runs = runsQ.data;
  const { data: all } = useTasks();
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
          <RunsTable runs={runs?.items} columns={runColumns(task, false)} compact error={runsQ.error} onRetry={() => void runsQ.refetch()}
            empty={<Empty title="还没有运行" description={env ? `${env} 环境下还没跑过` : "点右上角「运行」手动跑一次"} className="py-6" />} />
        </Card>
        <TaskTicksCard task={task.name} />
      </div>
      <div className="min-w-0 space-y-4">
        <LinkageCard task={task} all={all} />
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
              ...(task.form === "agent" ? [["自动重试", task.retry ? `临时性失败最多重试 ${task.retry.max} 次，每次等 ${seconds(task.retry.delay_s)}` : "不重试"] as [ReactNode, ReactNode]] : []),
              ["同时执行", task.concurrency ? `每个环境最多 ${task.concurrency} 个` : "不单独限制"],
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
        {tr.enabled === false && <DisabledBadge />}
        {(tr.type === "schedule" || tr.type === "event" || tr.type === "after") && tr.service && <Badge tone="outline">服务 {tr.service}</Badge>}
      </div>
      {tr.type === "after" && <AfterDetail tr={tr} />}
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

/** 「成功后」「失败后」「结束后（成功或失败）」 */
export const afterWhen = (on: AfterTrigger["on"]) => (on.includes("success") && on.includes("failed") ? "结束后" : on.includes("failed") ? "失败后" : "成功后");

function AfterDetail({ tr }: { tr: AfterTrigger }) {
  const { data: tasks } = useTasks();
  const title = (n: string) => tasks?.find((t) => t.name === n)?.title || n;
  const all = tr.mode === "all" && tr.tasks.length > 1;
  return (
    <div className="mt-2 space-y-1.5 pl-8 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-fg-3">{all ? "这几个上游都" : tr.tasks.length > 1 ? "任一上游" : "上游"}</span>
        {tr.tasks.map((n) => <Link key={n} to={taskHref(n)} className="rounded border border-line bg-sunken/60 px-1.5 py-0.5 text-fg hover:border-accent hover:text-accent">{title(n)}</Link>)}
        <span className="text-fg">{afterWhen(tr.on)}</span>
        <span className="text-fg-3">在同一个环境跑一次{all ? `（${seconds(tr.window_s ?? 86400)}内都结束过才算）` : ""}</span>
      </div>
      {tr.filter && Object.keys(tr.filter).length > 0 && (
        <div className="flex flex-wrap gap-1">{Object.entries(tr.filter).map(([k, v]) => <Badge key={k} tone="outline">{k} ~ /{v}/</Badge>)}</div>
      )}
      <div className="text-xs text-fg-3">{tr.map && Object.keys(tr.map).length
        ? <>输入：{Object.entries(tr.map).map(([k, v]) => <code key={k} className="mr-2 font-mono">{k}←{v}</code>)}</>
        : "输入：上游输入里同名的字段带过来"}</div>
    </div>
  );
}

/**
 * 联动：上游（这个任务声明的「在谁结束后跑」）和下游（别的任务声明了在它结束后跑）。
 * 父任务的下游包括写了它某个子任务全名的；子任务的下游包括写了父任务的（父任务 = 它和它的子任务）。
 */
function LinkageCard({ task, all }: { task: TaskSummary; all: TaskSummary[] | undefined }) {
  const base = task.name.split(":")[0];
  const sub = !!task.extends;
  const isAfter = (tr: Trigger): tr is AfterTrigger => tr.type === "after";
  const ups = (sub && !task.overrides.includes("triggers") ? [] : task.triggers.filter(isAfter)).flatMap((tr) => tr.tasks.map((u) => ({ name: u, tr })));
  const downs = (all ?? []).filter((t) => t.name.split(":")[0] !== base && (!t.extends || t.overrides.includes("triggers")))
    .flatMap((t) => t.triggers.filter(isAfter)
      .filter((tr) => tr.tasks.some((u) => u === task.name || (!sub && u.split(":")[0] === task.name) || (sub && u === task.extends)))
      .map((tr) => ({ name: t.name, tr })));
  const title = (n: string) => all?.find((t) => t.name === n)?.title || n;
  const row = (dir: "up" | "down", name: string, tr: AfterTrigger, key: string) => {
    const others = tr.tasks.filter((u) => u !== task.name && u !== task.extends);
    return (
      <li key={key} className={cn("flex items-start gap-2 px-4 py-2.5", tr.enabled === false && "opacity-60")}>
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded bg-sunken text-fg-3 [&_svg]:size-3">{dir === "up" ? <LuArrowLeft /> : <LuArrowRight />}</span>
        <div className="min-w-0 flex-1">
          <Link to={taskHref(name)} className="block truncate text-[13px] text-fg hover:text-accent">{title(name)}</Link>
          <div className="truncate text-[11.5px] text-fg-3">
            {dir === "up" ? `它${afterWhen(tr.on)}跑这个` : `这个${afterWhen(tr.on)}跑它`}
            {tr.mode === "all" && tr.tasks.length > 1 && (dir === "up" ? " · 要等全部上游" : ` · 还要等 ${others.map(title).join("、")}`)}
          </div>
        </div>
        {tr.enabled === false && <DisabledBadge />}
      </li>
    );
  };
  return (
    <Card>
      <CardHeader title="联动" icon={<LuWorkflow />} description="上游结束后自动跑下游，像 Dagster 的依赖"
        actions={<Link to={`/tasks?view=graph&focus=${encodeURIComponent(base)}`} className="flex items-center gap-1 text-xs text-fg-3 hover:text-accent">任务图 <LuArrowRight className="size-3" /></Link>} />
      {!ups.length && !downs.length ? (
        <div className="space-y-2 px-4 py-3.5 text-[12.5px] text-fg-3">
          <p>没有上下游。在「定义 → 触发」里加「上游任务结束后」，这个任务就会接在别的任务后面跑。</p>
          {!sub && <Button size="xs" icon={<LuPlus />} onClick={() => navigate(`/tasks/_new?after=${encodeURIComponent(task.name)}`)}>新建下游任务</Button>}
        </div>
      ) : (
        <>
          {ups.length > 0 && <><div className="px-4 pt-2.5 text-[11.5px] font-medium text-fg-3">上游（它们结束后跑这个）</div><ul className="divide-y divide-line">{ups.map((u, i) => row("up", u.name, u.tr, `u${i}`))}</ul></>}
          {downs.length > 0 && <><div className="border-t border-line px-4 pt-2.5 text-[11.5px] font-medium text-fg-3">下游（这个结束后跑它们）</div><ul className="divide-y divide-line">{downs.map((d, i) => row("down", d.name, d.tr, `d${i}`))}</ul></>}
          {!sub && (
            <div className="border-t border-line px-4 py-2">
              <Button size="xs" variant="ghost" icon={<LuPlus />} onClick={() => navigate(`/tasks/_new?after=${encodeURIComponent(task.name)}`)}>新建下游任务</Button>
            </div>
          )}
        </>
      )}
    </Card>
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
  const [picked, setPicked] = useState<string[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const runnable = list.filter((s) => s.enabled);
  const allPicked = runnable.length > 0 && runnable.every((s) => picked.includes(s.name));

  const toggleSub = async (s: TaskSummary) => {
    const obj = s.name.split(":")[1];
    if (s.enabled && !(await confirm({ title: `停用子任务 ${obj}？`, description: "停用后点名它的运行、落到它名下的事件都拒收（task_disabled）；父任务和别的对象不受影响。", danger: true, confirmText: "停用" }))) return;
    try {
      await api.update("tasks", s.name, { enabled: !s.enabled });
      toast(s.enabled ? `已停用 ${obj}` : `已启用 ${obj}`);
      invalidate("tasks");
    } catch (e) { toast.error(s.enabled ? "停用失败" : "启用失败", (e as Error).message); }
  };
  const removeSub = async (s: TaskSummary) => {
    const obj = s.name.split(":")[1];
    if (!(await confirm({ title: `删除子任务 ${obj}？`, danger: true, confirmText: "删除", description: "删掉它的档案和覆盖项；历史运行、记忆保留。以后再点名这个对象会重新自动建一个（没有档案）。" }))) return;
    try {
      await api.remove("tasks", s.name);
      toast(`已删除 ${obj}`);
      setPicked((p) => p.filter((x) => x !== s.name));
      invalidate("tasks");
    } catch (e) { toast.error("删除失败", (e as Error).message); }
  };

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
      {picked.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft/40 px-4 py-2 text-[12.5px]">
          <span className="text-fg-2">已选 {picked.length} 个对象</span>
          <Button size="sm" variant="primary" icon={<LuPlay />} onClick={() => setBatchOpen(true)}>逐个运行</Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked([])}>取消选择</Button>
        </div>
      )}
      {loading ? <Skeleton className="m-4 h-24" /> : !list.length ? (
        q ? <EmptyFiltered what="对象" icon={<LuGitBranch />} onClear={() => setQ("")} />
          : <Empty icon={<LuGitBranch />} title="还没有子任务" description="某个对象的业务信息多且重要时，为它建子任务、写档案" />
      ) : (
        <Table>
          <thead><tr>
            <Th className="w-9"><Checkbox checked={allPicked} label={<span className="sr-only">全选</span>}
              onChange={(v) => setPicked(v ? runnable.map((s) => s.name) : [])} disabled={!runnable.length} /></Th>
            <Th>对象</Th><Th>档案</Th><Th>近 24 小时</Th><Th>最近</Th><Th>更新</Th><Th />
          </tr></thead>
          <tbody>
            {list.map((s) => {
              const obj = s.name.split(":")[1];
              return (
                <Tr key={s.name} onClick={() => navigate(taskHref(s.name))}>
                  <Td onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={picked.includes(s.name)} disabled={!s.enabled} label={<span className="sr-only">选择 {obj}</span>}
                      onChange={(v) => setPicked((p) => (v ? [...p, s.name] : p.filter((x) => x !== s.name)))} />
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[12.5px] font-medium text-fg">{obj}</span>
                      {!s.enabled && <DisabledBadge />}
                    </div>
                    {s.overrides.includes("title") && s.title && <div className="text-[11.5px] text-fg-3">{s.title}</div>}
                  </Td>
                  <Td>{s.overrides.includes("profile") ? <span className="text-[12.5px] text-fg-2">已写</span> : (
                    <Link to={taskHref(s.name, "profile")} className="text-[12.5px] text-warn hover:underline" onClick={(e) => e.stopPropagation()}>{s.auto_created ? "自动建的，" : ""}待补 →</Link>
                  )}</Td>
                  <Td className="tabular-nums text-fg-2">{s.stats_24h.runs || "—"}</Td>
                  <Td>{s.last_run ? <span className="flex items-center gap-1.5 text-[12.5px] text-fg-3"><RunStatusDot status={s.last_run.status} />{ago(s.last_run.created_at)}</span> : "—"}</Td>
                  <Td className="text-[12.5px] text-fg-3">v{s.version} · {ago(s.updated_at)}</Td>
                  <Td className="w-[76px] whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                    <Button size="icon-sm" variant="ghost" aria-label={`运行 ${obj}`} reason={!s.enabled ? "子任务已停用" : undefined} onClick={() => setRunFor(obj)}><LuPlay /></Button>
                    <Menu trigger={<Button size="icon-sm" variant="ghost" aria-label={`${obj} 的更多操作`}><LuEllipsis /></Button>} items={[
                      { label: "打开", icon: <LuArrowRight />, onClick: () => navigate(taskHref(s.name)) },
                      { label: "写档案", icon: <LuScrollText />, onClick: () => navigate(taskHref(s.name, "profile")) },
                      { separator: true, label: "" },
                      { label: s.enabled ? "停用子任务" : "启用子任务", icon: <LuPower />, danger: s.enabled, onClick: () => void toggleSub(s) },
                      { label: "删除子任务", icon: <LuTrash2 />, danger: true, onClick: () => void removeSub(s) },
                    ]} />
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <RunTaskDialog open={!!runFor} onClose={() => setRunFor(null)} task={task.name} subtask={runFor ?? undefined} />
      <BatchRunDialog open={batchOpen} onClose={() => setBatchOpen(false)} task={task} objects={picked.map((n) => n.split(":")[1])}
        onDone={() => { setPicked([]); setBatchOpen(false); }} />
    </Card>
  );
}

/**
 * 选中的几个对象逐个跑一次（像 Dagster 按资产补跑）：同一个环境、同一份输入（对象字段按对象填），
 * 各自一条运行。任务配了同时执行上限的，多出来的排队。
 */
function BatchRunDialog({ open, onClose, task, objects, onDone }: {
  open: boolean; onClose: () => void; task: TaskSummary; objects: string[]; onDone: () => void;
}) {
  const { data: envs } = useEnvs();
  const { data: services } = useServices();
  const { env: globalEnv } = useUi();
  const allowed = (envs ?? []).filter((e) => !task.envs.length || task.envs.includes(e.name));
  const [env, setEnv] = useState("");
  const [service, setService] = useState("");
  const fields = Object.fromEntries(Object.entries(task.input).filter(([k]) => k !== task.object_input));
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    setEnv((allowed.find((e) => e.name === globalEnv) ?? allowed.find((e) => !e.protected) ?? allowed[0])?.name ?? "");
    setValues(initialValues(fields));
    setErrors({});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const generic = task.service === "*";

  const run = useMutation(async () => {
    const errs = inputErrors(fields, values);
    if (generic && !service) errs.__service = "选择服务";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const input: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) { const val = inputValue(fields[k], v); if (val !== undefined) input[k] = val; }
    const failed: string[] = [];
    let ok = 0;
    for (const obj of objects) {
      try {
        await api.submitRun({ task: task.name, subtask: obj, env, service: generic ? service : null, input });
        ok++;
      } catch (e) { failed.push(`${obj}：${(e as Error).message}`); }
    }
    invalidate("runs");
    invalidate("tasks");
    if (failed.length) toast.error(`${ok} 个已开始，${failed.length} 个没能开始`, failed.slice(0, 3).join("；"));
    else toast(`已开始 ${ok} 个运行`, { description: task.concurrency ? `同时最多跑 ${task.concurrency} 个，其余排队` : undefined });
    onDone();
    if (ok) navigate(`/runs?task=${encodeURIComponent(task.name)}&env=${env}`);
  });

  return (
    <Dialog open={open} onClose={onClose} title={`逐个运行 ${objects.length} 个对象`} size="lg"
      description={<>每个对象各一条运行，带上它自己的档案和记忆：<span className="font-mono">{objects.slice(0, 6).join("、")}{objects.length > 6 ? ` 等 ${objects.length} 个` : ""}</span></>}
      footer={<>
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon={<LuPlay />} disabled={!env} loading={run.pending} onClick={() => void run.mutate(undefined)}>运行 {objects.length} 个</Button>
      </>}>
      <div className="space-y-4">
        {generic && (
          <Field label="服务" required error={errors.__service}>
            <Select value={service || null} onChange={setService} placeholder="在哪个服务上跑"
              options={(services ?? []).filter((s) => s.enabled).map((s) => ({ value: s.name, label: s.title, hint: s.name }))} />
          </Field>
        )}
        <Field label="环境" required>
          <div className="flex flex-wrap gap-1.5">
            {allowed.map((e) => (
              <button key={e.name} type="button" onClick={() => setEnv(e.name)} aria-pressed={env === e.name}
                className={cn("inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 transition-colors", env === e.name ? "border-accent bg-accent-soft" : "border-line bg-panel hover:bg-hover")}>
                <EnvBadge env={e.name} /><span className="text-[12.5px] text-fg-2">{e.title}</span>
              </button>
            ))}
          </div>
        </Field>
        {Object.keys(fields).length > 0 && (
          <div className="space-y-3 rounded-lg border border-line bg-sunken/40 p-3.5">
            <div className="text-[12px] text-fg-3">每个对象都用这份输入{task.object_input ? <>（<code className="font-mono">{task.object_input}</code> 按对象自动填）</> : ""}</div>
            {Object.entries(fields).map(([k, f]) => (
              <InputControl key={k} name={k} field={f} value={values[k]} error={errors[k]} onChange={(v) => setValues((s) => ({ ...s, [k]: v }))} />
            ))}
          </div>
        )}
      </div>
    </Dialog>
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
      <KnowledgeList filters={filters} scope={scope} filtered={!!(service || env)} onClear={() => { setService(""); setEnv(""); }} />
      <AssetList filters={filters} scope={scope} filtered={!!(service || env)} onClear={() => { setService(""); setEnv(""); }} />
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
