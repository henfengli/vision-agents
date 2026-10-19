/**
 * 任务列表：按服务分组；每行一眼看到 触发方式、角色、近 24h 成功率、下一次定时。
 */
import { useEffect, useMemo, useState } from "react";
import { LuGitBranch, LuListTodo, LuPlay, LuPlus, LuTerminal, LuWorkflow } from "react-icons/lu";

import { api, useRoles, useServices, useTasks } from "@/api/hooks";
import type { Task, TaskSummary, Trigger } from "@/api/types";
import { RatioBar } from "@/components/charts";
import { Page, PageHeader } from "@/components/layout/shell";
import { RoleChip, RunStatusDot, TRIGGER } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Table, Td, Th, Tr } from "@/components/ui/data";
import { Field, FilterSelect, Input, SearchInput, Select, Textarea } from "@/components/ui/form";
import { Dialog, Tooltip, toast } from "@/components/ui/overlay";
import { Badge, Card, Empty, SkeletonRows } from "@/components/ui/primitives";
import { describeCron } from "@/lib/cron";
import { cn } from "@/lib/cn";
import { ago, pct, until } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { Link, navigate, useSearch } from "@/lib/router";
import { RunTaskDialog } from "./run-dialog";

export function TasksPage() {
  const [search, setSearch] = useSearch<{ service: string; trigger: string; q: string; run: string }>();
  const { data: tasks, loading } = useTasks();
  const { data: services } = useServices();
  const [creating, setCreating] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  useEffect(() => { if (search.run) { setRunOpen(true); setSearch({ run: undefined }); } }, [search.run, setSearch]);

  const filtered = useMemo(() => (tasks ?? []).filter((t) => !t.extends
    && (!search.service || t.service === search.service || (search.service === "_generic" && t.service === "*") || (search.service === "_platform" && !t.service))
    && (!search.trigger || t.triggers.some((tr) => tr.type === search.trigger))
    && (!search.q || (t.name + t.title + t.description).toLowerCase().includes(search.q.toLowerCase()))), [tasks, search]);

  const groups = useMemo(() => {
    const order = [...(services ?? []).map((s) => s.name), "*", ""];
    const map = new Map<string, TaskSummary[]>();
    for (const t of filtered) map.set(t.service ?? "", [...(map.get(t.service ?? "") ?? []), t]);
    return order.filter((k) => map.has(k)).map((k) => ({ key: k, title: k === "*" ? "通用任务" : k === "" ? "平台任务" : services?.find((s) => s.name === k)?.title ?? k, hint: k === "*" ? "调用时指定服务" : k === "" ? "不涉及业务服务" : k, tasks: map.get(k)! }));
  }, [filtered, services]);

  return (
    <Page wide>
      <PageHeader title="任务" description="要做的事：目标 + 形态 + 输入 + 触发 + 输出。触发全部声明在任务上——API、对话、定时（按环境）、事件。"
        actions={<>
          <Button icon={<LuPlus />} onClick={() => setCreating(true)}>新建任务</Button>
          <Button variant="primary" icon={<LuPlay />} onClick={() => setRunOpen(true)}>运行任务</Button>
        </>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={search.q ?? ""} onChange={(v) => setSearch({ q: v })} placeholder="搜索任务…" className="w-60" />
        <FilterSelect label="服务" allLabel="全部" value={search.service ?? ""} onChange={(v) => setSearch({ service: v })}
          options={[...(services ?? []).map((s) => ({ value: s.name, label: s.title })), { value: "_generic", label: "通用任务" }, { value: "_platform", label: "平台任务" }]} />
        <FilterSelect label="触发" allLabel="全部" value={search.trigger ?? ""} onChange={(v) => setSearch({ trigger: v })}
          options={["api", "chat", "schedule", "event"].map((t) => ({ value: t, label: TRIGGER[t].label, icon: <span className="text-fg-3 [&_svg]:size-3.5">{TRIGGER[t].icon}</span> }))} />
        <span className="ml-auto text-xs text-fg-3">{tasks ? `${filtered.length} 个任务` : ""}</span>
      </div>
      <Card>
        {loading ? <SkeletonRows rows={8} /> : groups.length === 0 ? (
          <Empty icon={<LuListTodo />} title="没有匹配的任务" action={<Button icon={<LuPlus />} onClick={() => setCreating(true)}>新建任务</Button>} />
        ) : (
          <TasksTable grouped={groups} all={tasks} />
        )}
      </Card>
      <CreateTaskDialog open={creating} onClose={() => setCreating(false)} />
      <RunTaskDialog open={runOpen} onClose={() => setRunOpen(false)} />
    </Page>
  );
}


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

export function TasksTable({ tasks, grouped, all, hideService }: {
  tasks?: TaskSummary[]; grouped?: { key: string; title: string; hint: string; tasks: TaskSummary[] }[]; all?: TaskSummary[]; hideService?: boolean;
}) {
  const groups = grouped ?? [{ key: "_", title: "", hint: "", tasks: tasks ?? [] }];
  if (!grouped && !tasks?.length) return <Empty icon={<LuListTodo />} title="没有任务" />;
  return (
    <Table>
      <thead>
        <tr>
          <Th>任务</Th>
          {!hideService && !grouped && <Th>服务</Th>}
          <Th>触发</Th>
          <Th>角色</Th>
          <Th className="w-[150px]">近 24 小时</Th>
          <Th>最近</Th>
          <Th>下次定时</Th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <GroupRows key={g.key} group={g} all={all} showGroup={!!grouped} hideService={hideService || !!grouped} />
        ))}
      </tbody>
    </Table>
  );
}

function GroupRows({ group, all, showGroup, hideService }: { group: { key: string; title: string; hint: string; tasks: TaskSummary[] }; all?: TaskSummary[]; showGroup: boolean; hideService: boolean }) {
  return (
    <>
      {showGroup && (
        <tr>
          <td colSpan={6} className="border-b border-line bg-sunken/50 px-4 py-1.5">
            <span className="text-[12px] font-semibold text-fg-2">{group.title}</span>
            <span className="ml-2 font-mono text-[11px] text-fg-3">{group.hint}</span>
            <span className="ml-2 text-[11px] text-fg-3">{group.tasks.length}</span>
          </td>
        </tr>
      )}
      {group.tasks.map((t) => {
        const subs = (all ?? []).filter((x) => x.extends === t.name);
        const s = t.stats_24h;
        return (
          <Tr key={t.name} onClick={() => navigate(`/tasks/${encodeURIComponent(t.name)}`)} className={cn(!t.enabled && "opacity-60")}>
            <Td className="max-w-[360px]">
              <div className="flex items-center gap-2">
                <Link to={`/tasks/${encodeURIComponent(t.name)}`} onClick={(e) => e.stopPropagation()} className="truncate font-medium text-fg hover:text-accent">{t.title || t.name}</Link>
                {t.form !== "agent" && <Badge tone="accent" icon={FORM_META[t.form].icon}>{FORM_META[t.form].label}</Badge>}
                {!t.enabled && <Badge tone="idle">已停用</Badge>}
              </div>
              <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-fg-3">
                {t.name}
                {subs.length > 0 && <span className="flex items-center gap-0.5 font-sans"><LuGitBranch className="size-3" />{subs.length} 子任务{subs.some((x) => !Object.keys(x.context).length) && " · 有档案待补"}</span>}
              </div>
            </Td>
            {!hideService && <Td className="text-fg-2">{t.service === "*" ? "通用" : t.service ?? "平台"}</Td>}
            <Td><TriggerChips triggers={t.triggers} /></Td>
            <Td><RoleChip role={t.role} /></Td>
            <Td>
              {s.runs ? (
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11.5px]">
                    <span className="tabular-nums text-fg">{s.runs} 次</span>
                    <span className={cn("tabular-nums", s.failed ? "text-bad" : "text-ok")}>{pct(s.success, s.success + s.failed)}</span>
                  </div>
                  <RatioBar ok={s.success} bad={s.failed} total={s.runs} />
                </div>
              ) : <span className="text-[12px] text-fg-3">—</span>}
            </Td>
            <Td>{t.last_run ? <span className="flex items-center gap-1.5 text-[12.5px] text-fg-3"><RunStatusDot status={t.last_run.status} />{ago(t.last_run.created_at)}</span> : <span className="text-fg-3">—</span>}</Td>
            <Td className="text-[12.5px]">{t.next_fire ? <span className="text-fg-2">{until(t.next_fire.at)} <span className="font-mono text-[11px] uppercase text-fg-3">{t.next_fire.env}</span></span> : <span className="text-fg-3">—</span>}</Td>
          </Tr>
        );
      })}
    </>
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
      await api.createTask({ name, title, description, service: service === "_platform" ? null : service, role: role || null, form, triggers: [{ id: "api", type: "api" }] });
      invalidate("tasks");
      toast("任务已创建", { description: "接着配置输入、触发与输出" });
      onClose();
      navigate(`/tasks/${name}?tab=definition`);
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
