/**
 * 任务详情：概览（触发、输入、档案、近期运行）/ 定义（结构化编辑）/ 子任务 / 运行 / 版本。
 * 子任务页只编辑差异（档案等），其余字段显示继承自父任务。
 */
import { useMemo, useState } from "react";
import {
  LuActivity, LuArrowRight, LuCalendarClock, LuEllipsis, LuGitBranch, LuHistory, LuLayoutDashboard, LuListTodo, LuPlay,
  LuPlus, LuPower, LuScrollText, LuSettings, LuWebhook, LuZap,
} from "react-icons/lu";

import { api, useEnvs, useRuns, useTask, useTasks } from "@/api/hooks";
import type { TaskSummary, Trigger } from "@/api/types";
import { Page, PageHeader } from "@/components/layout/shell";
import { EnvBadge, RoleChip, RunStatusDot, TRIGGER } from "@/components/status";
import { VersionHistory } from "@/components/versions";
import { Button } from "@/components/ui/button";
import { KeyValueEditor, Markdown, Tabs, Table, Td, Th, Tr } from "@/components/ui/data";
import { Field, Input } from "@/components/ui/form";
import { Dialog, Menu, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, DescList, Empty, ErrorState, Skeleton, Stat } from "@/components/ui/primitives";
import { describeCron, nextRuns } from "@/lib/cron";
import { cn } from "@/lib/cn";
import { ago, dayjs, duration, pct } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { Link, navigate, useParams, useSearch } from "@/lib/router";
import { RunsTable } from "../runs/runs-table";
import { PROFILE_LABEL } from "../services/service-detail";
import { RunTaskDialog } from "./run-dialog";
import { TaskDefinitionEditor } from "./task-editor";
import { FORM_META } from "./tasks";

type TabKey = "overview" | "definition" | "subtasks" | "runs" | "versions";

export function TaskDetailPage() {
  const { name } = useParams<{ name: string }>();
  const [search, setSearch] = useSearch<{ tab: TabKey }>();
  const { data: task, error, refetch } = useTask(name);
  const { data: all } = useTasks();
  const [runOpen, setRunOpen] = useState(false);
  const isSub = name.includes(":");
  const parentName = task?.extends ?? (isSub ? name.split(":")[0] : null);
  const parent = all?.find((t) => t.name === parentName);
  const effective = useMemo(() => (task && parent ? { ...parent, ...pickOverrides(task), name: task.name, context: { ...parent.context, ...task.context } } : task), [task, parent]);
  const subs = (all ?? []).filter((t) => t.extends === name);
  const tab = (search.tab as TabKey) || "overview";

  if (error) return <Page><ErrorState error={error} onRetry={refetch} /></Page>;

  const toggle = async () => {
    if (!task) return;
    const ok = await confirm({ title: task.enabled ? `停用 ${task.name}？` : `启用 ${task.name}？`, description: task.enabled ? "停用后新提交与事件拒收（task_disabled），定时暂停。" : "启用后立即恢复。", danger: task.enabled, confirmText: task.enabled ? "停用" : "启用" });
    if (!ok) return;
    await api.putTask(task.name, { enabled: !task.enabled });
    toast(task.enabled ? "已停用" : "已启用");
    invalidate("tasks");
  };

  return (
    <Page wide>
      <PageHeader
        crumbs={[{ label: "任务", to: "/tasks" }, ...(parentName ? [{ label: parentName, to: `/tasks/${encodeURIComponent(parentName)}` }] : []), { label: isSub ? name.split(":")[1] : name }]}
        icon={isSub ? <LuGitBranch /> : <LuListTodo />}
        title={<span className="flex items-center gap-2">
          {isSub ? <span className="font-mono">{name}</span> : task?.title || name}
          {task && !task.enabled && <Badge tone="idle">已停用</Badge>}
          {task?.auto_created && <Badge tone="warn">自动创建</Badge>}
        </span>}
        description={isSub ? <>子任务：继承 <Link to={`/tasks/${encodeURIComponent(parentName!)}`} className="text-accent hover:underline">{parent?.title || parentName}</Link> 的全部定义，只写差异（通常是这个对象的档案）</> : task?.description}
        meta={effective && <>
          {!isSub && <span className="font-mono">{effective.name}</span>}
          <span>{effective.service === "*" ? "通用任务" : effective.service ? <>服务 <Link to={`/services/${effective.service}`} className="text-fg-2 hover:text-accent">{effective.service}</Link></> : "平台任务"}</span>
          <span className="flex items-center gap-1">{FORM_META[effective.form].label}</span>
          <RoleChip role={effective.role} />
          {task && <span>v{task.version} · {task.updated_by} · {ago(task.updated_at)}</span>}
        </>}
        actions={<>
          <Button variant="primary" icon={<LuPlay />} onClick={() => setRunOpen(true)} disabled={!effective?.enabled}>运行</Button>
          <Menu trigger={<Button size="icon" aria-label="更多"><LuEllipsis /></Button>} items={[
            { label: task?.enabled ? "停用任务" : "启用任务", icon: <LuPower />, danger: task?.enabled, onClick: toggle },
            { label: "查看全部运行", icon: <LuActivity />, onClick: () => navigate(`/runs?task=${encodeURIComponent(name)}`) },
          ]} />
        </>}
      />
      <Tabs className="mb-5" value={tab} onChange={(v) => setSearch({ tab: v === "overview" ? undefined : v })} tabs={[
        { value: "overview", label: "概览", icon: <LuLayoutDashboard /> },
        { value: "definition", label: isSub ? "档案与覆盖" : "定义", icon: <LuSettings /> },
        ...(!isSub ? [{ value: "subtasks" as TabKey, label: "子任务", icon: <LuGitBranch />, count: subs.length }] : []),
        { value: "runs", label: "运行", icon: <LuActivity /> },
        { value: "versions", label: "版本", icon: <LuHistory /> },
      ]} />
      {!task || !effective ? <Skeleton className="h-96" /> : (
        <>
          {tab === "overview" && <OverviewTab task={effective} raw={task} />}
          {tab === "definition" && (isSub ? <SubtaskEditor task={task} parent={parent} onSaved={refetch} /> : <TaskDefinitionEditor task={task} onSaved={refetch} />)}
          {tab === "subtasks" && <SubtasksTab task={task} subs={subs} />}
          {tab === "runs" && <TaskRuns name={name} />}
          {tab === "versions" && <VersionHistory kind="tasks" name={name} onRestored={refetch} />}
        </>
      )}
      <RunTaskDialog open={runOpen} onClose={() => setRunOpen(false)} task={isSub ? parentName! : name} />
    </Page>
  );
}

function pickOverrides(t: TaskSummary): Partial<TaskSummary> {
  // mock/后端返回的子任务只带差异字段；这里只取有意义的覆盖
  const o: Partial<TaskSummary> = {};
  if (t.timeout_s && t.timeout_s !== 300) o.timeout_s = t.timeout_s;
  if (!t.enabled) o.enabled = false;
  o.stats_24h = t.stats_24h;
  o.last_run = t.last_run;
  o.version = t.version;
  return o;
}

function TaskRuns({ name }: { name: string }) {
  const { data, loading } = useRuns({ task: name, limit: 40 });
  return <Card><RunsTable runs={data?.items} loading={loading} columns={["status", "task", "service", "env", "trigger", "duration", "time"]} /></Card>;
}

// ———————— 概览 ————————

function OverviewTab({ task, raw }: { task: TaskSummary; raw: TaskSummary }) {
  const { data: runs } = useRuns({ task: raw.name, limit: 10 });
  const s = raw.stats_24h;
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <div className="min-w-0 space-y-4">
        <Card className="grid grid-cols-4 divide-x divide-line">
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
          <CardHeader title="近期运行" actions={<Link to={`/runs?task=${encodeURIComponent(raw.name)}`} className="flex items-center gap-1 text-xs text-fg-3 hover:text-accent">全部 <LuArrowRight className="size-3" /></Link>} />
          <RunsTable runs={runs?.items} columns={["status", "service", "env", "trigger", "duration", "time"]} compact />
        </Card>
      </div>
      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader title="定义摘要" />
          <div className="p-4">
            <DescList items={[
              ["角色", task.role ? <Link to={`/settings/roles/${task.role}`} className="text-accent hover:underline">{task.role}</Link> : "—"],
              ["归属", task.service === "*" ? "通用（调用时指定服务）" : task.service ?? "平台任务"],
              ["环境", task.envs.length ? <span className="flex flex-wrap gap-1">{task.envs.map((e) => <EnvBadge key={e} env={e} />)}</span> : "全部环境"],
              ["结果", { caller: "调用方自取", dingtalk: "推送钉钉", http: <span className="break-all font-mono text-[12px]">POST {task.output.callback}</span> }[task.output.channel]],
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
        <Card>
          <CardHeader title="任务档案" icon={<LuScrollText />} description="置顶逐字注入；子任务的档案与父任务按键合并" />
          <div className="p-4">
            {Object.keys(task.context).length === 0 ? <div className="text-[12.5px] text-fg-3">没有档案</div> : (
              <dl className="space-y-3">{Object.entries(task.context).map(([k, v]) => (
                <div key={k}><dt className="text-[11.5px] font-medium text-fg-3">{PROFILE_LABEL[k] ?? k}</dt><dd className="mt-0.5"><Markdown text={v} /></dd></div>
              ))}</dl>
            )}
          </div>
        </Card>
      </div>
    </div>
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

// ———————— 子任务 ————————

function SubtasksTab({ task, subs }: { task: TaskSummary; subs: TaskSummary[] }) {
  const [creating, setCreating] = useState(false);
  return (
    <Card>
      <CardHeader title="子任务" icon={<LuGitBranch />}
        description={<>针对具体对象的变体：<code className="font-mono">{task.name}:对象名</code>。调用时显式带 <code className="font-mono">subtask</code> 选用；点名不存在时自动继承建桩。</>}
        actions={<Button size="sm" icon={<LuPlus />} onClick={() => setCreating(true)}>新建子任务</Button>} />
      {subs.length === 0 ? <Empty icon={<LuGitBranch />} title="还没有子任务" description="某个对象（一张表、一条链路）的业务信息很多很重要时，为它建子任务挂档案" /> : (
        <Table>
          <thead><tr><Th>对象</Th><Th>档案</Th><Th>近 24 小时</Th><Th>最近</Th><Th>更新</Th></tr></thead>
          <tbody>
            {subs.map((s) => (
              <Tr key={s.name} onClick={() => navigate(`/tasks/${encodeURIComponent(s.name)}`)}>
                <Td>
                  <div className="flex items-center gap-2"><span className="font-mono text-[12.5px] font-medium text-fg">{s.name.split(":")[1]}</span>{s.auto_created && <Badge tone="warn">自动创建</Badge>}</div>
                </Td>
                <Td>{Object.keys(s.context).length ? <span className="text-[12.5px] text-fg-2">{Object.keys(s.context).map((k) => PROFILE_LABEL[k] ?? k).join("、")}</span> : <Badge tone="warn">待补全</Badge>}</Td>
                <Td className="tabular-nums text-fg-2">{s.stats_24h.runs || "—"}</Td>
                <Td>{s.last_run ? <span className="flex items-center gap-1.5 text-[12.5px] text-fg-3"><RunStatusDot status={s.last_run.status} />{ago(s.last_run.created_at)}</span> : "—"}</Td>
                <Td className="text-[12.5px] text-fg-3">v{s.version} · {s.updated_by} · {ago(s.updated_at)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <CreateSubtaskDialog parent={task} open={creating} onClose={() => setCreating(false)} />
    </Card>
  );
}

function CreateSubtaskDialog({ parent, open, onClose }: { parent: TaskSummary; open: boolean; onClose: () => void }) {
  const [obj, setObj] = useState("");
  const [context, setContext] = useState<Record<string, string>>({});
  const valid = /^[^:\s/\\]{1,120}$/.test(obj);
  const create = useMutation(async () => {
    try {
      const name = `${parent.name}:${obj}`;
      await api.createTask({ name, extends: parent.name, context });
      invalidate("tasks");
      onClose();
      navigate(`/tasks/${encodeURIComponent(name)}`);
    } catch (e) {
      toast.error("创建失败", (e as Error).message);
    }
  });
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="新建子任务" description="继承父任务的全部定义；这里只填这个对象特有的档案"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!valid} loading={create.pending} onClick={() => create.mutate(undefined)}>创建</Button></>}>
      <Field label="对象名" required help="调用时 subtask 传这个值即选用；不能含冒号、空白、斜杠">
        <div className="flex items-center gap-2"><span className="font-mono text-[12.5px] text-fg-3">{parent.name}:</span><Input mono autoFocus value={obj} onChange={(e) => setObj(e.target.value)} placeholder="dwd_trade_order" /></div>
      </Field>
      <Field label="档案" className="mt-4"><KeyValueEditor value={context} onChange={setContext} suggestions={[{ key: "code_refs", label: "代码位置" }, { key: "upstream", label: "上游依赖" }, { key: "pitfalls", label: "常见坑" }]} /></Field>
    </Dialog>
  );
}

function SubtaskEditor({ task, parent, onSaved }: { task: TaskSummary; parent: TaskSummary | undefined; onSaved: () => void }) {
  const [context, setContext] = useState(task.context);
  const dirty = JSON.stringify(context) !== JSON.stringify(task.context);
  const save = useMutation(async () => {
    try {
      const r = await api.putTask(task.name, { context });
      toast(`已保存为 v${r.version}`);
      invalidate("tasks");
      onSaved();
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  });
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader title="子任务档案" icon={<LuScrollText />} description="与父任务档案按键合并（同名键子任务赢），置顶逐字注入" />
        <div className="p-4">
          <KeyValueEditor value={context} onChange={setContext} suggestions={[{ key: "code_refs", label: "代码位置" }, { key: "upstream", label: "上游依赖" }, { key: "downstream", label: "下游影响" }, { key: "pitfalls", label: "常见坑" }]} />
          <div className="mt-4 flex justify-end gap-2">
            <Button disabled={!dirty} onClick={() => setContext(task.context)}>还原</Button>
            <Button variant="primary" disabled={!dirty} loading={save.pending} onClick={() => save.mutate(undefined)}>保存</Button>
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader title="继承自父任务" description={parent ? <Link to={`/tasks/${encodeURIComponent(parent.name)}`} className="text-accent hover:underline">{parent.title || parent.name}</Link> : "—"} />
        <div className="p-4">
          {parent && <DescList items={[
            ["角色", parent.role ?? "—"], ["触发", parent.triggers.map((t) => TRIGGER[t.type].label).join("、") || "—"],
            ["环境", parent.envs.join("、") || "全部"], ["输入", Object.keys(parent.input).join("、") || "—"],
            ["父档案", Object.keys(parent.context).map((k) => PROFILE_LABEL[k] ?? k).join("、") || "无"],
          ]} />}
        </div>
      </Card>
    </div>
  );
}

export function useEnvNames() {
  const { data } = useEnvs();
  return (data ?? []).filter((e) => e.enabled).map((e) => e.name);
}
