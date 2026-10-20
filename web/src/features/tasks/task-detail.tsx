/**
 * 任务详情。父任务与子任务共用一页，标签按身份取舍：
 *   概览 · 档案 · 子任务（仅父任务）· 记忆 · 定义 / 覆盖 · 运行 · 版本
 * 接口返回的子任务已经是"父任务 + 自己的差异"合并后的样子，overrides 指出哪些字段是它自己写的。
 */
import { useEffect, useMemo, useState } from "react";
import {
  LuActivity, LuArrowRight, LuBrain, LuCalendarClock, LuEllipsis, LuGitBranch, LuHistory, LuLayoutDashboard, LuListTodo, LuPencil,
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
import { KeyValueEditor, Markdown, Tabs, Table, Td, Th, Tr } from "@/components/ui/data";
import { Checkbox, Field, Input, SearchInput, Textarea, objectNameError } from "@/components/ui/form";
import { Menu, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, DescList, Empty, ErrorState, Skeleton, Stat } from "@/components/ui/primitives";
import { describeCron, nextRuns } from "@/lib/cron";
import { cn } from "@/lib/cn";
import { ago, dayjs, duration, pct } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { Link, navigate, useParams, useSearch } from "@/lib/router";
import { useUi } from "@/lib/store";
import { AssetList, KnowledgeList } from "../memory/memory";
import { RunsTable } from "../runs/runs-table";
import { PROFILE_LABEL } from "../services/service-detail";
import { RunTaskDialog } from "./run-dialog";
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
    await api.update("tasks", task.name, { enabled: !task.enabled });
    toast(task.enabled ? "已停用" : "已启用");
    invalidate("tasks");
  };

  const remove = async () => {
    if (!task) return;
    const ok = await confirm({
      title: `删除 ${task.name}？`, danger: true, confirmText: "删除", requireText: task.name,
      description: <>删除后不能再提交，历史运行保留。{task.subtask_count > 0 && <>它的 <b>{task.subtask_count}</b> 个子任务会一起删除。</>}版本台账里可以恢复。</>,
    });
    if (!ok) return;
    try {
      const r = await api.remove("tasks", task.name);
      toast(`已删除 ${r.deleted.length} 个任务`);
      invalidate("tasks");
      navigate(parentName ? taskHref(parentName, "subtasks") : "/tasks");
    } catch (e) { toast.error("删除失败", (e as Error).message); }
  };

  const tabs = [
    { value: "overview" as TabKey, label: "概览", icon: <LuLayoutDashboard /> },
    { value: "profile" as TabKey, label: "档案", icon: <LuScrollText />, count: task ? Object.keys(task.profile).length : undefined },
    ...(!isSub ? [{ value: "subtasks" as TabKey, label: "子任务", icon: <LuGitBranch />, count: task?.subtask_count }] : []),
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
          {task && !task.enabled && <Badge tone="idle">已停用</Badge>}
          {task?.auto_created && <Badge tone="warn">自动创建</Badge>}
        </span>}
        description={isSub
          ? <>子任务：继承 <Link to={taskHref(parentName!)} className="text-accent hover:underline">{parent?.title || parentName}</Link> 的全部定义，只写差异——通常是这个对象的档案</>
          : task?.description}
        meta={task && <>
          <span className="font-mono">{task.name}</span>
          <span>{task.service === "*" ? "通用任务" : task.service ? <>服务 <Link to={`/services/${task.service}`} className="text-fg-2 hover:text-accent">{task.service}</Link></> : "平台任务"}</span>
          <span>{FORM_META[task.form].label}</span>
          <RoleChip role={task.role} />
          <span>v{task.version} · {task.updated_by} · {ago(task.updated_at)}</span>
        </>}
        actions={<>
          <Button variant="primary" icon={<LuPlay />} onClick={() => setRunOpen(true)} disabled={!task?.enabled}>运行</Button>
          <Menu trigger={<Button size="icon" aria-label="更多"><LuEllipsis /></Button>} items={[
            { label: task?.enabled ? "停用任务" : "启用任务", icon: <LuPower />, onClick: toggle },
            { label: "查看全部运行", icon: <LuActivity />, onClick: () => navigate(`/runs?task=${encodeURIComponent(name)}`) },
            { separator: true, label: "" },
            { label: "删除任务", icon: <LuTrash2 />, danger: true, onClick: remove },
          ]} />
        </>}
      />
      <Tabs className="mb-5" value={tab} onChange={(v) => setSearch({ tab: v === "overview" ? undefined : v })} tabs={tabs} />
      {!task ? <Skeleton className="h-96" /> : (
        <>
          {tab === "overview" && <OverviewTab task={task} onEditProfile={() => setSearch({ tab: "profile" })} />}
          {tab === "profile" && <ProfileTab task={task} parent={parent} />}
          {tab === "subtasks" && <SubtasksTab task={task} />}
          {tab === "memory" && <MemoryTab task={task} />}
          {tab === "definition" && (isSub ? <OverridesTab task={task} parent={parent} /> : <TaskDefinitionEditor task={task} onSaved={refetch} />)}
          {tab === "runs" && <TaskRuns name={name} />}
          {tab === "versions" && <VersionHistory kind="tasks" name={name} onRestored={refetch} />}
        </>
      )}
      <RunTaskDialog open={runOpen} onClose={() => setRunOpen(false)} task={parentName ?? name} subtask={object ?? undefined} />
    </Page>
  );
}

function TaskRuns({ name }: { name: string }) {
  const { pageSize } = useUi();
  const { data, loading } = useRuns({ task: name, limit: pageSize });
  return <Card><RunsTable runs={data?.items} loading={loading} columns={["status", "task", "service", "env", "trigger", "duration", "time"]} /></Card>;
}

// ———————— 概览 ————————

function OverviewTab({ task, onEditProfile }: { task: TaskSummary; onEditProfile: () => void }) {
  const { data: runs } = useRuns({ task: task.name, limit: 10 });
  const s = task.stats_24h;
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
          <CardHeader title="触发" icon={<LuZap />} description="这个任务会被什么启动" />
          {task.triggers.length === 0 ? <Empty title="没有触发器" description="只能从网页手动运行" /> : (
            <ul className="divide-y divide-line">{task.triggers.map((tr) => <TriggerRow key={tr.id} tr={tr} />)}</ul>
          )}
        </Card>
        <Card>
          <CardHeader title="近期运行" actions={<Link to={`/runs?task=${encodeURIComponent(task.name)}`} className="flex items-center gap-1 text-xs text-fg-3 hover:text-accent">全部 <LuArrowRight className="size-3" /></Link>} />
          <RunsTable runs={runs?.items} columns={["status", "service", "env", "trigger", "duration", "time"]} compact />
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
              ["角色", task.role ? <Link to={`/settings/roles/${task.role}`} className="text-accent hover:underline">{task.role}</Link> : "—"],
              ["归属", task.service === "*" ? "通用（调用时指定服务）" : task.service ?? "平台任务"],
              ["环境", task.envs.length ? <span className="flex flex-wrap gap-1">{task.envs.map((e) => <EnvBadge key={e} env={e} />)}</span> : "全部环境"],
              ["结果", <DeliverText task={task} />],
              ["记忆", <MemoryText task={task} />],
              ["去重", task.dedup ? <span><code className="font-mono text-[12px]">{task.dedup.key}</code> · {Math.round(task.dedup.window_s / 60)} 分钟窗口</span> : "不去重"],
              ["超时", `${task.timeout_s} 秒`],
            ]} />
          </div>
        </Card>
        <Card>
          <CardHeader title="输入" description="页面按它生成表单，API 按它校验" />
          {Object.keys(task.input).length === 0 ? <div className="px-4 py-4 text-[12.5px] text-fg-3">无输入字段</div> : (
            <ul className="divide-y divide-line">
              {Object.entries(task.input).map(([k, f]) => (
                <li key={k} className="px-4 py-2">
                  <div className="flex items-center gap-2"><code className="font-mono text-[12.5px] text-fg">{k}</code><span className="text-[11.5px] text-fg-3">{f.type}</span>{f.required && <Badge tone="warn">必填</Badge>}</div>
                  {f.description && <div className="mt-0.5 text-xs text-fg-3">{f.description}</div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function DeliverText({ task }: { task: TaskSummary }) {
  if (task.deliver?.channel) return <>推送到 <code className="font-mono text-[12px]">{task.deliver.channel}</code></>;
  if (task.deliver?.url) return <span className="break-all font-mono text-[12px]">POST {task.deliver.url}</span>;
  return <>调用方自取</>;
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
              <div className="border-b border-line bg-sunken/60 px-3 py-1.5 text-[11.5px] text-fg-3">规则先行：命中直接给结论（也记一条 run，resolution=rule），未命中才交给 agent</div>
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
      const r = await api.update<TaskSummary>("tasks", task.name, { profile: draft });
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
        description={<>针对具体对象（一张表、一条链路）的变体：<code className="font-mono">{task.name}:对象名</code>。调用时带 <code className="font-mono">subtask</code> 选用；点名不存在的对象会自动继承建出来。</>} />
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
                      {s.auto_created && <Badge tone="warn">自动创建</Badge>}
                      {!s.enabled && <Badge tone="idle">已停用</Badge>}
                    </div>
                    {s.title && <div className="text-[11.5px] text-fg-3">{s.title}</div>}
                  </Td>
                  <Td>{s.overrides.includes("profile") ? <span className="text-[12.5px] text-fg-2">已写</span> : (
                    <Link to={taskHref(s.name, "profile")} className="text-[12.5px] text-warn hover:underline" onClick={(e) => e.stopPropagation()}>待补全 →</Link>
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

// ———————— 记忆：这个任务名下的知识与方法 ————————

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
        <EnvFilter value={env} onChange={setEnv} />
        <span className="text-xs text-fg-3">
          {task.extends ? "只看这个对象名下的条目" : "包括子任务名下的条目"}；召回时还会带上服务通用的条目。
        </span>
      </div>
      <KnowledgeList filters={filters} scope={scope} />
      <AssetList filters={filters} scope={scope} />
    </div>
  );
}

// ———————— 子任务的覆盖项 ————————

function OverridesTab({ task, parent }: { task: TaskSummary; parent: TaskSummary | undefined }) {
  const { data: envs } = useEnvs();
  const pick = () => ({ title: task.title, description: task.description, envs: task.envs });
  const [d, setD] = useState(pick);
  useEffect(() => setD(pick()), [task.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(d) !== JSON.stringify(pick());

  const save = useMutation(async () => {
    try {
      const r = await api.update<TaskSummary>("tasks", task.name, d);
      toast(`已保存为 v${r.version}`);
      invalidate("tasks");
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  });

  const mark = (field: string) => task.overrides.includes(field) && <Badge tone="accent" className="ml-1.5">已覆盖</Badge>;
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader title="覆盖项" icon={<LuSettings />} description="子任务只覆盖少数字段；角色、触发、投递、形态始终跟随父任务。" />
        <div className="space-y-4 p-4">
          <Field label={<>显示名{mark("title")}</>} help="不填则显示对象名">
            <Input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder={parent?.title} />
          </Field>
          <Field label={<>说明{mark("description")}</>} help="会追加进 agent 的任务说明">
            <Textarea rows={3} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
          </Field>
          <Field label={<>环境{mark("envs")}</>} help="不选 = 跟随父任务">
            <div className="flex flex-wrap gap-4 pt-1">
              {(envs ?? []).map((e) => (
                <Checkbox key={e.name} checked={d.envs.includes(e.name)} label={<EnvBadge env={e.name} />}
                  onChange={(v) => setD({ ...d, envs: v ? [...d.envs, e.name] : d.envs.filter((x) => x !== e.name) })} />
              ))}
            </div>
          </Field>
        </div>
      </Card>
      <Card className="h-fit">
        <CardHeader title="跟随父任务" description={parent ? <Link to={taskHref(parent.name, "definition")} className="text-accent hover:underline">{parent.title || parent.name}</Link> : "—"} />
        <div className="p-4">
          {parent && <DescList items={[
            ["角色", parent.role ?? "—"],
            ["触发", parent.triggers.map((t) => TRIGGER[t.type].label).join("、") || "—"],
            ["结果", <DeliverText task={parent} />],
            ["输入", Object.keys(parent.input).join("、") || "—"],
          ]} />}
        </div>
      </Card>
      <SaveBar visible={dirty} saving={save.pending} onSave={() => save.mutate(undefined)} onDiscard={() => setD(pick())} />
    </div>
  );
}
