/**
 * 任务列表：按服务分组，父任务一行；有子任务的父任务可以展开，子任务缩进列在它下面。
 * 搜索同时匹配子任务（对象名），命中子任务时父任务自动展开；「展开全部子任务」一键全开。
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { LuChevronDown, LuChevronRight, LuGitBranch, LuListTodo, LuPlay, LuPlus, LuTerminal, LuWorkflow } from "react-icons/lu";

import { api, useRoles, useServices, useTasks } from "@/api/hooks";
import type { Task, TaskSummary, Trigger } from "@/api/types";
import { RatioBar } from "@/components/charts";
import { Page, PageHeader } from "@/components/layout/shell";
import { RoleChip, RunStatusDot, TRIGGER } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Table, Td, Th, Tr } from "@/components/ui/data";
import { Field, FilterSelect, Input, SearchInput, Select, Switch, Textarea } from "@/components/ui/form";
import { Dialog, Tooltip, toast } from "@/components/ui/overlay";
import { Badge, Card, Empty, SkeletonRows } from "@/components/ui/primitives";
import { describeCron } from "@/lib/cron";
import { cn } from "@/lib/cn";
import { ago, pct, until } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { Link, navigate, useSearch } from "@/lib/router";
import { RunTaskDialog } from "./run-dialog";

const taskHref = (name: string) => `/tasks/${encodeURIComponent(name)}`;
const objectOf = (name: string) => name.split(":")[1] ?? name;

export function TasksPage() {
  const [search, setSearch] = useSearch<{ service: string; trigger: string; q: string; run: string; subs: string }>();
  const { data: tasks, loading } = useTasks();
  const { data: services } = useServices();
  const [creating, setCreating] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  useEffect(() => { if (search.run) { setRunOpen(true); setSearch({ run: undefined }); } }, [search.run, setSearch]);

  const q = (search.q ?? "").toLowerCase();
  const matches = (t: TaskSummary) => (t.name + t.title + t.description).toLowerCase().includes(q);
  const subsOf = useMemo(() => {
    const map = new Map<string, TaskSummary[]>();
    for (const t of tasks ?? []) if (t.extends) map.set(t.extends, [...(map.get(t.extends) ?? []), t]);
    return map;
  }, [tasks]);

  /** 父任务本身命中，或它的某个子任务命中，都算命中；后者只显示命中的子任务 */
  const rows = useMemo(() => (tasks ?? []).filter((t) => !t.extends
    && (!search.service || t.service === search.service || (search.service === "_generic" && t.service === "*") || (search.service === "_platform" && !t.service))
    && (!search.trigger || t.triggers.some((tr) => tr.type === search.trigger)))
    .map((t) => {
      const subs = subsOf.get(t.name) ?? [];
      if (!q || matches(t)) return { task: t, subs, hit: false };
      const hitSubs = subs.filter(matches);
      return hitSubs.length ? { task: t, subs: hitSubs, hit: true } : null;
    })
    .filter((r): r is TaskRow => r !== null), [tasks, subsOf, search, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const order = [...(services ?? []).map((s) => s.name), "*", ""];
    const map = new Map<string, TaskRow[]>();
    for (const r of rows) map.set(r.task.service ?? "", [...(map.get(r.task.service ?? "") ?? []), r]);
    return order.filter((k) => map.has(k)).map((k) => ({
      key: k, rows: map.get(k)!,
      title: k === "*" ? "通用任务" : k === "" ? "平台任务" : services?.find((s) => s.name === k)?.title ?? k,
      hint: k === "*" ? "调用时指定服务" : k === "" ? "不涉及业务服务" : k,
    }));
  }, [rows, services]);

  const subCount = rows.reduce((n, r) => n + r.subs.length, 0);
  const expandAll = search.subs === "1";

  return (
    <Page wide>
      <PageHeader title="任务" description="要做的事：目标 + 形态 + 输入 + 触发 + 输出。触发全部声明在任务上——API、对话、定时（按环境）、事件。"
        actions={<>
          <Button icon={<LuPlus />} onClick={() => setCreating(true)}>新建任务</Button>
          <Button variant="primary" icon={<LuPlay />} onClick={() => setRunOpen(true)}>运行任务</Button>
        </>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={search.q ?? ""} onChange={(v) => setSearch({ q: v })} placeholder="搜索任务或对象…" className="w-60" />
        <FilterSelect label="服务" allLabel="全部" value={search.service ?? ""} onChange={(v) => setSearch({ service: v })}
          options={[...(services ?? []).map((s) => ({ value: s.name, label: s.title })), { value: "_generic", label: "通用任务" }, { value: "_platform", label: "平台任务" }]} />
        <FilterSelect label="触发" allLabel="全部" value={search.trigger ?? ""} onChange={(v) => setSearch({ trigger: v })}
          options={["api", "chat", "schedule", "event"].map((t) => ({ value: t, label: TRIGGER[t].label, icon: <span className="text-fg-3 [&_svg]:size-3.5">{TRIGGER[t].icon}</span> }))} />
        <Switch size="sm" checked={expandAll} onChange={(v) => setSearch({ subs: v ? "1" : undefined })} label={<span className="text-[12.5px] text-fg-2">展开全部子任务</span>} />
        <span className="ml-auto text-xs text-fg-3">{tasks ? `${rows.length} 个任务 · ${subCount} 个子任务` : ""}</span>
      </div>
      <Card>
        {loading ? <SkeletonRows rows={8} /> : groups.length === 0 ? (
          <Empty icon={<LuListTodo />} title="没有匹配的任务" action={<Button icon={<LuPlus />} onClick={() => setCreating(true)}>新建任务</Button>} />
        ) : (
          <TasksTable groups={groups} expandAll={expandAll || !!q} />
        )}
      </Card>
      <CreateTaskDialog open={creating} onClose={() => setCreating(false)} />
      <RunTaskDialog open={runOpen} onClose={() => setRunOpen(false)} />
    </Page>
  );
}

/** 一行父任务 + 它要显示的子任务；hit = 父任务本身没命中搜索，是因为子任务命中才出现 */
export interface TaskRow { task: TaskSummary; subs: TaskSummary[]; hit: boolean }

export function triggerSummary(tr: Trigger): string {
  if (tr.type === "schedule") return `${describeCron(tr.cron)} · ${tr.envs.join("/")}`;
  if (tr.type === "event") return `${tr.source}.${tr.event}${tr.rules?.length ? ` · ${tr.rules.length} 条规则` : ""}`;
  return TRIGGER[tr.type].label;
}

export function TriggerChips({ triggers, max = 3 }: { triggers: Trigger[]; max?: number }) {
  const list = triggers.filter((t) => t.enabled !== false);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {list.slice(0, max).map((tr) => (
        <Tooltip key={tr.id} content={triggerSummary(tr)}>
          <span className="inline-flex h-5 items-center gap-1 rounded border border-line bg-panel px-1.5 text-[11.5px] text-fg-2 [&_svg]:size-3 [&_svg]:text-fg-3">
            {TRIGGER[tr.type].icon}
            {tr.type === "schedule" ? describeCron(tr.cron) : tr.type === "event" ? tr.source : TRIGGER[tr.type].label}
          </span>
        </Tooltip>
      ))}
      {list.length > max && <span className="text-[11.5px] text-fg-3">+{list.length - max}</span>}
      {!list.length && <span className="text-[11.5px] text-fg-3">无触发</span>}
    </div>
  );
}

export const FORM_META: Record<Task["form"], { label: string; icon: React.ReactNode }> = {
  agent: { label: "单角色", icon: <LuTerminal /> }, graph: { label: "任务图", icon: <LuWorkflow /> }, builtin: { label: "内建", icon: <LuTerminal /> },
};

/**
 * 任务表。groups 有标题时按服务分组显示；服务页等处传一个无标题的组即可（见 taskRowsOf）。
 * 有子任务的父任务行首有展开箭头；expandAll 时全部展开。
 */
export function TasksTable({ groups, expandAll = false, hideService = true }: {
  groups: { key: string; title?: string; hint?: string; rows: TaskRow[] }[]; expandAll?: boolean; hideService?: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [runSub, setRunSub] = useState<TaskSummary | null>(null);
  const toggle = (name: string) => setOpen((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const cols = hideService ? 6 : 7;
  return (
    <>
      <Table>
        <thead>
          <tr>
            <Th>任务</Th>
            {!hideService && <Th>服务</Th>}
            <Th>触发</Th>
            <Th>角色</Th>
            <Th className="w-[150px]">近 24 小时</Th>
            <Th>最近</Th>
            <Th>下次定时</Th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.key}>
              {g.title && (
                <tr>
                  <td colSpan={cols} className="border-b border-line bg-sunken/50 px-4 py-1.5">
                    <span className="text-[12px] font-semibold text-fg-2">{g.title}</span>
                    <span className="ml-2 font-mono text-[11px] text-fg-3">{g.hint}</span>
                    <span className="ml-2 text-[11px] text-fg-3">{g.rows.length}</span>
                  </td>
                </tr>
              )}
              {g.rows.map((r) => {
                const expanded = r.subs.length > 0 && (expandAll || r.hit || open.has(r.task.name));
                return (
                  <Fragment key={r.task.name}>
                    <ParentRow row={r} expanded={expanded} hideService={hideService} onToggle={() => toggle(r.task.name)} />
                    {expanded && r.subs.map((sub) => <SubRow key={sub.name} sub={sub} hideService={hideService} onRun={() => setRunSub(sub)} />)}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </Table>
      <RunTaskDialog open={!!runSub} onClose={() => setRunSub(null)} task={runSub?.extends ?? undefined} subtask={runSub ? objectOf(runSub.name) : undefined} />
    </>
  );
}

/** 把任务列表整理成一个无标题组（父任务 + 全部子任务），给服务页这类不分组的地方用 */
export function taskRowsOf(tasks: TaskSummary[] | undefined): TaskRow[] {
  const all = tasks ?? [];
  return all.filter((t) => !t.extends).map((t) => ({ task: t, subs: all.filter((x) => x.extends === t.name), hit: false }));
}

function Stats24h({ t }: { t: TaskSummary }) {
  const s = t.stats_24h;
  if (!s.runs) return <span className="text-[12px] text-fg-3">—</span>;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11.5px]">
        <span className="tabular-nums text-fg">{s.runs} 次</span>
        <span className={cn("tabular-nums", s.failed ? "text-bad" : "text-ok")}>{pct(s.success, s.success + s.failed)}</span>
      </div>
      <RatioBar ok={s.success} bad={s.failed} total={s.runs} />
    </div>
  );
}

const LastRun = ({ t }: { t: TaskSummary }) => t.last_run
  ? <span className="flex items-center gap-1.5 text-[12.5px] text-fg-3"><RunStatusDot status={t.last_run.status} />{ago(t.last_run.created_at)}</span>
  : <span className="text-fg-3">—</span>;

function ParentRow({ row, expanded, hideService, onToggle }: { row: TaskRow; expanded: boolean; hideService: boolean; onToggle: () => void }) {
  const t = row.task;
  const n = t.subtask_count || row.subs.length;
  const pending = row.subs.filter((x) => !x.overrides.includes("profile")).length;
  return (
    <Tr onClick={() => navigate(taskHref(t.name))} className={cn(!t.enabled && "opacity-60")}>
      <Td className="max-w-[380px]">
        <div className="flex items-center gap-1.5">
          {n > 0 ? (
            <button type="button" aria-label={expanded ? "收起子任务" : "展开子任务"} onClick={(e) => { e.stopPropagation(); onToggle(); }}
              className="-ml-1 rounded p-0.5 text-fg-3 hover:bg-hover hover:text-fg">
              {expanded ? <LuChevronDown className="size-3.5" /> : <LuChevronRight className="size-3.5" />}
            </button>
          ) : <span className="w-[18px] shrink-0" />}
          <Link to={taskHref(t.name)} onClick={(e) => e.stopPropagation()} className="truncate font-medium text-fg hover:text-accent">{t.title || t.name}</Link>
          {t.form !== "agent" && <Badge tone="accent" icon={FORM_META[t.form].icon}>{FORM_META[t.form].label}</Badge>}
          {!t.enabled && <Badge tone="idle">已停用</Badge>}
        </div>
        <div className="mt-0.5 flex items-center gap-2 pl-[22px] font-mono text-[11px] text-fg-3">
          {t.name}
          {n > 0 && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onToggle(); }} className="flex items-center gap-0.5 font-sans hover:text-accent">
              <LuGitBranch className="size-3" />{n} 个子任务{pending > 0 && <span className="text-warn"> · {pending} 个档案待补</span>}
            </button>
          )}
        </div>
      </Td>
      {!hideService && <Td className="text-fg-2">{t.service === "*" ? "通用" : t.service ?? "平台"}</Td>}
      <Td><TriggerChips triggers={t.triggers} /></Td>
      <Td><RoleChip role={t.role} /></Td>
      <Td><Stats24h t={t} /></Td>
      <Td><LastRun t={t} /></Td>
      <Td className="text-[12.5px]">{t.next_fire ? <span className="text-fg-2">{until(t.next_fire.at)} <span className="font-mono text-[11px] uppercase text-fg-3">{t.next_fire.env}</span></span> : <span className="text-fg-3">—</span>}</Td>
    </Tr>
  );
}

/** 子任务行：缩进在父任务下面；只显示它自己的信息，跟随父任务的列显示"同父任务" */
function SubRow({ sub, hideService, onRun }: { sub: TaskSummary; hideService: boolean; onRun: () => void }) {
  const ownTriggers = sub.overrides.includes("triggers");
  return (
    <Tr onClick={() => navigate(taskHref(sub.name))} className={cn("bg-sunken/25", !sub.enabled && "opacity-60")}>
      <Td className="max-w-[380px]">
        <div className="flex items-center gap-2 pl-[22px]">
          <span className="h-4 w-3 shrink-0 rounded-bl border-b border-l border-line-strong" />
          <Link to={taskHref(sub.name)} onClick={(e) => e.stopPropagation()} className="truncate font-mono text-[12.5px] font-medium text-fg hover:text-accent">{objectOf(sub.name)}</Link>
          {sub.title && sub.title !== objectOf(sub.name) && <span className="truncate text-[12px] text-fg-3">{sub.title}</span>}
          {sub.auto_created && <Badge tone="warn">自动创建</Badge>}
          {!sub.enabled && <Badge tone="idle">已停用</Badge>}
          {!sub.overrides.includes("profile") && (
            <Link to={`${taskHref(sub.name)}?tab=profile`} onClick={(e) => e.stopPropagation()} className="shrink-0 text-[11.5px] text-warn hover:underline">档案待补</Link>
          )}
          <Tooltip content={`运行 ${sub.name}`}>
            <button type="button" aria-label="运行" disabled={!sub.enabled} onClick={(e) => { e.stopPropagation(); onRun(); }}
              className="ml-auto rounded p-1 text-fg-3 hover:bg-hover hover:text-accent disabled:opacity-40"><LuPlay className="size-3.5" /></button>
          </Tooltip>
        </div>
      </Td>
      {!hideService && <Td />}
      <Td>{ownTriggers ? <TriggerChips triggers={sub.triggers} /> : <span className="text-[12px] text-fg-3">同父任务</span>}</Td>
      <Td><span className="text-[12px] text-fg-3">同父任务</span></Td>
      <Td><Stats24h t={sub} /></Td>
      <Td><LastRun t={sub} /></Td>
      <Td className="text-fg-3">—</Td>
    </Tr>
  );
}

function CreateTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: services } = useServices();
  const { data: roles } = useRoles();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [service, setService] = useState<string>("*");
  const [role, setRole] = useState<string>("");
  const [form, setForm] = useState<Task["form"]>("agent");
  const [description, setDescription] = useState("");
  const valid = /^[a-z][a-z0-9-]{1,48}$/.test(name);
  const create = useMutation(async () => {
    try {
      await api.create("tasks", { name, title, description, service: service === "_platform" ? null : service, role: role || null, form, triggers: [{ id: "api", type: "api" }] });
      invalidate("tasks");
      toast("任务已创建", { description: "接着配置输入、触发与输出" });
      onClose();
      navigate(`/tasks/${name}?tab=definition`); // 新任务先去补输入、触发与投递
    } catch (e) {
      toast.error("创建失败", (e as Error).message);
    }
  });
  return (
    <Dialog open={open} onClose={onClose} title="新建任务" size="lg"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!valid || (form === "agent" && !role)} loading={create.pending} onClick={() => create.mutate(undefined)}>创建</Button></>}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="任务名" required help="小写字母、数字、连字符；子任务请在父任务页里建" error={name && !valid ? "格式不对" : null}>
          <Input mono autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="daily-inspection" />
        </Field>
        <Field label="显示名"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="日常巡检" /></Field>
        <Field label="归属" help="专属任务只在该服务上跑；通用任务调用时指定服务；平台任务不涉及业务服务">
          <Select value={service} onChange={setService} options={[
            ...(services ?? []).map((s) => ({ value: s.name, label: s.title, hint: "专属 · " + s.name })),
            { value: "*", label: "通用任务", hint: "调用时指定服务" },
            { value: "_platform", label: "平台任务", hint: "不涉及业务服务" },
          ]} />
        </Field>
        <Field label="形态">
          <Select value={form} onChange={(v) => setForm(v as Task["form"])} options={[
            { value: "agent", label: "单角色", hint: "一个角色完成整件事（最常用）" },
            { value: "graph", label: "任务图", hint: "节点是产物、边是依赖，可复用未变的产物" },
            { value: "builtin", label: "内建处理器", hint: "不过模型的确定性维护作业" },
          ]} />
        </Field>
        {form !== "builtin" && (
          <Field label="角色" required={form === "agent"} className="md:col-span-2">
            <Select value={role || null} onChange={setRole} placeholder="选择执行角色"
              options={(roles ?? []).map((r) => ({ value: r.name, label: r.title || r.name, hint: r.description }))} />
          </Field>
        )}
        <Field label="说明" className="md:col-span-2"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="这个任务要达成什么" /></Field>
      </div>
    </Dialog>
  );
}
