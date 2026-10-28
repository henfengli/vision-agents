/**
 * 任务列表：按服务分组，父任务一行；有子任务的父任务可以展开，子任务缩进列在它下面。
 * 搜索同时匹配子任务（对象名），命中子任务时父任务自动展开；「展开全部子任务」一键全开。
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { LuBot, LuChevronDown, LuChevronRight, LuGitBranch, LuListTodo, LuPlay, LuPlus, LuTerminal } from "react-icons/lu";

import { useServices, useTasks } from "@/api/hooks";
import type { Task, TaskSummary, Trigger } from "@/api/types";
import { RatioBar } from "@/components/charts";
import { Page, PageHeader } from "@/components/layout/shell";
import { EnvBadge, RoleChip, RunStatusDot, TRIGGER } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Table, Td, Th, Tr } from "@/components/ui/data";
import { FilterSelect, SearchInput, Switch } from "@/components/ui/form";
import { Tooltip } from "@/components/ui/overlay";
import { Badge, Card, Empty, ErrorState, SkeletonRows } from "@/components/ui/primitives";
import { describeCron } from "@/lib/cron";
import { cn } from "@/lib/cn";
import { ago, datetime, pct, until } from "@/lib/format";
import { Link, navigate, useSearch } from "@/lib/router";
import { ASK_TASK, RunTaskDialog } from "./run-dialog";

const taskHref = (name: string) => `/tasks/${encodeURIComponent(name)}`;
const objectOf = (name: string) => name.split(":")[1] ?? name;

export function TasksPage() {
  const [search, setSearch] = useSearch<{ service: string; trigger: string; q: string; run: string; subs: string }>();
  const { data: tasks, loading, error, refetch } = useTasks();
  const { data: services } = useServices();
  const [runOpen, setRunOpen] = useState(false);
  const create = () => navigate("/tasks/_new");
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
    const map = new Map<string, TaskRow[]>();
    for (const r of rows) map.set(r.task.service ?? "", [...(map.get(r.task.service ?? "") ?? []), r]);
    // 服务列表还没到、或任务指向的服务已不存在：这些任务也要列出来（排在已知服务之后），不能凭空消失
    const known = (services ?? []).map((s) => s.name);
    const order = [...known, ...[...map.keys()].filter((k) => k && k !== "*" && !known.includes(k)), "*", ""];
    return order.filter((k) => map.has(k)).map((k) => ({
      // 通用入口 ask 排在通用任务的最前面
      key: k, rows: [...map.get(k)!].sort((a, b) => Number(b.task.name === ASK_TASK) - Number(a.task.name === ASK_TASK)),
      title: k === "*" ? "通用任务" : k === "" ? "平台任务" : services?.find((s) => s.name === k)?.title ?? k,
      hint: k === "*" ? "调用时指定服务" : k === "" ? "不涉及业务服务" : k,
    }));
  }, [rows, services]);

  const subCount = rows.reduce((n, r) => n + r.subs.length, 0);
  const expandAll = search.subs === "1";

  return (
    <Page wide>
      <PageHeader title="任务" description="要 agent 做的事：谁来做、什么时候跑、结果发到哪。"
        actions={<>
          <Button icon={<LuPlus />} onClick={create}>新建任务</Button>
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
        {error && !tasks ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={8} /> : groups.length === 0 ? (
          <Empty icon={<LuListTodo />} title={q || search.service || search.trigger ? "没有匹配的任务" : "还没有任务"}
            description={q || search.service || search.trigger ? "换个关键词或放宽筛选" : undefined}
            action={<Button icon={<LuPlus />} onClick={create}>新建任务</Button>} />
        ) : (
          <TasksTable groups={groups} expandAll={expandAll || !!q} />
        )}
      </Card>
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
          <span className="inline-flex h-5 items-center gap-1 whitespace-nowrap rounded border border-line bg-panel px-1.5 text-[11.5px] text-fg-2 [&_svg]:size-3 [&_svg]:text-fg-3">
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
  agent: { label: "单角色", icon: <LuBot /> }, builtin: { label: "内建", icon: <LuTerminal /> },
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
            {/* 窄屏（< 1280）角色并到任务名下面那行，表格不用横向滚 */}
            <Th className="hidden xl:table-cell">角色</Th>
            <Th className="w-[120px]">近 24 小时</Th>
            <Th className="w-[100px]">最近一次</Th>
            <Th className="w-[130px]">下次定时</Th>
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
                    {expanded && r.subs.map((sub) => <SubRow key={sub.name} sub={sub} hideService={hideService} parentEnabled={r.task.enabled} onRun={() => setRunSub(sub)} />)}
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
  ? <Link to={`/runs/${t.last_run.run_id}`} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 whitespace-nowrap text-[12.5px] text-fg-3 hover:text-accent"><RunStatusDot status={t.last_run.status} />{ago(t.last_run.created_at)}</Link>
  : <span className="text-fg-3">—</span>;

function ParentRow({ row, expanded, hideService, onToggle }: { row: TaskRow; expanded: boolean; hideService: boolean; onToggle: () => void }) {
  const t = row.task;
  // 搜索时只列命中的子任务，数字也按列出来的算，不然"3 个子任务"展开只看到 1 个
  const n = row.hit ? row.subs.length : t.subtask_count || row.subs.length;
  const pending = row.subs.filter((x) => !x.overrides.includes("profile")).length;
  return (
    <Tr onClick={() => navigate(taskHref(t.name))} className={cn(!t.enabled && "opacity-60")}>
      <Td className="min-w-[200px] max-w-[420px]">
        <div className="flex items-center gap-1.5">
          {n > 0 ? (
            <button type="button" aria-label={expanded ? "收起子任务" : "展开子任务"} onClick={(e) => { e.stopPropagation(); onToggle(); }}
              className="-ml-1 rounded p-0.5 text-fg-3 hover:bg-hover hover:text-fg">
              {expanded ? <LuChevronDown className="size-3.5" /> : <LuChevronRight className="size-3.5" />}
            </button>
          ) : <span className="w-[14px] shrink-0" />}
          <Link to={taskHref(t.name)} onClick={(e) => e.stopPropagation()} className="truncate font-medium text-fg hover:text-accent">{t.title || t.name}</Link>
          {t.name === ASK_TASK && <Badge tone="accent">通用入口</Badge>}
          {t.form !== "agent" && <Badge tone="accent" icon={FORM_META[t.form].icon}>{FORM_META[t.form].label}</Badge>}
          {!t.enabled && <Badge tone="idle">已停用</Badge>}
        </div>
        {t.name === ASK_TASK && <div className="mt-0.5 pl-[22px] text-[11.5px] text-fg-3">直接提问或交代一件事；要定时、事件、推送时再建正式任务</div>}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 pl-[22px] text-[11px] text-fg-3">
          <span className="font-mono">{t.name}</span>
          {t.role && t.form !== "builtin" && <span className="inline-flex items-center gap-0.5 xl:hidden"><LuBot className="size-3" />{t.role}</span>}
          {n > 0 && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onToggle(); }} className="flex items-center gap-0.5 whitespace-nowrap hover:text-accent">
              <LuGitBranch className="size-3" />{n} 个子任务{pending > 0 && <span className="text-warn"> · {pending} 个档案待补</span>}
            </button>
          )}
        </div>
      </Td>
      {!hideService && <Td className="whitespace-nowrap text-fg-2">{t.service === "*" ? "通用" : t.service ?? "平台"}</Td>}
      <Td><TriggerChips triggers={t.triggers} /></Td>
      <Td className="hidden whitespace-nowrap xl:table-cell">{t.form === "builtin" ? <span className="text-[12px] text-fg-3">—</span> : <RoleChip role={t.role} />}</Td>
      <Td><Stats24h t={t} /></Td>
      <Td><LastRun t={t} /></Td>
      <Td><NextFire t={t} /></Td>
    </Tr>
  );
}

/** 子任务行：缩进在父任务下面；只显示它自己的信息，跟随父任务的列显示"同父任务" */
function SubRow({ sub, hideService, parentEnabled, onRun }: { sub: TaskSummary; hideService: boolean; parentEnabled: boolean; onRun: () => void }) {
  const ownTriggers = sub.overrides.includes("triggers");
  return (
    <Tr onClick={() => navigate(taskHref(sub.name))} className={cn("bg-sunken/25", !sub.enabled && "opacity-60")}>
      <Td className="max-w-[380px]">
        <div className="flex items-center gap-2 pl-[22px]">
          <span className="h-4 w-3 shrink-0 rounded-bl border-b border-l border-line-strong" />
          <Link to={taskHref(sub.name)} onClick={(e) => e.stopPropagation()} className="truncate font-mono text-[12.5px] font-medium text-fg hover:text-accent">{objectOf(sub.name)}</Link>
          {/* 显示名没自己写的话是父任务的，别当成这个对象的名字 */}
          {sub.overrides.includes("title") && sub.title && <span className="truncate text-[12px] text-fg-3">{sub.title}</span>}
          {!sub.enabled && <Badge tone="idle">已停用</Badge>}
          {!sub.overrides.includes("profile") && (
            <Tooltip content={sub.auto_created ? "运行时自动建的对象，还没写专属档案" : "还没写这个对象的专属档案"}>
              <Link to={`${taskHref(sub.name)}?tab=profile`} onClick={(e) => e.stopPropagation()} className="shrink-0 whitespace-nowrap text-[11.5px] text-warn hover:underline">档案待补</Link>
            </Tooltip>
          )}
          <Tooltip content={!parentEnabled ? "父任务已停用" : `运行 ${objectOf(sub.name)}`}>
            <button type="button" aria-label="运行" disabled={!sub.enabled || !parentEnabled} onClick={(e) => { e.stopPropagation(); onRun(); }}
              className="ml-auto rounded p-1 text-fg-3 hover:bg-hover hover:text-accent disabled:opacity-40"><LuPlay className="size-3.5" /></button>
          </Tooltip>
        </div>
      </Td>
      {!hideService && <Td />}
      <Td>{ownTriggers ? <TriggerChips triggers={sub.triggers} /> : <span className="whitespace-nowrap text-[12px] text-fg-3">同父任务</span>}</Td>
      <Td className="hidden xl:table-cell">{sub.overrides.includes("role") ? <RoleChip role={sub.role} /> : <span className="whitespace-nowrap text-[12px] text-fg-3">同父任务</span>}</Td>
      <Td><Stats24h t={sub} /></Td>
      <Td><LastRun t={sub} /></Td>
      <Td><NextFire t={sub} /></Td>
    </Tr>
  );
}

function NextFire({ t }: { t: TaskSummary }) {
  if (!t.next_fire) return <span className="text-fg-3">—</span>;
  return (
    <Tooltip content={datetime(t.next_fire.at, true)}>
      <span className="flex items-center gap-1.5 whitespace-nowrap text-[12.5px] text-fg-2">{until(t.next_fire.at)}<EnvBadge env={t.next_fire.env} /></span>
    </Tooltip>
  );
}

