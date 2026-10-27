/**
 * 运行详情：主视图是步骤时间线——模型调用（带思考过程的可展开；旧运行是"思考"）/ 工具调用（参数 + 结果）/ 最终答案，逐步 👍👎；
 * 子代理里发生的步骤带子代理标签；查库（db_query，旧运行 sql_query）的查询与结果单独排版。
 * 右栏是上下文（输入、配方、执行信息、注入的档案、召回与沉淀、反馈、同会话运行）。
 * 进行中的运行 1.5 秒增量刷新；被 👎 过的 agent 运行可以用当前定义重放（回归）。
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";
import {
  LuArrowDown, LuBan, LuBot, LuBrain, LuChevronDown, LuChevronRight, LuCircleAlert, LuCircleCheck, LuFlag, LuFlaskConical,
  LuMessageSquare, LuMessageSquareWarning, LuPencilLine, LuPlay, LuRotateCcw, LuScrollText, LuSparkles, LuWrench,
} from "react-icons/lu";

import { ApiError } from "@/api/client";
import { api, useMeta, useRun, useRunEvents, useTasks } from "@/api/hooks";
import type { KnowledgeKind, RecipeRef, Run, RunEvent } from "@/api/types";
import { FeedbackButtons, FeedbackItem } from "@/components/feedback";
import { Page, PageHeader } from "@/components/layout/shell";
import { EnvBadge, ResolutionTag, RunStatusBadge, RunStatusDot, TRIGGER, TriggerBadge } from "@/components/status";
import { ToolArgs, ToolOutput, summarizeArgs } from "@/components/tool-call";
import { Button, LinkButton } from "@/components/ui/button";
import { CodeBlock, CopyButton, JsonView, Markdown } from "@/components/ui/data";
import { Field, Textarea } from "@/components/ui/form";
import { Dialog, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, DescList, Empty, ErrorState, Kbd, SectionTitle, Skeleton } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, clock, datetime, duration, num, shortId } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { Link, navigate, useParams } from "@/lib/router";
import { KindBadge } from "../memory/memory";
import { StartReplayDialog } from "./replays";

const LIVE = new Set(["queued", "running"]);
/** 思考过程不长的默认展开；长的收着，只露前两行 */
const SHORT_THOUGHT = 240;

/** 当前用户对整次（step=0）或某一步的评价 */
function useMine(run: Run) {
  const { data: meta } = useMeta();
  return (step: number) => run.feedback.find((f) => f.step_seq === step && f.created_by === meta?.me.name) ?? null;
}

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: run, error, refetch } = useRun(id, true);
  const live = run ? LIVE.has(run.status) : true;
  const { data: events } = useRunEvents(id, live);

  if (error) return <Page>{error instanceof ApiError && error.status === 404
    ? <Empty title="运行不存在" description="链接可能已失效" action={<LinkButton to="/runs">回到运行列表</LinkButton>} />
    : <ErrorState error={error} onRetry={refetch} />}</Page>;
  if (!run) return <Page><Skeleton className="mb-4 h-20" /><Skeleton className="h-96" /></Page>;

  return (
    <Page wide>
      <Header run={run} />
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-4">
          <Timeline run={run} events={events} live={live} />
        </div>
        <Sidebar run={run} />
      </div>
    </Page>
  );
}

function Header({ run }: { run: Run }) {
  const live = LIVE.has(run.status);
  const mine = useMine(run)(0);
  /** 👎 面板里勾了"按意见重答"：直接提交纠正，跳到新一轮 */
  const correctWith = async (text: string) => {
    try {
      const r = await api.correct(run.run_id, text);
      invalidate("runs");
      navigate(`/runs/${r.run_id}`);
    } catch (e) { toast.error("纠正失败", (e as Error).message); }
  };
  const [busy, setBusy] = useState<"cancel" | "again" | null>(null);
  const cancel = async () => {
    if (!(await confirm({ title: "取消这次运行？", description: "终止执行，运行落 cancelled 终态；已经做完的步骤保留在时间线里。", danger: true, confirmText: "取消运行", cancelText: "不取消" }))) return;
    setBusy("cancel");
    try { await api.cancelRun(run.run_id); invalidate("runs"); toast("已取消"); } catch (e) { toast.error("取消失败", (e as Error).message); } finally { setBusy(null); }
  };
  const [correcting, setCorrecting] = useState(false);
  const [replaying, setReplaying] = useState(false);
  /** 内建任务（失败时 resolution 还是空，看任务定义）：后端不支持续跑，纠正也没有意义 */
  const { data: tasks } = useTasks();
  const builtin = run.resolution === "builtin" || tasks?.find((t) => t.name === run.task.split(":")[0])?.form === "builtin";
  /** 回归重放：任何结束了的 agent 运行（规则命中、内建、本身就是重放出来的除外） */
  const replayable = !live && !builtin && run.resolution !== "rule" && !run.replay_of;
  const disliked = run.feedback.some((f) => f.score < 0);
  const failed = run.status === "failed" && !builtin;
  /** 失败的续跑（同一个 run 从断点继续）；其余重跑（新 run、新会话，跳过去重） */
  const again = async () => {
    const ok = await confirm(failed
      ? { title: "断点续跑？", description: "沿用同一个运行 id、同一个会话，从失败处继续：已完成的步骤不重做。", confirmText: "续跑" }
      : { title: "用同样的输入再跑一次？", description: "新开一次运行（新会话），跳过去重，沿用任务 / 服务 / 环境 / 输入。", confirmText: "重跑" });
    if (!ok) return;
    setBusy("again");
    try {
      const r = failed ? await api.resume(run.run_id) : await api.rerun(run.run_id);
      invalidate("runs");
      toast(failed ? "已从断点续跑" : "已重新提交", { description: shortId(r.run_id) });
      navigate(`/runs/${r.run_id}`);
    } catch (e) { toast.error("提交失败", (e as Error).message); } finally { setBusy(null); }
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
        {run.replay_of && (
          <span className="flex items-center gap-1 text-fg-2"><LuFlaskConical className="size-3.5 text-fg-3" />回归重放自
            <Link to={`/runs/${run.replay_of}`} className="font-mono text-accent hover:underline">{shortId(run.replay_of)}</Link>
          </span>
        )}
        <span title={datetime(run.created_at, true)}>{ago(run.created_at)}</span>
        <span>耗时 {live ? "进行中" : duration(run.duration_ms)}</span>
        {!!run.tokens && <span>{num(run.tokens)} tokens</span>}
        <span className="flex items-center font-mono">{run.run_id}<CopyButton text={run.run_id} /></span>
      </>}
      actions={<>
        {!live && (
          <FeedbackButtons key={mine?.updated_at ?? "none"} runId={run.run_id} mine={mine} onCorrect={builtin ? undefined : correctWith}
            onSaved={() => invalidate("runs")} className="h-8 rounded-md border border-line bg-panel px-0.5" />
        )}
        {run.trigger.type === "chat" && !live && <Button icon={<LuMessageSquare />} onClick={() => navigate(`/chat/${run.session_id}`)}>在对话中继续</Button>}
        {!live && !builtin && <Button icon={<LuPencilLine />} onClick={() => setCorrecting(true)}>纠正</Button>}
        {replayable && <Button icon={<LuFlaskConical />} onClick={() => setReplaying(true)}
          title={disliked ? "改完提示词 / 任务定义 / 档案 / 记忆后，用现在的一切重跑这条，看 👎 指出的问题改好没有"
            : "改完提示词 / 任务定义 / 档案 / 记忆后，用现在的一切重跑这条，把这次的答案当参照看有没有退步"}>重放</Button>}
        {live ? <Button variant="danger-ghost" icon={<LuBan />} loading={busy === "cancel"} onClick={cancel}>取消</Button>
          : <Button icon={failed ? <LuPlay /> : <LuRotateCcw />} loading={busy === "again"} onClick={again}>{failed ? "续跑" : "重跑"}</Button>}
        <CorrectDialog run={run} open={correcting} onClose={() => setCorrecting(false)} />
        {replayable && <StartReplayDialog open={replaying} onClose={() => setReplaying(false)} preset={{ run_ids: [run.run_id] }} />}
      </>}
    />
  );
}

/** 纠正：告诉 agent 哪里错了，在同一会话里带着原结论与纠正重答；纠正内容会记成高优先级的人工记忆 */
function CorrectDialog({ run, open, onClose }: { run: Run; open: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const submit = useMutation(async () => {
    try {
      const r = await api.correct(run.run_id, text.trim());
      invalidate("runs");
      onClose();
      setText("");
      toast("已提交纠正", { description: "在同一会话里开了新一轮" });
      navigate(`/runs/${r.run_id}`);
    } catch (e) { toast.error("提交失败", (e as Error).message); }
  });
  const go = () => { if (text.trim() && !submit.pending) void submit.mutate(undefined); };
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="纠正这次结论" description="在同一会话里新开一次运行：agent 看到原结论和你的纠正后重答。纠正本身会记成人工记忆。"
      footer={<>
        <span className="mr-auto hidden items-center gap-1 text-[11.5px] text-fg-3 sm:flex"><Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> 提交</span>
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={!text.trim()} loading={submit.pending} onClick={go}>提交纠正</Button>
      </>}>
      {run.output?.answer && <div className="mb-3 max-h-40 overflow-auto rounded-md border border-line bg-sunken/50 p-3 text-[12.5px] text-fg-2"><Markdown text={run.output.answer} /></div>}
      <Field label="哪里不对" required help="说清楚正确的口径或事实，例如：账户收益按交易日统计，不按自然日；数据在 ClickHouse 的 dws_account_pnl_daily">
        <Textarea autoFocus rows={4} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } }} />
      </Field>
    </Dialog>
  );
}

// ———————— 时间线（主视图） ————————

/** 一步：工具调用与它的结果合成一步（参数 + 结果），其余事件各占一步；model = model_call，thought 只在旧运行里有 */
interface Step {
  key: string;
  kind: "stage" | "model" | "thought" | "tool" | "final" | "error";
  at: string;
  seq: number;                 // 0 = 由运行输出补出来的一步（事件里没有），不能单独评价
  call?: RunEvent;
  result?: RunEvent;
  ev: RunEvent;
}

function buildSteps(run: Run, events: RunEvent[]): Step[] {
  const steps: Step[] = [];
  const open: Step[] = [];
  for (const ev of events) {
    if (ev.kind === "tool_call") {
      const s: Step = { key: "t" + ev.seq, kind: "tool", at: ev.at, seq: ev.seq, call: ev, ev };
      steps.push(s); open.push(s);
    } else if (ev.kind === "tool_result") {
      const i = open.findIndex((s) => s.call?.payload.tool === ev.payload.tool && s.call?.payload.agent === ev.payload.agent);
      if (i >= 0) { open[i].result = ev; open.splice(i, 1); } else steps.push({ key: "r" + ev.seq, kind: "tool", at: ev.at, seq: ev.seq, result: ev, ev });
    } else if (ev.kind === "model_call") {
      steps.push({ key: "m" + ev.seq, kind: "model", at: ev.at, seq: ev.seq, ev });
    } else {
      steps.push({ key: ev.kind + ev.seq, kind: ev.kind, at: ev.at, seq: ev.seq, ev });
    }
  }
  // 运行已结束但事件里没有最终答案 / 出错（比如出错在执行之前）：用运行输出补上，时间线总以结果收尾
  if (!LIVE.has(run.status)) {
    const at = run.finished_at ?? events[events.length - 1]?.at ?? run.created_at;
    const synth = (kind: "final" | "error", content: string): Step =>
      ({ key: kind + "-out", kind, at, seq: 0, ev: { seq: 0, kind, at, payload: { content } } });
    if (run.output?.error && !steps.some((s) => s.kind === "error")) steps.push(synth("error", run.output.error));
    else if (run.output?.answer && !steps.some((s) => s.kind === "final")) steps.push(synth("final", run.output.answer));
  }
  return steps;
}

function Timeline({ run, events, live }: { run: Run; events: RunEvent[] | undefined; live: boolean }) {
  const steps = useMemo(() => buildSteps(run, events ?? []), [run, events]);
  const [expandAll, setExpandAll] = useState(false);
  const t0 = run.created_at ? new Date(run.created_at).getTime() : 0;
  const tools = steps.filter((s) => s.kind === "tool").length;
  const models = steps.filter((s) => s.kind === "model").length;
  const thoughts = steps.filter((s) => s.kind === "thought").length;
  const final = steps.find((s) => s.kind === "final" || s.kind === "error");
  /** 旧运行只有 thought：照旧数思考 */
  const counted = thoughts && !models ? `${thoughts} 次思考` : `${models} 次模型调用`;
  return (
    <Card>
      <CardHeader title="执行过程" icon={<LuSparkles />}
        description={events ? `${counted} · ${tools} 次工具调用${live ? " · 实时" : ""}` : "加载中"}
        actions={<>
          {final && steps.length > 6 && (
            <Button size="xs" variant="ghost" icon={<LuArrowDown />} onClick={() => document.getElementById("step-final")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              {final.kind === "final" ? "最终答案" : "出错处"}
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => setExpandAll((v) => !v)}>{expandAll ? "全部收起" : "全部展开"}</Button>
        </>} />
      {!events ? <div className="p-4"><Skeleton className="h-40" /></div> : (
        <ol className="relative px-4 py-3">
          {steps.length === 0 && !live && <li className="py-6 text-center text-[12.5px] text-fg-3">这次运行没有记录步骤</li>}
          {steps.map((s, i) => (
            <StepRow key={s.key} step={s} run={run} offset={new Date(s.at).getTime() - t0} last={i === steps.length - 1 && !live} expandAll={expandAll} />
          ))}
          {live && (
            <li className="flex items-center gap-3 py-2 pl-[3px]">
              <span className="relative flex size-[18px] items-center justify-center"><span className="absolute size-2.5 animate-ping rounded-full bg-info/50" /><span className="size-2 rounded-full bg-info" /></span>
              <span className="text-[12.5px] text-fg-3">{run.status === "queued" ? "排队中…" : "执行中…下一步会实时出现在这里"}</span>
            </li>
          )}
        </ol>
      )}
    </Card>
  );
}

/** 内容长的阶段：折叠，展开看全文（系统提示） */
const BLOCK_STAGES = new Set(["system"]);

/** 同机部署带来的几种原因码：在出错的那一步下面说一句该去哪儿处理 */
const ERROR_HINT: Record<string, { text: string; to?: (run: Run) => string; link?: string }> = {
  wrong_env: { text: "运行落到了不负责这个环境的主机上：哪台主机执行哪个环境（和哪些服务），由那台主机上 agent 服务的部署配置（env / services）决定" },
  config_missing: { text: "受保护的环境要填给 agent 的只读版配置：还没填，或配置路径在部署主机上不存在", to: (r) => `/services/${r.service}?tab=config&env=${r.env}`, link: "去填配置" },
};

const STEP_META: Record<Step["kind"], { icon: React.ReactNode; cls: string; label: string }> = {
  stage: { icon: <LuFlag />, cls: "bg-sunken text-fg-3", label: "阶段" },
  model: { icon: <LuSparkles />, cls: "bg-accent-soft text-accent", label: "模型调用" },
  thought: { icon: <LuSparkles />, cls: "bg-accent-soft text-accent", label: "思考" },
  tool: { icon: <LuWrench />, cls: "bg-info-soft text-info", label: "工具调用" },
  final: { icon: <LuCircleCheck />, cls: "bg-ok-soft text-ok", label: "最终答案" },
  error: { icon: <LuCircleAlert />, cls: "bg-bad-soft text-bad", label: "出错" },
};

function StepRow({ step, run, offset, last, expandAll }: { step: Step; run: Run; offset: number; last: boolean; expandAll: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const p = step.ev.payload;
  /** 模型调用：带思考过程的能展开（短的默认展开）；平台辅助调用（记忆沉淀…）用用途当标题 */
  const thinking = step.kind === "thought" || (step.kind === "model" && !!p.content);
  const thoughtText = thinking ? String(p.content) : "";
  const block = step.kind === "stage" && BLOCK_STAGES.has(String(p.stage));
  const expanded = open ?? (expandAll || (thinking && thoughtText.length <= SHORT_THOUGHT) || step.kind === "error" || step.kind === "final");
  const mine = useMine(run)(step.seq);
  const others = step.seq ? run.feedback.filter((f) => f.step_seq === step.seq && f.score < 0) : [];
  const rateable = step.seq > 0 && (step.kind === "tool" || step.kind === "model" || step.kind === "thought" || step.kind === "final");
  const meta = STEP_META[step.kind];
  const tool = step.call?.payload.tool ?? step.result?.payload.tool;
  const agent = step.kind === "tool" ? (step.call ?? step.result)?.payload.agent : p.agent;
  const title = step.kind === "tool"
    ? <span className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-fg-3">{step.call ? "工具调用" : "工具结果"}</span><code className="shrink-0 font-mono text-[12.5px] font-medium text-fg">{tool}</code><span className="truncate font-normal text-fg-3" title={summarizeArgs(step.call?.payload.args, tool)}>{summarizeArgs(step.call?.payload.args, tool)}</span></span>
    : step.kind === "model" ? (p.purpose || (p.content ? "思考" : meta.label))
        : step.kind === "stage" ? (p.title ?? p.stage)
          : step.kind === "error" && run.error_code ? <span className="flex items-center gap-2">{meta.label}<code className="font-mono text-[11.5px] font-normal text-bad">{run.error_code}</code></span>
            : meta.label;
  const right = step.kind === "tool" && step.result?.payload.duration_ms !== undefined ? duration(step.result.payload.duration_ms as number)
    : step.kind === "tool" && !step.result && LIVE.has(run.status) ? "进行中"
      : step.kind === "model" ? (p.ms != null ? duration(p.ms) : null)
        : step.kind === "stage" && p.duration_ms != null ? duration(p.duration_ms)
          : p.tokens ? `${num(p.tokens)} tok` : null;
  const collapsible = step.kind === "stage" ? block : step.kind === "model" ? thinking : true;
  const outcome = step.kind === "final" || step.kind === "error";
  const data = step.kind === "final" ? p.data ?? run.output?.data : undefined;
  return (
    <li id={outcome ? "step-final" : undefined} className="group relative flex scroll-mt-4 gap-3 pb-1">
      {!last && <span className="absolute left-[11px] top-7 bottom-0 w-px bg-line" />}
      <span className={cn("relative z-10 mt-1 flex size-[22px] shrink-0 items-center justify-center rounded-full [&_svg]:size-3", meta.cls)}>{meta.icon}</span>
      <div className="min-w-0 flex-1 pb-2">
        <div className={cn("flex min-h-7 items-center gap-2 rounded-md px-1.5 text-[13px]", collapsible && "cursor-pointer hover:bg-hover/60")} onClick={() => collapsible && setOpen(!expanded)}>
          {collapsible && <span className="text-fg-3">{expanded ? <LuChevronDown className="size-3.5" /> : <LuChevronRight className="size-3.5" />}</span>}
          {agent && <Badge tone="info" icon={<LuBot />} title={`子代理 ${agent} 里的这一步`}>{agent}</Badge>}
          <span className={cn("min-w-0 flex-1 truncate", step.kind === "stage" ? "text-fg-2" : "font-medium text-fg")}
            title={typeof title === "string" ? title : undefined}>{title}</span>
          {step.kind === "stage" && !block && p.content && <span className="min-w-0 max-w-[45%] truncate text-[12px] text-fg-3" title={String(p.content)}>{String(p.content)}</span>}
          {right && <span className="shrink-0 text-[11.5px] tabular-nums text-fg-3">{right}</span>}
          {step.kind === "final" && <span className="shrink-0" onClick={(e) => e.stopPropagation()}><CopyButton text={String(p.content ?? "")} label="复制" /></span>}
          <span className="w-14 shrink-0 text-right font-mono text-[11px] text-fg-3" title={clock(step.at)}>+{duration(Math.max(0, offset))}</span>
          {rateable && (
            <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
              <FeedbackButtons key={mine?.updated_at ?? "none"} runId={run.run_id} step={step.seq} mine={mine} size="sm"
                onSaved={() => invalidate("runs")} className={cn("shrink-0", !mine && "opacity-0 group-hover:opacity-100 focus-within:opacity-100")} />
            </span>
          )}
        </div>
        {step.kind === "model" && <ModelMeta p={p} className={collapsible ? "pl-[30px]" : "pl-1.5"} />}
        {thinking && !expanded && (
          <button type="button" onClick={() => setOpen(true)} className="mt-0.5 block w-full pl-[30px] text-left">
            <span className="line-clamp-2 whitespace-pre-wrap text-[12px] leading-relaxed text-fg-3 hover:text-fg-2">{thoughtText}</span>
          </button>
        )}
        {others.length > 0 && (
          <div className="ml-6 mt-1 space-y-2 rounded-md border border-bad/20 bg-bad-soft/40 px-2.5 py-2">
            {others.map((f) => <FeedbackItem key={f.id} entry={f} showStep={false} />)}
          </div>
        )}
        {expanded && collapsible && (
          <div className="mt-1.5 space-y-2 pl-6">
            {thinking && <div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-fg-2">{thoughtText}</div>}
            {block && <CodeBlock code={String(p.content ?? "")} wrap maxHeight={420} />}
            {step.kind === "final" && (run.resolution === "builtin" && String(p.content ?? "").startsWith("{")
              ? <CodeBlock code={String(p.content)} maxHeight={420} />
              : <div className="rounded-md border border-ok/25 bg-ok-soft/20 px-4 py-3"><Markdown text={String(p.content)} className="text-[13px]" /></div>
            )}
            {data && <CodeBlock title="结构化结果" code={JSON.stringify(data, null, 2)} maxHeight={320} />}
            {step.kind === "error" && <CodeBlock code={String(p.content)} wrap />}
            {step.kind === "error" && run.error_code && ERROR_HINT[run.error_code] && (
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-3">
                <LuCircleAlert className="size-3.5 shrink-0 text-bad" />{ERROR_HINT[run.error_code].text}
                {run.service && ERROR_HINT[run.error_code].to && (
                  <Link to={ERROR_HINT[run.error_code].to!(run)} className="text-accent hover:underline">{ERROR_HINT[run.error_code].link}</Link>
                )}
              </div>
            )}
            {step.kind === "tool" && <>
              {step.call && <ToolArgs tool={tool} args={step.call.payload.args} />}
              {step.result ? <ToolOutput tool={tool} output={String(step.result.payload.output ?? "")} />
                : <div className="text-xs text-fg-3">{LIVE.has(run.status) ? "等待返回…" : "没有返回（运行在这一步之前结束了）"}</div>}
            </>}
          </div>
        )}
      </div>
    </li>
  );
}

/** 模型调用的一行小字：模型 · 排队 · 输入→输出 token · 调了哪些工具 */
function ModelMeta({ p, className }: { p: RunEvent["payload"]; className?: string }) {
  const calls = p.tool_calls ?? [];
  const items: ReactNode[] = [];
  if (p.model) items.push(<span className="font-mono">{p.model}</span>);
  if (p.queued_ms) items.push(<span title="耗时里这部分是在平台侧排队等账号的并发名额（同时在途的请求数，生产和测试共用），模型本身没在算">排队 {duration(p.queued_ms)}</span>);
  if (p.input_tokens != null || p.output_tokens != null) items.push(<span>{num(p.input_tokens)} → {num(p.output_tokens)} tokens</span>);
  else if (p.tokens) items.push(<span>{num(p.tokens)} tokens</span>);
  if (calls.length) items.push(<span>调用 {calls.map((c, i) => <Fragment key={i}>{i > 0 && "、"}<code className="font-mono text-fg-2">{c}</code></Fragment>)}</span>);
  if (!items.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-1.5 text-[11.5px] tabular-nums text-fg-3", className)}>
      {items.map((x, i) => <Fragment key={i}>{i > 0 && <span>·</span>}{x}</Fragment>)}
    </div>
  );
}

// ———————— 右栏 ————————

function Sidebar({ run }: { run: Run }) {
  const c = run.context;
  /* 宽屏时侧栏贴顶、自己滚：时间线短的时候左边不会空一大截，时间线长的时候侧栏一直看得见 */
  return (
    <div className="min-w-0 space-y-4 xl:sticky xl:top-0 xl:max-h-[calc(100dvh-48px-3.5rem)] xl:self-start xl:overflow-y-auto xl:pr-0.5">
      <Card>
        <CardHeader title="输入" />
        <div className="p-3"><JsonView value={run.input} maxHeight={260} /></div>
      </Card>
      <RecipeCard run={run} />
      <Card>
        <CardHeader title="执行信息" />
        <div className="p-4">
          <DescList items={[
            ["触发", run.replay_of
              ? <span>回归重放 · 原运行 <Link to={`/runs/${run.replay_of}`} className="font-mono text-[12px] text-accent hover:underline">{shortId(run.replay_of)}</Link></span>
              : <span>{TRIGGER[run.trigger.type]?.label ?? run.trigger.type}{run.trigger.source ? ` · ${run.trigger.source}` : ""}{run.trigger.id ? <code className="ml-1 font-mono text-[11.5px] text-fg-3">#{run.trigger.id}</code> : ""}</span>],
            ["发起方", <Link to={`/runs?caller=${encodeURIComponent(run.trigger.caller)}`} className="font-mono text-[12px] hover:text-accent">{run.trigger.caller}</Link>],
            ["会话", run.session_id === run.run_id ? <span className="text-fg-3">独立运行</span> : <Link to={`/runs?session_id=${encodeURIComponent(run.session_id)}`} className="break-all font-mono text-[11.5px] hover:text-accent">{run.session_id}</Link>],
            ["记忆", <span>召回{onOff(run.memory?.recall)} · 沉淀{onOff(run.memory?.save)}</span>],
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
          <MemList title="召回的记忆" empty="无" items={c.recalled_knowledge.map((k) => ({ key: String(k.id), label: memLabel(k.key), kind: k.kind, hint: `#${k.rank}`, href: `/memory?id=${k.id}` }))} />
          <MemList title="召回的方法" empty="无" items={c.recalled_assets.map((a) => ({ key: String(a.id), label: `${a.kind}:${a.name}`, href: `/memory?tab=assets&id=${a.id}` }))} />
          <MemList title="本次沉淀" empty={run.trigger.type === "replay" ? "回归重放不沉淀记忆" : run.status === "success" ? "没有可沉淀的结论" : LIVE.has(run.status) ? "运行成功结束后沉淀" : "只有成功的运行才沉淀"} items={[
            ...c.saved_knowledge.map((k) => ({ key: "k" + k.id, label: memLabel(k.key), kind: k.kind, href: `/memory?id=${k.id}` })),
            ...c.saved_assets.map((a) => ({ key: "a" + a.id, label: `${a.kind}:${a.name}`, hint: "方法", href: `/memory?tab=assets&id=${a.id}` })),
          ]} />
        </div>
      </Card>
      {run.feedback.length > 0 && (
        <Card>
          <CardHeader title="反馈" icon={<LuMessageSquareWarning />} description="整次运行与各步收到的评价；👎 同时推送到通知规则里的渠道" />
          <ul className="divide-y divide-line">
            {run.feedback.map((f) => <li key={f.id} className="px-4 py-2.5"><FeedbackItem entry={f} /></li>)}
          </ul>
        </Card>
      )}
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

/** 配方：这次运行用到的每样定义各是第几版；旧运行没有配方，只有任务与角色版本 */
function RecipeCard({ run }: { run: Run }) {
  const r = run.recipe;
  const v = (n: number | null | undefined) => <span className="text-fg-3">v{n ?? "—"}</span>;
  const task = (name: string, n: number | null | undefined) =>
    <Link to={`/tasks/${encodeURIComponent(name)}?tab=versions`} className="hover:text-accent">{name} {v(n)}</Link>;
  const role = (name: string, n: number | null | undefined) =>
    <Link to={`/settings/roles/${name}?tab=versions`} className="hover:text-accent">{name} {v(n)}</Link>;
  /** 继承链：根在前，自己在后 */
  const chain = (refs: RecipeRef[]) => (
    <span className="flex flex-wrap items-center gap-x-1">
      {refs.map((x, i) => <Fragment key={x.name}>{i > 0 && <span className="text-fg-3">→</span>}{role(x.name, x.version)}</Fragment>)}
    </span>
  );
  const items: [ReactNode, ReactNode][] = [];
  if (!r) {
    items.push(["任务", task(run.task, run.task_version)], ["角色", run.role ? role(run.role, run.role_version) : "—"]);
  } else {
    items.push(["任务", task(r.task.name, r.task.version)]);
    if (r.task.parent) items.push(["父任务", task(r.task.parent.name, r.task.parent.version)]);
    items.push(["角色", r.role ? chain(r.role.lineage) : "—"]);
    if (r.subagents?.length) items.push(["子代理", <div className="space-y-0.5">{r.subagents.map((s) => <div key={s.name}>{chain(s.lineage)}</div>)}</div>]);
    if (r.service) items.push(["服务", <Link to={`/services/${r.service.name}?tab=versions`} className="hover:text-accent">{r.service.name} {v(r.service.version)}</Link>]);
    if (r.prompts) items.push(["平台提示词", <Link to="/settings/prompts" className="hover:text-accent">v{r.prompts}</Link>]);
    items.push(["模型", <span className="font-mono text-[12px]">{r.model}</span>], ["平台", <span className="font-mono text-[12px]">v{r.platform}</span>]);
  }
  return (
    <Card>
      <CardHeader title="配方" description={r ? "这次运行用到的每样定义各是第几版" : "旧运行没有记配方，只有任务与角色的版本"} />
      <div className="p-4"><DescList items={items} /></div>
    </Card>
  );
}

const onOff = (v: boolean | null | undefined) => (v === false ? "关" : v === true ? "开" : "默认");

/** 教训的键是 lesson:<指纹>，只显示指纹前 8 位 */
const memLabel = (key: string) => key.replace(/^lesson:([0-9a-f]{8})[0-9a-f]*$/, "lesson:$1");

/** kind：记忆条目的类型（事实 / 教训），用小标签区分 */
function MemList({ title, items, empty }: { title: string; items: { key: string; label: string; kind?: KnowledgeKind; hint?: string; href: string }[]; empty: string }) {
  return (
    <div>
      <SectionTitle>{title}</SectionTitle>
      {items.length === 0 ? <div className="text-[12.5px] text-fg-3">{empty}</div> : (
        <ul className="space-y-1">
          {items.map((i) => (
            <li key={i.key}>
              <Link to={i.href} className="flex items-center gap-2 rounded px-1 py-0.5 text-[12.5px] hover:bg-hover">
                {i.kind && <KindBadge kind={i.kind} className="shrink-0" />}
                <span className="truncate font-mono text-fg-2">{i.label}</span>
                {i.hint && <Badge className="ml-auto">{i.hint}</Badge>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
