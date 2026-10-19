/**
 * 运行详情：结论 → 步骤时间线（思考 / 工具调用+结果 / 审批 / 阶段，逐步 👍👎）
 * → 右栏上下文（输入、注入的档案、召回与沉淀、同会话运行、版本谱系）。
 * 进行中的运行 1.5 秒增量刷新；任务图运行额外给 DAG。
 */
import { useMemo, useState } from "react";
import {
  LuBan, LuBot, LuBrain, LuChevronDown, LuChevronRight, LuCircleAlert, LuCircleCheck, LuExternalLink, LuMessageSquare,
  LuRotateCcw, LuScrollText, LuShieldCheck, LuSparkles, LuThumbsDown, LuThumbsUp, LuWrench, LuZap, LuFlag,
} from "react-icons/lu";

import { api, useRun, useRunEvents } from "@/api/hooks";
import type { Run, RunEvent } from "@/api/types";
import { Page, PageHeader } from "@/components/layout/shell";
import { EnvBadge, ResolutionTag, RunStatusBadge, RunStatusDot, TriggerBadge } from "@/components/status";
import { Button, buttonVariants } from "@/components/ui/button";
import { CodeBlock, CopyButton, JsonView, Markdown } from "@/components/ui/data";
import { Tooltip, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, DescList, ErrorState, SectionTitle, Skeleton } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, clock, datetime, duration, num, shortId } from "@/lib/format";
import { invalidate } from "@/lib/query";
import { Link, navigate, useParams } from "@/lib/router";
import { GraphView } from "./graph-view";

const LIVE = new Set(["queued", "running", "awaiting_approval"]);

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: run, error, refetch } = useRun(id, true);
  const live = run ? LIVE.has(run.status) : true;
  const { data: events } = useRunEvents(id, live);

  if (error) return <Page><ErrorState error={error} onRetry={refetch} /></Page>;
  if (!run) return <Page><Skeleton className="mb-4 h-20" /><Skeleton className="h-96" /></Page>;

  return (
    <Page wide>
      <Header run={run} />
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-4">
          {run.pending_approval && <ApprovalBanner run={run} />}
          <Outcome run={run} />
          {run.context.graph && (
            <Card>
              <CardHeader title="任务图" description="节点是产物、边是依赖；复用 = 输入指纹未变直接沿用旧产物" />
              <GraphView graph={run.context.graph} />
            </Card>
          )}
          <Timeline run={run} events={events} live={live} />
        </div>
        <Sidebar run={run} />
      </div>
    </Page>
  );
}

function Header({ run }: { run: Run }) {
  const live = LIVE.has(run.status);
  const [fb, setFb] = useState(run.feedback?.score ?? 0);
  const feedback = async (score: number) => {
    const next = fb === score ? 0 : score;
    setFb(next);
    if (next) {
      await api.runFeedback(run.run_id, next);
      toast(next > 0 ? "已标记为有用" : "已标记为没帮助", { description: next < 0 ? "它沉淀的知识与案例会被降权" : "它沉淀的知识与案例会被加权" });
    }
  };
  const cancel = async () => {
    if (!(await confirm({ title: "取消这次运行？", description: "终止执行并落 cancelled 终态；挂起的审批一并拒绝。", danger: true, confirmText: "取消运行" }))) return;
    try { await api.cancelRun(run.run_id); invalidate("runs"); toast("已取消"); } catch (e) { toast.error("取消失败", (e as Error).message); }
  };
  const rerun = async () => {
    const failed = run.status === "failed";
    if (!(await confirm({ title: failed ? "断点续跑？" : "用同样的输入再跑一次？", description: failed ? "沿用同一个 run id，从失败处继续（已完成的步骤与复用的产物不重做）。" : "新开一个 run，跳过去重，沿用任务/服务/环境/会话。", confirmText: failed ? "续跑" : "重跑" }))) return;
    try {
      const r = await api.rerun(run.run_id);
      invalidate("runs");
      navigate(`/runs/${r.run_id}`);
    } catch (e) { toast.error("提交失败", (e as Error).message); }
  };
  return (
    <PageHeader
      crumbs={[{ label: "运行", to: "/runs" }, { label: <span className="font-mono">{shortId(run.run_id)}</span> }]}
      title={<span className="flex items-center gap-2.5"><RunStatusBadge status={run.status} className="h-6 px-2 text-[12.5px]" /><span className="truncate">{run.summary || run.task_title}</span></span>}
      meta={<>
        <Link to={`/tasks/${encodeURIComponent(run.task)}`} className="text-fg-2 hover:text-accent">{run.task_title || run.task}{run.task.includes(":") && <span className="font-mono text-fg-3"> :{run.task.split(":")[1]}</span>}</Link>
        {run.service ? <Link to={`/services/${run.service}?env=${run.env}`} className="text-fg-2 hover:text-accent">{run.service}</Link> : <span>平台任务</span>}
        <EnvBadge env={run.env} />
        <TriggerBadge type={run.trigger.type} source={run.trigger.source} />
        <ResolutionTag resolution={run.resolution} />
        <span title={datetime(run.created_at, true)}>{ago(run.created_at)}</span>
        <span>耗时 {live ? "进行中" : duration(run.duration_ms)}</span>
        {!!run.tokens && <span>{num(run.tokens)} tokens</span>}
        <span className="flex items-center font-mono">{run.run_id}<CopyButton text={run.run_id} /></span>
      </>}
      actions={<>
        {!live && <div className="flex items-center rounded-md border border-line bg-panel">
          <Tooltip content="有用"><button type="button" onClick={() => feedback(1)} className={cn("flex size-8 items-center justify-center rounded-l-md hover:bg-hover", fb > 0 ? "text-ok" : "text-fg-3")}><LuThumbsUp className="size-4" /></button></Tooltip>
          <span className="h-4 w-px bg-line" />
          <Tooltip content="没帮助"><button type="button" onClick={() => feedback(-1)} className={cn("flex size-8 items-center justify-center rounded-r-md hover:bg-hover", fb < 0 ? "text-bad" : "text-fg-3")}><LuThumbsDown className="size-4" /></button></Tooltip>
        </div>}
        {run.langfuse_url && <a href={run.langfuse_url} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost" })}><LuExternalLink />Langfuse</a>}
        {run.task.startsWith("data-qa") && !live && <Button icon={<LuMessageSquare />} onClick={() => navigate(`/chat/${run.session_id}`)}>在对话中继续</Button>}
        {live ? <Button variant="danger-ghost" icon={<LuBan />} onClick={cancel}>取消</Button>
          : <Button icon={<LuRotateCcw />} onClick={rerun}>{run.status === "failed" ? "续跑" : "重跑"}</Button>}
      </>}
    />
  );
}

function ApprovalBanner({ run }: { run: Run }) {
  const a = run.pending_approval!;
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (approve: boolean) => {
    setBusy(approve ? "a" : "r");
    try {
      await api.decide(a.id, approve);
      toast(approve ? "已放行" : "已拒绝");
      invalidate("runs"); invalidate("approvals");
    } catch (e) { toast.error("处理失败", (e as Error).message); } finally { setBusy(null); }
  };
  return (
    <div className="rounded-lg border border-warn/40 bg-warn-soft p-4">
      <div className="flex items-start gap-3">
        <LuShieldCheck className="mt-0.5 size-5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-fg">等待审批：{a.title}</div>
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-panel/70 p-2.5 font-mono text-[12px] text-fg">{a.detail}</pre>
          <div className="mt-2 text-xs text-fg-3">发起 {ago(a.created_at)} · {a.requested_by}{a.expires_at && ` · ${ago(a.expires_at).replace("内", "")}后超时视同拒绝`}</div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="danger-ghost" loading={busy === "r"} onClick={() => decide(false)}>拒绝</Button>
          <Button variant="primary" loading={busy === "a"} onClick={() => decide(true)}>放行</Button>
        </div>
      </div>
    </div>
  );
}

function Outcome({ run }: { run: Run }) {
  if (LIVE.has(run.status) && !run.output) {
    return (
      <Card className="flex items-center gap-3 px-4 py-4">
        <span className="relative flex size-2.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-info opacity-60" /><span className="relative inline-flex size-2.5 rounded-full bg-info" /></span>
        <span className="text-[13px] text-fg-2">{run.status === "awaiting_approval" ? "挂起中：审批通过后继续" : "执行中…步骤实时出现在下方时间线"}</span>
      </Card>
    );
  }
  if (run.output?.error) {
    return (
      <Card className="border-bad/30">
        <CardHeader icon={<LuCircleAlert className="text-bad" />} title="失败" description={run.error_code && <code className="font-mono">{run.error_code}</code>} />
        <div className="p-4"><CodeBlock code={run.output.error} wrap /></div>
      </Card>
    );
  }
  if (run.output?.answer) {
    return (
      <Card>
        <CardHeader icon={<LuCircleCheck className="text-ok" />} title="结论" actions={<CopyButton text={run.output.answer} label="复制结论" />} />
        <div className="px-5 py-4"><Markdown text={run.output.answer} /></div>
      </Card>
    );
  }
  return null;
}

// ———————— 时间线 ————————

interface Step {
  key: string;
  kind: "stage" | "thought" | "tool" | "approval" | "final" | "error" | "artifact";
  at: string;
  seq: number;
  call?: RunEvent;
  result?: RunEvent;
  ev: RunEvent;
}

function buildSteps(events: RunEvent[]): Step[] {
  const steps: Step[] = [];
  const open: Step[] = [];
  for (const ev of events) {
    if (ev.kind === "tool_call") {
      const s: Step = { key: "t" + ev.seq, kind: "tool", at: ev.at, seq: ev.seq, call: ev, ev };
      steps.push(s); open.push(s);
    } else if (ev.kind === "tool_result") {
      const i = open.findIndex((s) => s.call?.payload.tool === ev.payload.tool);
      if (i >= 0) { open[i].result = ev; open.splice(i, 1); } else steps.push({ key: "r" + ev.seq, kind: "tool", at: ev.at, seq: ev.seq, result: ev, ev });
    } else {
      steps.push({ key: ev.kind + ev.seq, kind: ev.kind === "tool_result" ? "tool" : (ev.kind as Step["kind"]), at: ev.at, seq: ev.seq, ev });
    }
  }
  return steps;
}

function Timeline({ run, events, live }: { run: Run; events: RunEvent[] | undefined; live: boolean }) {
  const steps = useMemo(() => buildSteps(events ?? []), [events]);
  const [expandAll, setExpandAll] = useState(false);
  const t0 = run.created_at ? new Date(run.created_at).getTime() : 0;
  const tools = steps.filter((s) => s.kind === "tool").length;
  return (
    <Card>
      <CardHeader title="执行过程" description={events ? `${steps.length} 步 · ${tools} 次工具调用${live ? " · 实时" : ""}` : "加载中"}
        actions={<Button size="xs" variant="ghost" onClick={() => setExpandAll((v) => !v)}>{expandAll ? "全部收起" : "全部展开"}</Button>} />
      {!events ? <div className="p-4"><Skeleton className="h-40" /></div> : (
        <ol className="relative px-4 py-3">
          {steps.map((s, i) => <StepRow key={s.key} step={s} runId={run.run_id} offset={new Date(s.at).getTime() - t0} last={i === steps.length - 1 && !live} expandAll={expandAll} />)}
          {live && (
            <li className="flex items-center gap-3 py-2 pl-[3px]">
              <span className="relative flex size-[18px] items-center justify-center"><span className="absolute size-2.5 animate-ping rounded-full bg-info/50" /><span className="size-2 rounded-full bg-info" /></span>
              <span className="text-[12.5px] text-fg-3">等待下一步…</span>
            </li>
          )}
        </ol>
      )}
    </Card>
  );
}

const STEP_ICON: Record<Step["kind"], { icon: React.ReactNode; cls: string }> = {
  stage: { icon: <LuFlag />, cls: "bg-sunken text-fg-3" },
  thought: { icon: <LuSparkles />, cls: "bg-accent-soft text-accent" },
  tool: { icon: <LuWrench />, cls: "bg-info-soft text-info" },
  approval: { icon: <LuShieldCheck />, cls: "bg-warn-soft text-warn" },
  final: { icon: <LuCircleCheck />, cls: "bg-ok-soft text-ok" },
  error: { icon: <LuCircleAlert />, cls: "bg-bad-soft text-bad" },
  artifact: { icon: <LuZap />, cls: "bg-accent-soft text-accent" },
};

function StepRow({ step, runId, offset, last, expandAll }: { step: Step; runId: string; offset: number; last: boolean; expandAll: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (expandAll || step.kind === "thought" || step.kind === "error" || step.kind === "approval");
  const [fb, setFb] = useState<number>(step.ev.feedback ?? 0);
  const p = step.ev.payload;
  const meta = STEP_ICON[step.kind];
  const sendFb = async (score: number) => {
    const next = fb === score ? 0 : score;
    setFb(next);
    if (next) await api.stepFeedback(runId, step.seq, next);
  };
  const title = step.kind === "tool"
    ? <span className="flex items-center gap-2"><code className="font-mono text-[12.5px] font-medium text-fg">{step.call?.payload.tool ?? step.result?.payload.tool}</code><span className="truncate text-fg-3">{summarizeArgs(step.call?.payload.args)}</span></span>
    : step.kind === "thought" ? "思考" : step.kind === "final" ? "结论" : step.kind === "error" ? "出错" : step.kind === "approval" ? (p.title ?? "审批") : (p.title ?? p.stage);
  const right = step.kind === "tool" && step.result?.payload.duration_ms !== undefined ? duration(step.result.payload.duration_ms as number) : p.tokens ? `${num(p.tokens as number)} tok` : null;
  const collapsible = step.kind !== "stage";
  return (
    <li className="group relative flex gap-3 pb-1">
      {!last && <span className="absolute left-[11px] top-7 bottom-0 w-px bg-line" />}
      <span className={cn("relative z-10 mt-1 flex size-[22px] shrink-0 items-center justify-center rounded-full [&_svg]:size-3", meta.cls)}>{meta.icon}</span>
      <div className="min-w-0 flex-1 pb-2">
        <div className={cn("flex min-h-7 items-center gap-2 rounded-md px-1.5 text-[13px]", collapsible && "cursor-pointer hover:bg-hover/60")} onClick={() => collapsible && setOpen(!expanded)}>
          {collapsible && <span className="text-fg-3">{expanded ? <LuChevronDown className="size-3.5" /> : <LuChevronRight className="size-3.5" />}</span>}
          <span className={cn("min-w-0 flex-1 truncate", step.kind === "stage" ? "text-fg-2" : "font-medium text-fg")}>{title}</span>
          {step.kind === "stage" && p.content && <span className="truncate text-[12px] text-fg-3">{String(p.content)}</span>}
          {right && <span className="shrink-0 text-[11.5px] tabular-nums text-fg-3">{right}</span>}
          <span className="w-14 shrink-0 text-right font-mono text-[11px] text-fg-3" title={clock(step.at)}>+{duration(Math.max(0, offset))}</span>
          {(step.kind === "tool" || step.kind === "thought" || step.kind === "final") && (
            <span className={cn("flex shrink-0 items-center gap-0.5", !fb && "opacity-0 group-hover:opacity-100")} onClick={(e) => e.stopPropagation()}>
              <button type="button" onClick={() => sendFb(1)} className={cn("rounded p-1 hover:bg-hover", fb > 0 ? "text-ok" : "text-fg-3")}><LuThumbsUp className="size-3" /></button>
              <button type="button" onClick={() => sendFb(-1)} className={cn("rounded p-1 hover:bg-hover", fb < 0 ? "text-bad" : "text-fg-3")}><LuThumbsDown className="size-3" /></button>
            </span>
          )}
        </div>
        {expanded && collapsible && (
          <div className="mt-1.5 space-y-2 pl-6">
            {step.kind === "thought" && <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-fg-2">{String(p.content)}</div>}
            {step.kind === "final" && <Markdown text={String(p.content)} className="text-[13px]" />}
            {step.kind === "error" && <CodeBlock code={String(p.content)} wrap />}
            {step.kind === "approval" && <CodeBlock code={String(p.content)} wrap />}
            {step.kind === "tool" && <>
              {step.call && <ToolArgs args={step.call.payload.args} />}
              {step.result ? <CodeBlock title="输出" code={String(step.result.payload.output ?? "")} maxHeight={260} /> : <div className="text-xs text-fg-3">等待返回…</div>}
            </>}
          </div>
        )}
      </div>
    </li>
  );
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return args ? String(args) : "";
  const a = args as Record<string, unknown>;
  const v = a.command ?? a.sql ?? a.what ?? Object.values(a)[0];
  return v ? String(v).replace(/\s+/g, " ").slice(0, 90) : "";
}

function ToolArgs({ args }: { args: unknown }) {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const main = a.command ?? a.sql ?? a.code;
    if (typeof main === "string") return <CodeBlock title={a.command ? "命令" : a.sql ? "SQL" : "代码"} code={main} maxHeight={220} />;
  }
  return <JsonView value={args} maxHeight={200} />;
}

// ———————— 右栏 ————————

function Sidebar({ run }: { run: Run }) {
  const c = run.context;
  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader title="输入" />
        <div className="p-3"><JsonView value={run.input} maxHeight={260} /></div>
      </Card>
      <Card>
        <CardHeader title="执行谱系" description="run 钉死了当时生效的定义版本" />
        <div className="p-4">
          <DescList items={[
            ["任务", <Link to={`/tasks/${encodeURIComponent(run.task)}?tab=versions`} className="hover:text-accent">{run.task} <span className="text-fg-3">v{run.task_version ?? "—"}</span></Link>],
            ["角色", run.role ? <Link to={`/settings/roles/${run.role}`} className="flex items-center gap-1 hover:text-accent"><LuBot className="size-3.5 text-fg-3" />{run.role} <span className="text-fg-3">v{run.role_version ?? "—"}</span></Link> : "—"],
            ["触发", <span>{run.trigger.type}{run.trigger.id ? ` #${run.trigger.id}` : ""} · {run.trigger.caller}</span>],
            ["会话", run.session_id === run.run_id ? <span className="text-fg-3">独立运行</span> : <Link to={`/runs?session=${encodeURIComponent(run.session_id)}`} className="break-all font-mono text-[11.5px] hover:text-accent">{run.session_id}</Link>],
            ["开始", datetime(run.created_at, true)],
            ["结束", run.finished_at ? datetime(run.finished_at, true) : "—"],
          ]} />
        </div>
      </Card>
      {c.profile && (
        <Card>
          <CardHeader title="注入的档案" icon={<LuScrollText />} description="原文（服务档案 + 任务档案），置顶于提示词" />
          <div className="p-3"><CodeBlock code={c.profile} wrap maxHeight={300} /></div>
        </Card>
      )}
      <Card>
        <CardHeader title="记忆" icon={<LuBrain />} description="本次召回了什么、沉淀了什么" />
        <div className="space-y-4 p-4">
          <MemList title="召回的知识" empty="无" items={c.recalled_knowledge.map((k) => ({ key: String(k.id), label: k.key, hint: `#${k.rank}`, href: `/memory?tab=knowledge&id=${k.id}` }))} />
          <MemList title="召回的方法" empty="无" items={c.recalled_assets.map((a) => ({ key: String(a.id), label: `${a.kind}:${a.name}`, href: `/memory?tab=assets&id=${a.id}` }))} />
          <MemList title="本次沉淀" empty={run.status === "success" ? "没有可沉淀的结论" : "运行结束后沉淀"} items={[
            ...c.saved_knowledge.map((k) => ({ key: "k" + k.id, label: k.key, hint: "知识", href: `/memory?tab=knowledge&id=${k.id}` })),
            ...c.saved_assets.map((a) => ({ key: "a" + a.id, label: `${a.kind}:${a.name}`, hint: "方法", href: `/memory?tab=assets&id=${a.id}` })),
          ]} />
        </div>
      </Card>
      {c.session_runs.length > 0 && (
        <Card>
          <CardHeader title="同会话的其他运行" description="故障周期 / 对话链" />
          <ul className="divide-y divide-line">
            {c.session_runs.map((r) => (
              <li key={r.run_id}>
                <Link to={`/runs/${r.run_id}`} className="flex items-center gap-2 px-4 py-2 text-[12.5px] hover:bg-hover/70">
                  <RunStatusDot status={r.status} />
                  <span className="font-mono text-fg-2">{shortId(r.run_id)}</span>
                  <span className="truncate text-fg-3">{r.task}</span>
                  <span className="ml-auto shrink-0 text-fg-3">{ago(r.created_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function MemList({ title, items, empty }: { title: string; items: { key: string; label: string; hint?: string; href: string }[]; empty: string }) {
  return (
    <div>
      <SectionTitle>{title}</SectionTitle>
      {items.length === 0 ? <div className="text-[12.5px] text-fg-3">{empty}</div> : (
        <ul className="space-y-1">
          {items.map((i) => (
            <li key={i.key}><Link to={i.href} className="flex items-center gap-2 rounded px-1 py-0.5 text-[12.5px] hover:bg-hover"><span className="truncate font-mono text-fg-2">{i.label}</span>{i.hint && <Badge className="ml-auto">{i.hint}</Badge>}</Link></li>
          ))}
        </ul>
      )}
    </div>
  );
}
