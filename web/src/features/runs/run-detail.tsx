/**
 * 运行详情：主视图是步骤时间线——模型调用（带思考过程的可展开；旧运行是"思考"）/ 工具调用（参数 + 结果）/ 最终答案，逐步 👍👎；
 * 子代理里发生的步骤带子代理标签；查库（db_query，旧运行 sql_query）的查询与结果单独排版。
 * 右栏是上下文（输入、配方、执行信息、注入的档案、召回与沉淀、反馈、同会话运行）。
 * 进行中的运行 1.5 秒增量刷新；被 👎 过的 agent 运行可以用当前定义重放（回归）。
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LuArrowDown, LuBan, LuBot, LuBrain, LuChevronDown, LuChevronRight, LuCircleAlert, LuCircleCheck, LuCopy, LuEllipsis, LuFlag, LuFlaskConical,
  LuHourglass, LuListTodo, LuMessageSquare, LuMessageSquareWarning, LuPencilLine, LuPlay, LuRefreshCw, LuRotateCcw, LuScrollText, LuServerOff,
  LuSparkles, LuWorkflow, LuWrench,
} from "react-icons/lu";

import { api, useMeta, useRun, useRunEvents, useServices, useTasks } from "@/api/hooks";
import type { KnowledgeKind, RecipeRef, Run, RunBrief, RunEvent } from "@/api/types";
import { FeedbackButtons, FeedbackItem } from "@/components/feedback";
import { Page, PageHeader } from "@/components/layout/shell";
import { IdCopy } from "@/components/meta";
import { DetailError } from "@/components/states";
import { EnvBadge, KindBadge, ResolutionTag, RunStatusBadge, RunStatusDot, TRIGGER, TriggerBadge } from "@/components/status";
import { TimeAgo, TimeUntil } from "@/components/time";
import { TodoList, ToolArgs, ToolOutput, summarizeArgs, todoItems } from "@/components/tool-call";
import { Button, LinkButton } from "@/components/ui/button";
import { CodeBlock, CopyButton, JsonView, Markdown } from "@/components/ui/data";
import { Field, Textarea } from "@/components/ui/form";
import { Dialog, Menu, Tooltip, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, DescList, Kbd, SectionTitle, Skeleton } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, clock, datetime, duration, num, shortId } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { Link, navigate, useParams } from "@/lib/router";
import { RunTaskDialog } from "../tasks/run-dialog";
import { StartReplayDialog } from "./replays";

const LIVE = new Set(["queued", "running"]);
/** 思考过程不长的默认展开；长的收着，只露前两行 */
const SHORT_THOUGHT = 240;

/** 当前用户对整次（step=0）或某一步的评价 */
function useMine(run: Run) {
  const { data: meta } = useMeta();
  return (step: number) => run.feedback.find((f) => f.step_seq === step && f.created_by === meta?.me.name) ?? null;
}

/** 结束之后再跟这么久：记忆沉淀、结果推送、回归判定这几条是运行落终态之后才写的 */
const AFTER_FINISH_MS = 25_000;

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [poll, setPoll] = useState(true);
  const { data: run, error, refetch } = useRun(id, poll);
  const live = run ? LIVE.has(run.status) : true;
  useEffect(() => {
    if (!run) return;
    if (LIVE.has(run.status)) { setPoll(true); return; }
    const left = AFTER_FINISH_MS - (Date.now() - new Date(run.finished_at ?? 0).getTime());
    if (left <= 0) { setPoll(false); return; }
    setPoll(true);
    const t = window.setTimeout(() => setPoll(false), left);
    return () => window.clearTimeout(t);
  }, [run?.status, run?.finished_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: events } = useRunEvents(id, poll);

  if (error && !run) return (
    <Page>
      <PageHeader crumbs={[{ label: "运行", to: "/runs" }, { label: <span className="font-mono">{shortId(id)}</span> }]} title="运行" />
      <DetailError error={error} onRetry={refetch} what="运行" back={{ to: "/runs", label: "回到运行列表" }} />
    </Page>
  );
  if (!run) return <Page><Skeleton className="mb-4 h-20" /><Skeleton className="h-96" /></Page>;

  return (
    <Page wide>
      <Header run={run} events={events} />
      <StateBanner run={run} />
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-4">
          <Timeline run={run} events={events} live={live} />
        </div>
        <Sidebar run={run} />
      </div>
    </Page>
  );
}

/** 运行中：耗时每秒跳一次 */
function Elapsed({ since }: { since: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 1000); return () => window.clearInterval(t); }, []);
  return <>{duration(Math.max(0, Date.now() - new Date(since).getTime()))}</>;
}

function Header({ run, events }: { run: Run; events: RunEvent[] | undefined }) {
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
    const queued = run.status === "queued";
    if (!(await confirm({ title: "取消这次运行？", danger: true, confirmText: "取消运行", cancelText: "不取消",
      description: queued ? "它还在排队，取消后不会再执行；点名等它的运行也跟着不执行。"
        : "终止执行，运行落 cancelled 终态；已经做完的步骤保留在时间线里。点名等它的运行跟着不执行。" }))) return;
    setBusy("cancel");
    try { await api.cancelRun(run.run_id); invalidate("runs"); toast("已取消"); } catch (e) { toast.error("取消失败", (e as Error).message); } finally { setBusy(null); }
  };
  const [correcting, setCorrecting] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [chaining, setChaining] = useState(false);
  const { data: tasks } = useTasks();
  const { data: services } = useServices();
  const def = tasks?.find((t) => t.name === run.task);
  const baseDef = tasks?.find((t) => t.name === run.task.split(":")[0]);
  /** 内建任务（失败时 resolution 还是空，看任务定义）：不能续跑，纠正也没有意义 */
  const builtin = run.resolution === "builtin" || baseDef?.form === "builtin";
  const rule = run.resolution === "rule";
  const replay = run.trigger.type === "replay" || !!run.replay_of;
  /** 现在还能不能在这个任务 / 服务 / 环境上再跑：能的话按钮可点，不能的话说明原因（后端同样会拒） */
  const svcHealth = run.service ? services?.find((s) => s.name === run.service)?.health[run.env] : undefined;
  const blocked = !tasks ? "加载中" : !def ? "任务已删除" : !def.enabled ? "任务已停用" : baseDef && !baseDef.enabled ? "父任务已停用"
    : svcHealth && !svcHealth.enabled ? `${run.service} 在 ${run.env} 已停用` : def.envs.length && !def.envs.includes(run.env) ? `任务不再允许在 ${run.env} 跑` : null;
  /** 回归重放：结束了的 agent 运行（规则命中、内建、本身就是重放出来的除外） */
  const replayable = !live && !builtin && !rule && !replay;
  const disliked = run.feedback.some((f) => f.score < 0);
  /** 失败的 agent 运行续跑（同一个 run 接着走）；走到 agent 之前就失败的（配置没填、服务停用…）从头执行。
   *  它等的上游失败了的（upstream_failed）从没执行过，没有断点：只能重跑 */
  const resumable = run.status === "failed" && !builtin && !rule && run.error_code !== "upstream_failed";
  const reached = (events ?? []).some((e) => e.kind === "model_call" || e.kind === "thought" || (e.kind === "stage" && e.payload.stage === "system"));
  const resume = async () => {
    const ok = await confirm(reached
      ? { title: "续跑？", description: `同一个运行、同一个会话，从断点继续：已经完成的步骤不重做。${run.retry_at ? "等着的自动重试会改成现在就跑。" : ""}想用同样的输入从头另开一次，用「⋯ → 重跑」。`, confirmText: "续跑" }
      : { title: "续跑？", description: "上次在准备阶段就失败了（还没走到 agent），没有断点：这次从头执行，还是同一个运行。", confirmText: "续跑" });
    if (!ok) return;
    setBusy("again");
    try {
      const r = await api.resume(run.run_id);
      invalidate("runs");
      toast(reached ? "已续跑" : "已从头执行", { description: shortId(r.run_id) });
    } catch (e) { toast.error("没能续跑", (e as Error).message); } finally { setBusy(null); }
  };
  const rerun = async () => {
    const ok = await confirm(rule
      ? { title: "交给 agent 分析一遍？", description: "这次是规则直接给的结论。重跑会用同样的输入新开一次运行，这回交给 agent 分析（不再走规则）。", confirmText: "重跑" }
      : { title: "重跑？", description: `新开一次运行（新会话），沿用任务、服务、环境和输入；不走去重。${run.retry_at ? "这次等着的自动重试会取消（不然同一份输入跑两遍），这次运行就此算失败。" : resumable ? "想从这次的断点接着走，用「续跑」。" : ""}`, confirmText: "重跑" });
    if (!ok) return;
    setBusy("again");
    try {
      const r = await api.rerun(run.run_id);
      invalidate("runs");
      toast("已重跑", { description: shortId(r.run_id) });
      navigate(`/runs/${r.run_id}`);
    } catch (e) { toast.error("没能重跑", (e as Error).message); } finally { setBusy(null); }
  };
  /** 纠正：结论不对时在同一会话里重答（和对话页一致，只对成功的运行） */
  const correctable = run.status === "success" && !builtin && !replay;
  /** 能在对话页接着问：这是对话的一轮（或对话里的纠正），且任务现在还开着对话触发（不然下一条消息会被拒） */
  const chatOpen = !!def?.triggers.some((t) => t.type === "chat" && t.enabled !== false);
  const chatTurn = run.trigger.type === "chat" || (run.trigger.type === "correction" && run.session_id !== run.run_id);

  // 操作栏固定成 [👍👎] [纠正] [重放] [取消运行 / 续跑 / 重跑] [⋯]：现在用不了的留在原位、变灰，悬停说原因（不随状态出现消失）
  const correctReason = live ? "运行结束后才能纠正" : builtin ? "内建任务不过模型，没有结论可纠正" : replay ? "回归重放出来的运行不纠正：改完定义再重放一次"
    : run.status !== "success" ? "只有成功的运行能纠正：失败的用续跑或重跑" : blocked;
  const replayReason = live ? "运行结束后才能重放" : builtin ? "内建任务不过模型，没有答案可对比" : rule ? "规则直接给的结论，不过模型：用重跑交给 agent"
    : replay ? "这本身就是回归重放出来的运行" : blocked;
  const rerunReason = replay ? "回归重放出来的运行不重跑：到回归重放里重判，或再发起一轮" : blocked;
  const lifecycle = live
    ? <Button variant="danger-ghost" icon={<LuBan />} loading={busy === "cancel"} onClick={cancel}>取消运行</Button>
    : resumable
      ? <Button icon={<LuPlay />} loading={busy === "again"} reason={blocked ?? undefined} onClick={resume}
        tip={reached ? "从断点接着跑（同一个运行）" : "上次没走到 agent：从头执行（同一个运行）"}>续跑</Button>
      : <Button icon={<LuRotateCcw />} loading={busy === "again"} reason={rerunReason ?? undefined} onClick={rerun} tip="用同样的输入新开一次运行">重跑</Button>;
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
        {run.attempt > 1 && <Tooltip content="续跑 / 自动重试都在同一个运行上接着跑"><span>第 {run.attempt} 次执行</span></Tooltip>}
        <TimeAgo at={run.created_at} />
        {/* 排队时长从这一次进队列算（续跑、自动重试会重新进），不从建运行时算 */}
        <span>{live ? <>{run.status === "queued" ? "已排队" : "已运行"} <Elapsed since={run.status === "queued" ? run.queue?.since ?? run.created_at : run.created_at} /></> : <>耗时 {duration(run.duration_ms)}</>}</span>
        {!!run.tokens && <span>{num(run.tokens)} tokens</span>}
        <IdCopy value={run.run_id} />
      </>}
      actions={<>
        <FeedbackButtons key={mine?.updated_at ?? "none"} runId={run.run_id} mine={mine} onCorrect={correctable && !blocked ? correctWith : undefined}
          reason={live ? "运行结束后才能评价" : undefined}
          onSaved={() => invalidate("runs")} className="h-8 rounded-md border border-line bg-panel px-0.5" />
        <Button icon={<LuPencilLine />} reason={correctReason ?? undefined} tip="结论不对：告诉 agent 哪里错了，在同一会话里重答" onClick={() => setCorrecting(true)}>纠正</Button>
        <Button icon={<LuFlaskConical />} reason={replayReason ?? undefined} onClick={() => setReplaying(true)}
          tip={disliked ? "改完提示词、定义、档案或记忆后，用现在的一切重跑这条，看 👎 指出的问题改好没有"
            : "改完提示词、定义、档案或记忆后，用现在的一切重跑这条，和这次的答案对比有没有退步"}>重放</Button>
        {lifecycle}
        <Menu trigger={<Button size="icon" aria-label="更多操作"><LuEllipsis /></Button>} items={[
          { label: "在对话中继续", icon: <LuMessageSquare />, disabled: !chatTurn || !chatOpen || live,
            hint: !chatTurn ? "不是对话里的一轮" : !chatOpen ? "任务没开对话" : live ? "等这一轮结束" : undefined,
            onClick: () => navigate(`/chat/${run.session_id}`) },
          ...(resumable || live ? [{ label: "重跑（新开一次）", icon: <LuRotateCcw />, disabled: !!rerunReason, hint: rerunReason ? "现在不能" : undefined, onClick: () => void rerun() }] : []),
          { label: "等它成功后跑一个任务…", icon: <LuWorkflow />, disabled: !live && !run.retry_at, hint: !live && !run.retry_at ? "它已经结束了" : undefined, onClick: () => setChaining(true) },
          { separator: true, label: "" },
          { label: "复制运行 ID", icon: <LuCopy />, onClick: () => { void navigator.clipboard?.writeText(run.run_id); toast("已复制运行 ID", { description: run.run_id }); } },
        ]} />
        <CorrectDialog run={run} open={correcting} onClose={() => setCorrecting(false)} />
        {replayable && <StartReplayDialog open={replaying} onClose={() => setReplaying(false)} preset={{ run_ids: [run.run_id] }} />}
        <RunTaskDialog open={chaining} onClose={() => setChaining(false)} after={[run.run_id]} service={run.service ?? undefined} />
      </>}
    />
  );
}

/**
 * 运行状态的说明条：排着队的说清在等什么（点名的上游 / 任务并发 / 没有主机负责 / 只是在排队），
 * 失败后等着自动重试的说清什么时候重试、可以现在续跑或取消重试。
 */
function StateBanner({ run }: { run: Run }) {
  const [busy, setBusy] = useState(false);
  if (run.status === "failed" && run.retry_at) {
    const cancelRetry = async () => {
      if (!(await confirm({ title: "取消自动重试？", description: "这次运行就此算失败：照常发失败通知、触发「失败后」的联动，点名等它的运行也不再执行。", confirmText: "取消自动重试", cancelText: "不取消", danger: true }))) return;
      setBusy(true);
      try { await api.cancelRun(run.run_id); invalidate("runs"); toast("已取消自动重试"); } catch (e) { toast.error("取消失败", (e as Error).message); } finally { setBusy(false); }
    };
    return (
      <Banner tone="info" icon={<LuRefreshCw />}
        actions={<Button size="sm" variant="ghost" loading={busy} onClick={() => void cancelRetry()}>取消自动重试</Button>}>
        第 {run.attempt} 次执行失败（临时性的错误），<TimeUntil at={run.retry_at} className="font-medium" /> 自动续跑。现在就想跑，点右上角「续跑」。
      </Banner>
    );
  }
  const q = run.queue;
  if (run.status !== "queued" || !q) return null;
  const titles = Object.fromEntries((run.lineage?.depends_on ?? []).map((b) => [b.run_id, b.task_title || b.task]));
  if (q.waiting_for.length) return (
    <Banner tone="idle" icon={<LuHourglass />}>
      在等它点名的 {q.waiting_for.length} 个上游运行成功：
      {q.waiting_for.map((w) => (
        <Link key={w.run_id} to={`/runs/${w.run_id}`} className="mx-1 inline-flex items-center gap-1 text-accent hover:underline">
          <RunStatusDot status={w.status} />{titles[w.run_id] || w.task} <span className="font-mono">{shortId(w.run_id)}</span>
        </Link>
      ))}
      。有一个失败或被取消，这次就不执行（upstream_failed）。
    </Banner>
  );
  if (q.concurrency && q.concurrency.running >= q.concurrency.limit) return (
    <Banner tone="idle" icon={<LuHourglass />}>
      任务在每个环境最多同时跑 {q.concurrency.limit} 个，现在 {run.env} 有 {q.concurrency.running} 个在跑：前面的结束了就轮到它。
    </Banner>
  );
  if (!q.hosts.length) return (
    <Banner tone="bad" icon={<LuServerOff />} actions={<LinkButton size="sm" variant="ghost" to="/">去概览看执行主机</LinkButton>}>
      没有在线的主机负责 {run.service ?? "平台任务"} 在 {run.env} 的运行：它会一直排着。检查负责这个环境的那台主机上的 agent 服务是不是停了。
    </Banner>
  );
  const full = q.hosts.every((h) => h.running >= h.max_concurrent);
  return (
    <Banner tone="idle" icon={<LuHourglass />}>
      {full ? `负责它的主机执行名额都满了（${q.hosts.map((h) => `${h.host} ${h.running}/${h.max_concurrent}`).join("、")}），空出来就开始。`
        : "马上就会被主机认领。"}
      <span className="text-fg-3">认领顺序：对话 &gt; API &gt; 定时、事件、联动，同一档按提交先后。</span>
    </Banner>
  );
}

function Banner({ tone, icon, children, actions }: { tone: "info" | "idle" | "bad"; icon: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className={cn("mb-4 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[12.5px] leading-relaxed",
      { info: "border-info/30 bg-info-soft text-fg", idle: "border-line bg-sunken/60 text-fg-2", bad: "border-bad/30 bg-bad-soft text-fg" }[tone])}>
      <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", { info: "text-info", idle: "text-fg-3", bad: "text-bad" }[tone])}>{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {actions && <div className="-my-1 shrink-0">{actions}</div>}
    </div>
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
      // 有 call 的按它配对（并发调同一个工具时只看工具名会配错）；旧事件没有，按工具名 + 子代理配第一个没配上的
      const i = ev.payload.call
        ? open.findIndex((s) => s.call?.payload.call === ev.payload.call)
        : open.findIndex((s) => s.call?.payload.tool === ev.payload.tool && s.call?.payload.agent === ev.payload.agent);
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
  /** 跳转的目标是最后一个结果（续跑过的运行前面还有一次出错） */
  const final = [...steps].reverse().find((s) => s.kind === "final" || s.kind === "error");
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
            <StepRow key={s.key} step={s} run={run} offset={new Date(s.at).getTime() - t0} last={i === steps.length - 1 && !live} expandAll={expandAll} anchor={s === final} />
          ))}
          {live && (
            <li className="flex items-center gap-3 py-2 pl-[3px]">
              <span className="relative flex size-[18px] items-center justify-center"><span className="absolute size-2.5 animate-ping rounded-full bg-info/50" /><span className="size-2 rounded-full bg-info" /></span>
              <span className="text-[12.5px] text-fg-3">{run.status === "queued" ? "排队中…" : "执行中…下一步会实时出现在这里"}</span>
            </li>
          )}
          {live && <LiveProgress progress={run.progress} />}
        </ol>
      )}
    </Card>
  );
}

/** 跑得久的 bash / py：每几秒一条输出尾部（runs.progress），工具结束就消失 */
function LiveProgress({ progress }: { progress: Run["progress"] }) {
  const items = Object.entries(progress ?? {}).sort(([, a], [, b]) => b.ms - a.ms);
  if (!items.length) return null;
  return (
    <li className="ml-[30px] space-y-2 pb-2">
      {items.map(([key, p]) => (
        <div key={key} className="overflow-hidden rounded-md border border-info/30 bg-info-soft/20">
          <div className="flex items-center gap-2 border-b border-info/20 px-3 py-1.5 text-[12px]">
            <Badge tone="info" icon={<LuWrench />}>{p.tool}</Badge>
            <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-2" title={p.title}>{p.title}</code>
            <span className="shrink-0 tabular-nums text-fg-3">已跑 {duration(p.ms)}</span>
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg-2">{p.output || "（还没有输出）"}</pre>
        </div>
      ))}
    </li>
  );
}

/** 内容长的阶段：折叠，展开看全文（系统提示） */
const BLOCK_STAGES = new Set(["system"]);

/** 失败原因码：在出错的那一步下面说一句是怎么回事、该去哪儿处理 */
const ERROR_HINT: Record<string, { text: string; to?: (run: Run) => string; link?: string }> = {
  wrong_env: { text: "运行落到了不负责这个环境的主机上：哪台主机执行哪个环境（和哪些服务），由那台主机上 agent 服务的部署配置（env / services）决定" },
  config_missing: { text: "受保护的环境要填给 agent 的只读版配置：还没填，或配置路径在部署主机上不存在", to: (r) => `/services/${r.service}?tab=config&env=${r.env}`, link: "去填配置" },
  orphaned: { text: "执行它的 agent 服务中途退出了（重启、崩溃或被杀）。点「续跑」接着走；任务配了自动重试的会自己续跑" },
  interrupted: { text: "执行它的 agent 服务在跑的时候退出了（一般是重启或升级）。点「续跑」接着走；任务配了自动重试的会自己续跑" },
  upstream_failed: { text: "它点名等的上游运行失败或被取消了，这次没有执行（也就没有断点可续）。上游重新跑成功后，用「重跑」再提交一次" },
  timeout: { text: "超过了任务的超时。续跑大概率还会超时：先把任务的超时调大，或把问题拆小", to: (r) => `/tasks/${encodeURIComponent(r.task.split(":")[0])}?tab=definition`, link: "改任务的超时" },
  step_limit: { text: "agent 走了太多步还没结束，多半在原地打转：看最后几步在做什么，改提示词或把问题拆小；续跑会从断点接着走" },
  invalid_output: { text: "任务要求按结构化输出交回结果，agent 没交或交的不合格（提醒过一次）。纠正、或者改任务的输出 schema / 角色提示词", to: (r) => `/tasks/${encodeURIComponent(r.task.split(":")[0])}?tab=definition`, link: "看任务定义" },
  invalid_definition: { text: "任务定义有问题（比如内建处理器不存在）", to: (r) => `/tasks/${encodeURIComponent(r.task.split(":")[0])}?tab=definition`, link: "看任务定义" },
  unknown_task: { text: "排队期间任务被删掉了，这个运行没法再跑" },
  unknown_service: { text: "服务已经不存在了" },
  service_disabled: { text: "排队期间服务被停用了", to: (r) => `/services/${r.service}`, link: "去服务页" },
  service_env_disabled: { text: "排队期间服务在这个环境被停用了", to: (r) => `/services/${r.service}?tab=envs`, link: "去启用" },
  task_disabled: { text: "排队期间任务被停用了", to: (r) => `/tasks/${encodeURIComponent(r.task.split(":")[0])}`, link: "去任务页" },
  env_not_allowed: { text: "任务现在不允许在这个环境跑", to: (r) => `/tasks/${encodeURIComponent(r.task.split(":")[0])}?tab=definition`, link: "看任务定义" },
  error: { text: "执行中抛了异常（模型接口、工具或框架）。看上面的报错：临时性的（比如 429、网络）可以直接续跑；也可以给任务配上失败自动重试", to: (r) => `/tasks/${encodeURIComponent(r.task.split(":")[0])}?tab=definition`, link: "看任务定义" },
};

const STEP_META: Record<Step["kind"], { icon: React.ReactNode; cls: string; label: string }> = {
  stage: { icon: <LuFlag />, cls: "bg-sunken text-fg-3", label: "阶段" },
  model: { icon: <LuSparkles />, cls: "bg-accent-soft text-accent", label: "模型调用" },
  thought: { icon: <LuSparkles />, cls: "bg-accent-soft text-accent", label: "思考" },
  tool: { icon: <LuWrench />, cls: "bg-info-soft text-info", label: "工具调用" },
  final: { icon: <LuCircleCheck />, cls: "bg-ok-soft text-ok", label: "最终答案" },
  error: { icon: <LuCircleAlert />, cls: "bg-bad-soft text-bad", label: "出错" },
};
const CANCELLED_META = { icon: <LuBan />, cls: "bg-sunken text-fg-3", label: "已取消" };

function StepRow({ step, run, offset, last, expandAll, anchor }: { step: Step; run: Run; offset: number; last: boolean; expandAll: boolean; anchor: boolean }) {
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
  /** 出错那一步的原因码看事件自己的（续跑过的运行，前面那次和最后的不一样）；人取消的不当错误显示 */
  const code = step.kind === "error" ? String(p.title ?? (step.seq ? "" : run.error_code ?? "")) : "";
  const cancelled = step.kind === "error" && code === "cancelled";
  const meta = cancelled ? CANCELLED_META : STEP_META[step.kind];
  const tool = step.call?.payload.tool ?? step.result?.payload.tool;
  const agent = step.kind === "tool" ? (step.call ?? step.result)?.payload.agent : p.agent;
  const title = step.kind === "tool"
    ? <span className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-fg-3">{step.call ? "工具调用" : "工具结果"}</span><code className="shrink-0 font-mono text-[12.5px] font-medium text-fg">{tool}</code><span className="truncate font-normal text-fg-3" title={summarizeArgs(step.call?.payload.args, tool)}>{summarizeArgs(step.call?.payload.args, tool)}</span></span>
    : step.kind === "model" ? (p.purpose || (p.content ? "思考" : meta.label))
        : step.kind === "stage" ? (p.title ?? p.stage)
          : cancelled ? <span className="text-fg-2">{meta.label}<span className="ml-2 font-normal text-fg-3">{String(p.content ?? "")}</span></span>
            : step.kind === "error" && code ? <span className="flex items-center gap-2">{meta.label}<code className="font-mono text-[11.5px] font-normal text-bad">{code}</code></span>
              : meta.label;
  const right = step.kind === "tool" && step.result?.payload.duration_ms !== undefined ? duration(step.result.payload.duration_ms as number)
    : step.kind === "tool" && !step.result && LIVE.has(run.status) ? "进行中"
      : step.kind === "model" ? (p.ms != null ? duration(p.ms) : null)
        : step.kind === "stage" && p.duration_ms != null ? duration(p.duration_ms)
          : p.tokens ? `${num(p.tokens)} tok` : null;
  const collapsible = cancelled ? false : step.kind === "stage" ? block : step.kind === "model" ? thinking : true;
  const data = step.kind === "final" ? p.data ?? run.output?.data : undefined;
  /** 「怎么处理」只给最后一次出错、且运行现在还是失败的：续跑成功后，前面那次的建议已经过时 */
  const hint = code && !cancelled && anchor && run.status === "failed" ? ERROR_HINT[code] : undefined;
  return (
    <li id={anchor ? "step-final" : undefined} className="group relative flex scroll-mt-4 gap-3 pb-1">
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
            {step.kind === "final" && run.output?.step_limit && (
              <div className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft/40 px-3 py-2 text-[12.5px] text-warn">
                <LuCircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>模型调用次数到了上限，工具已停用，这是让 agent 收尾时给的结论：可能没查完，看里面列的「还没做完的事」。要接着查就纠正或在对话里追问。</span>
              </div>
            )}
            {step.kind === "final" && (run.resolution === "builtin" && String(p.content ?? "").startsWith("{")
              ? <CodeBlock code={String(p.content)} maxHeight={420} />
              : <div className="rounded-md border border-ok/25 bg-ok-soft/20 px-4 py-3"><Markdown text={String(p.content)} className="text-[13px]" /></div>
            )}
            {data && <CodeBlock title="结构化结果" code={JSON.stringify(data, null, 2)} maxHeight={320} />}
            {step.kind === "error" && <CodeBlock code={String(p.content)} wrap />}
            {hint && (
              <div className="flex items-start gap-1.5 text-[12px] leading-relaxed text-fg-3">
                <LuCircleAlert className="mt-[3px] size-3.5 shrink-0 text-bad" />
                <span>
                  {hint.text}
                  {hint.to && (run.service || !hint.to(run).startsWith("/services")) && (
                    <Link to={hint.to(run)} className="ml-2 text-accent hover:underline">{hint.link}</Link>
                  )}
                </span>
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
  const todo = todoItems(c.todo);
  /* 宽屏时侧栏贴顶、自己滚：时间线短的时候左边不会空一大截，时间线长的时候侧栏一直看得见 */
  return (
    <div className="min-w-0 space-y-4 xl:sticky xl:top-0 xl:max-h-[calc(100dvh-48px-3.5rem)] xl:self-start xl:overflow-y-auto xl:pr-0.5">
      {todo.length > 0 && (
        <Card>
          <CardHeader title="待办" icon={<LuListTodo />}
            description={`agent 列的计划 · 完成 ${todo.filter((t) => t.status === "completed").length}/${todo.length}`} />
          <div className="px-4 py-3"><TodoList items={todo} /></div>
        </Card>
      )}
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
              : run.trigger.type === "after" && run.trigger.source
                ? <span>上游联动 · 上游 <Link to={`/runs/${run.trigger.source}`} className="font-mono text-[12px] text-accent hover:underline">{shortId(run.trigger.source)}</Link>{run.trigger.id && <code className="ml-1 font-mono text-[11.5px] text-fg-3">#{run.trigger.id}</code>}</span>
                : <span>{TRIGGER[run.trigger.type]?.label ?? run.trigger.type}{run.trigger.source ? ` · ${run.trigger.source}` : ""}{run.trigger.id ? <code className="ml-1 font-mono text-[11.5px] text-fg-3">#{run.trigger.id}</code> : ""}</span>],
            ["发起方", <Link to={`/runs?caller=${encodeURIComponent(run.trigger.caller)}&env=${run.env}`} className="font-mono text-[12px] hover:text-accent">{run.trigger.caller}</Link>],
            ["会话", run.session_id === run.run_id ? <span className="text-fg-3">独立运行</span> : <Link to={`/runs?session_id=${encodeURIComponent(run.session_id)}&env=${run.env}`} className="break-all font-mono text-[11.5px] hover:text-accent">{run.session_id}</Link>],
            ["记忆", <span>召回{onOff(run.memory?.recall)} · 沉淀{onOff(run.memory?.save)}</span>],
            ["开始", datetime(run.created_at, true)],
            ["结束", run.finished_at ? datetime(run.finished_at, true) : "—"],
            ...(run.attempt > 1 ? [["执行", `第 ${run.attempt} 次（续跑 / 自动重试）`] as [ReactNode, ReactNode]] : []),
          ]} />
        </div>
      </Card>
      <LineageCard run={run} />
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

/** 前后关系：触发它的上游运行（上游联动）、它点名等的运行、它引出的运行（联动触发的 + 点名等它的） */
function LineageCard({ run }: { run: Run }) {
  const l = run.lineage;
  if (!l || (!l.triggered_by && !l.depends_on.length && !l.downstream.length)) return null;
  const row = (r: RunBrief, note?: ReactNode) => (
    <li key={r.run_id}>
      <Link to={`/runs/${r.run_id}`} className="flex items-center gap-2 px-4 py-2 text-[12.5px] hover:bg-hover/70">
        {r.status ? <RunStatusDot status={r.status} /> : <span className="size-4" />}
        <span className="min-w-0 truncate text-fg-2">{r.task_title || r.task || "（已删除）"}{r.task?.includes(":") && <span className="font-mono text-fg-3"> :{r.task.split(":")[1]}</span>}</span>
        {note && <span className="shrink-0 text-[11px] text-fg-3">{note}</span>}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-fg-3">{shortId(r.run_id)}</span>
      </Link>
    </li>
  );
  const section = (title: string, children: ReactNode) => (
    <div><div className="px-4 pt-2.5 text-[11.5px] font-medium text-fg-3">{title}</div><ul>{children}</ul></div>
  );
  return (
    <Card>
      <CardHeader title="前后关系" icon={<LuWorkflow />} description="上游联动、点名等的上游，以及它引出的运行" />
      <div className="divide-y divide-line pb-1">
        {l.triggered_by && section("触发它的上游运行", row(l.triggered_by, run.trigger.id ? `#${run.trigger.id}` : undefined))}
        {l.depends_on.length > 0 && section("它点名等的运行（都成功了才开始）", l.depends_on.map((r) => row(r)))}
        {l.downstream.length > 0 && section("它引出的运行", l.downstream.map((r) => row(r, r.trigger.type === "after" ? "联动" : "等它")))}
      </div>
    </Card>
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
    if (r.prompts) items.push(["平台提示词", <Link to="/settings/prompts?view=versions" className="hover:text-accent">v{r.prompts}</Link>]);
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
