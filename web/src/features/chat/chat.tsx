/**
 * 对话：会话侧栏（可按服务 / 环境 / 任务筛）+ 消息流 + 输入区。
 *
 * 输入区上方的维度条决定"问谁、在哪问"：服务、环境、任务、对象（子任务，可直接输入新对象）、
 * 任务的其它输入字段、记忆开关。一个会话 = 一个 LangGraph thread，服务 / 环境 / 任务 / 对象在会话内固定；
 * 记忆开关和其它输入每轮都能改。回答下面可以 👍、👎（选问题类型、写说明，可顺手让 agent 按意见重答）、纠正。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LuArrowUp, LuBrain, LuChevronDown, LuChevronRight, LuCircleStop, LuExternalLink, LuMessageSquare, LuPenLine,
  LuPlus, LuSlidersHorizontal, LuSparkles, LuWrench,
} from "react-icons/lu";

import { stream } from "@/api/client";
import { api, useEnvs, useServices, useSession, useSessions, useSubtasks, useTasks } from "@/api/hooks";
import type { ChatRequest, ChatTurn, MemoryOverride, RunEvent, TaskSummary } from "@/api/types";
import { EnvFilter, ServiceFilter } from "@/components/filters";
import { FeedbackButtons } from "@/components/feedback";
import { EnvBadge } from "@/components/status";
import { ToolOutput, isDbTool, summarizeArgs } from "@/components/tool-call";
import { Button } from "@/components/ui/button";
import { CopyButton, Markdown } from "@/components/ui/data";
import { CreatableSelect, Field, FilterSelect, Input, SearchInput, Select, Switch, Textarea, objectNameError } from "@/components/ui/form";
import { Popover, Tooltip, toast } from "@/components/ui/overlay";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago } from "@/lib/format";
import { invalidate } from "@/lib/query";
import { Link, navigate, useParams, useSearch } from "@/lib/router";
import { useUi } from "@/lib/store";
import { ASK_TASK } from "../tasks/run-dialog";

interface LiveTurn extends ChatTurn { streaming?: boolean }

/** 通用入口 ask 排第一个（没指定任务时后端也是：服务专属的对话任务优先，其次 ask） */
const askFirst = (a: TaskSummary, b: TaskSummary) => Number(b.name === ASK_TASK) - Number(a.name === ASK_TASK);
const chatTasksFor = (tasks: TaskSummary[] | undefined, service: string) =>
  (tasks ?? []).filter((t) => !t.extends && t.enabled && t.triggers.some((tr) => tr.type === "chat") && (t.service === service || t.service === "*")).sort(askFirst);

const chatTaskOption = (t: TaskSummary) => t.name === ASK_TASK
  ? { value: t.name, label: <span className="flex items-center gap-1.5">{t.title || t.name}<Badge tone="accent">通用</Badge></span>, hint: "ask · 任何服务任何环境直接问" }
  : { value: t.name, label: t.title || t.name, hint: `${t.name}${t.service === "*" ? " · 通用" : ""}` };

export function ChatPage() {
  const { session } = useParams<{ session?: string }>();
  const [f, setF] = useSearch<{ service: string; env: string; task: string }>();
  const [q, setQ] = useState("");
  /** 「新对话」：已经在 /chat 上聊着的新会话也要清空重来 */
  const [fresh, setFresh] = useState(0);
  const { data: sessions } = useSessions({ service: f.service, env: f.env, task: f.task, q: q || undefined });
  const { data: tasks } = useTasks();
  const groups = useMemo(() => {
    const today: NonNullable<typeof sessions> = [], week: NonNullable<typeof sessions> = [], older: NonNullable<typeof sessions> = [];
    for (const s of sessions ?? []) {
      const days = (Date.now() - new Date(s.last_at).getTime()) / 86400_000;
      (days < 1 ? today : days < 7 ? week : older).push(s);
    }
    return [["今天", today], ["近 7 天", week], ["更早", older]] as const;
  }, [sessions]);
  const chatTaskOptions = (tasks ?? []).filter((t) => !t.extends && t.triggers.some((tr) => tr.type === "chat")).sort(askFirst).map((t) => ({ value: t.name, label: t.title || t.name }));

  return (
    <div className="flex h-full">
      <aside className="hidden w-[272px] shrink-0 flex-col border-r border-line bg-panel md:flex">
        <div className="space-y-2 p-3">
          <Button className="w-full" icon={<LuPlus />} onClick={() => { navigate("/chat"); setFresh((n) => n + 1); }}>新对话</Button>
          <SearchInput value={q} onChange={setQ} placeholder="搜索会话内容" />
          <div className="flex flex-wrap gap-1.5">
            <ServiceFilter value={f.service ?? ""} onChange={(v) => setF({ service: v || undefined })} />
            <EnvFilter value={f.env ?? ""} onChange={(v) => setF({ env: v || undefined })} />
            {chatTaskOptions.length > 1 && <FilterSelect label="任务" allLabel="全部" value={f.task ?? ""} onChange={(v) => setF({ task: v || undefined })} options={chatTaskOptions} />}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {!sessions ? <div className="space-y-2 p-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>
            : !sessions.length ? <div className="px-3 py-6 text-center text-[12.5px] text-fg-3">没有符合条件的会话</div>
              : groups.map(([label, items]) => items.length > 0 && (
                <div key={label} className="mb-2">
                  <div className="px-2 pb-1 pt-2 text-[11px] font-semibold text-fg-3">{label}</div>
                  {items.map((s) => (
                    <Link key={s.session_id} to={`/chat/${s.session_id}`} title={s.title} aria-current={session === s.session_id ? "page" : undefined}
                      className={cn("block rounded-md px-2.5 py-2 hover:bg-hover", session === s.session_id && "bg-accent-soft hover:bg-accent-soft")}>
                      <div className={cn("truncate text-[13px]", session === s.session_id ? "font-medium text-accent" : "text-fg")}>{s.title}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-3">
                        <span className="truncate">{s.service ?? "平台"}</span><span className="shrink-0 font-mono uppercase">{s.env}</span>
                        {s.task.includes(":") && <span className="truncate font-mono">{s.task.split(":")[1]}</span>}
                        <span className="shrink-0">· {s.runs} 轮</span><span className="ml-auto shrink-0">{ago(s.last_at)}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              ))}
        </div>
      </aside>
      <Conversation key={session ?? `new-${fresh}`} sessionId={session} />
    </div>
  );
}

function Conversation({ sessionId }: { sessionId?: string }) {
  const ui = useUi();
  const { data: detail, loading } = useSession(sessionId ?? "");
  const { data: services } = useServices();
  const { data: envs } = useEnvs();
  const { data: tasks } = useTasks();
  const [service, setService] = useState("");
  const [env, setEnv] = useState("");
  const [task, setTask] = useState("");
  const [subtask, setSubtask] = useState("");
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [memory, setMemory] = useState<{ recall: boolean; save: boolean }>({ recall: ui.chat.recall, save: ui.chat.save });
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [text, setText] = useState("");
  const [sid, setSid] = useState<string | undefined>(sessionId);
  const cancelRef = useRef<(() => void) | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const streaming = turns.some((t) => t.streaming);
  const locked = turns.length > 0;

  // 已有会话：维度取自会话；新会话：取个人偏好里的对话默认项
  useEffect(() => {
    if (!detail) return;
    setTurns(detail.turns);
    setService(detail.service ?? "");
    setEnv(detail.env);
    const [base, obj] = detail.task.split(":");
    setTask(base);
    setSubtask(obj ?? "");
  }, [detail]);
  useEffect(() => {
    if (sessionId) return;
    if (!service && services?.length) setService((services.find((s) => s.name === ui.chat.service && s.enabled) ?? services.find((s) => s.enabled))?.name ?? "");
    if (!env && envs?.length) setEnv((envs.find((e) => e.name === (ui.chat.env || ui.env)) ?? envs.find((e) => !e.protected) ?? envs[0]).name);
  }, [sessionId, services, envs, service, env, ui.chat.service, ui.chat.env, ui.env]);

  const chatTasks = chatTasksFor(tasks, service);
  useEffect(() => {
    if (locked || !chatTasks.length) return;
    if (!chatTasks.some((t) => t.name === task)) setTask((chatTasks.find((t) => t.name === ui.chat.task) ?? chatTasks.find((t) => t.service === service) ?? chatTasks[0]).name);
  }, [chatTasks, task, locked, service, ui.chat.task]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [turns]);
  useEffect(() => () => cancelRef.current?.(), []);

  const taskDef = tasks?.find((t) => t.name === task);
  const extraFields = Object.entries(taskDef?.input ?? {}).filter(([k]) => k !== "question");
  const svc = services?.find((s) => s.name === service);
  const envOff = !!svc && svc.health[env]?.enabled === false;

  const patchLast = (fn: (t: LiveTurn) => LiveTurn) => setTurns((all) => all.map((t, i) => (i === all.length - 1 ? fn(t) : t)));

  const send = () => {
    const message = text.trim();
    if (!message || streaming) return;
    setText("");
    setTurns((t) => [...t, { run_id: "", question: message, answer: "", status: "running", events: [], feedback: null, created_at: new Date().toISOString(), streaming: true }]);
    const input = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== ""));
    const body: ChatRequest = { message, session_id: sid ?? null, service, env, task, subtask: subtask || null, input, memory: memory as MemoryOverride };
    let seq = 0;
    cancelRef.current = stream("/v1/chat", body, (ev) => {
      const type = String(ev.type);
      if (type === "run") {
        patchLast((t) => ({ ...t, run_id: String(ev.run_id) }));
        if (!sid) setSid(String(ev.session_id));
        if (ev.subtask_created) toast(`已按 ${task} 新建子任务`, { description: String(ev.subtask_created) });
      } else if (type === "error") {
        patchLast((t) => ({ ...t, status: "failed", answer: `**${String(ev.code)}**：${String(ev.message)}`, streaming: false }));
      } else if (type === "final") {
        const out = (ev.output ?? {}) as { answer?: string; error?: string };
        patchLast((t) => ({ ...t, answer: out.answer ?? out.error ?? t.answer, status: (ev.status as LiveTurn["status"]) ?? "success", streaming: false }));
      } else if (["stage", "model_call", "thought", "tool_call", "tool_result"].includes(type)) {
        const { type: _t, ...payload } = ev;
        void _t;
        patchLast((t) => ({ ...t, events: [...t.events, { seq: ++seq, kind: type as RunEvent["kind"], at: new Date().toISOString(), payload } as RunEvent] }));
      }
    }, (err) => {
      if (err) { patchLast((t) => ({ ...t, status: "failed", answer: err.message, streaming: false })); toast.error("发送失败", err.message); }
      else patchLast((t) => ({ ...t, streaming: false }));
      invalidate("sessions");
      cancelRef.current = null;
    });
  };
  const stop = () => {
    cancelRef.current?.();
    patchLast((t) => ({ ...t, streaming: false, status: "cancelled" }));
  };

  /** 纠正：同会话开新一轮；结果轮询拿回来 */
  const correct = async (runId: string, correction: string) => {
    try {
      const acc = await api.correct(runId, correction);
      setTurns((t) => [...t, { run_id: acc.run_id, question: `[纠正] ${correction}`, answer: "", status: "running", events: [], feedback: null, created_at: new Date().toISOString(), streaming: true }]);
      for (let i = 0; i < 150; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const run = await api.run(acc.run_id);
        if (["success", "failed", "cancelled"].includes(run.status)) {
          setTurns((all) => all.map((t) => (t.run_id === acc.run_id ? { ...t, status: run.status, answer: run.output?.answer ?? run.output?.error ?? "", streaming: false } : t)));
          break;
        }
      }
      invalidate("sessions");
    } catch (e) { toast.error("纠正失败", (e as Error).message); }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-bg">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel/60 px-5 text-[12.5px] text-fg-3">
        <LuMessageSquare className="size-4" />
        <span className="truncate text-fg">{detail?.title ?? (turns[0]?.question.slice(0, 40) || "新对话")}</span>
        {sid && <span className="hidden font-mono text-[11px] sm:inline">{sid.slice(0, 12)}</span>}
        <div className="ml-auto flex items-center gap-2">{service && <span className="truncate">{svc?.title ?? service}</span>}{env && <EnvBadge env={env} />}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[820px] px-4 py-6 md:px-6">
          {sessionId && loading ? <div className="space-y-4"><Skeleton className="h-16" /><Skeleton className="h-40" /></div> : turns.length === 0 ? (
            <Welcome service={service} title={svc?.title ?? service} onPick={(q) => setText(q)} />
          ) : turns.map((t, i) => <Turn key={t.run_id || i} turn={t} onCorrect={(c) => correct(t.run_id, c)} />)}
          <div ref={bottom} />
        </div>
      </div>
      <div className="shrink-0 px-4 pb-5 md:px-6">
        <div className="mx-auto max-w-[820px] rounded-xl border border-line bg-panel shadow-[var(--shadow-pop)] focus-within:border-accent">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
            <Dim label="服务" locked={locked}>
              <Select size="sm" className="w-36" value={service || null} disabled={locked} onChange={(v) => { setService(v); setSubtask(""); }}
                options={(services ?? []).filter((s) => s.enabled).map((s) => ({ value: s.name, label: s.name, hint: s.title }))} />
            </Dim>
            <Dim label="环境" locked={locked}>
              <Select size="sm" className="w-24" value={env || null} disabled={locked} onChange={setEnv}
                options={(envs ?? []).map((e) => ({ value: e.name, label: <span className="font-mono uppercase">{e.name}</span>, hint: svc?.health[e.name]?.enabled === false ? "该服务在此环境已停用" : e.title }))} />
            </Dim>
            <Dim label="任务" locked={locked} hint="问哪一类问题：服务上声明了「对话」触发的任务都能选，不同任务用不同的角色与档案；拿不准就用「问一下」（通用入口，什么都能问、能交代事）">
              <Select size="sm" className="w-40" value={task || null} disabled={locked} onChange={(v) => { setTask(v); setSubtask(""); setExtra({}); }}
                placeholder="该服务没有对话任务" options={chatTasks.map(chatTaskOption)} />
            </Dim>
            <Dim label="对象" locked={locked} hint={`可选：针对 ${taskDef?.title || task || "该任务"} 的某个具体对象（一个资产、一张表、一个报表）问。会带上这个对象的专属档案，沉淀的记忆也记在它名下；输入新名字会自动建一个子任务。`}>
              {locked ? <span className="font-mono text-[12px] text-fg-2">{subtask || "—"}</span> : <SubtaskPicker task={task} value={subtask} onChange={setSubtask} />}
            </Dim>
            {extraFields.length > 0 && (
              <Popover align="start" trigger={
                <span className={cn("inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12px] [&_svg]:size-3.5", Object.values(extra).some(Boolean) ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-fg-2 hover:bg-hover")}>
                  <LuSlidersHorizontal />输入 {Object.values(extra).filter(Boolean).length || ""}
                </span>
              }>
                <div className="w-72 space-y-3 p-3">
                  <div className="text-[12px] text-fg-3">任务 {task} 的其它输入，每轮随消息一起发送</div>
                  {extraFields.map(([k, f]) => (
                    <Field key={k} label={<span className="font-mono">{k}{f.required && <span className="text-bad">*</span>}</span>} help={f.description}>
                      {f.type === "enum" ? <Select size="sm" value={extra[k] ?? String(f.default ?? "")} onChange={(v) => setExtra({ ...extra, [k]: v })} options={(f.options ?? []).map((o) => ({ value: o, label: o }))} />
                        : <Input value={extra[k] ?? ""} placeholder={f.default !== undefined ? String(f.default) : ""} onChange={(e) => setExtra({ ...extra, [k]: e.target.value })} />}
                    </Field>
                  ))}
                </div>
              </Popover>
            )}
            <Popover align="start" trigger={
              <span className={cn("inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12px] [&_svg]:size-3.5", !memory.recall || !memory.save ? "border-warn/40 bg-warn-soft text-warn" : "border-line text-fg-2 hover:bg-hover")}>
                <LuBrain />{memory.recall && memory.save ? "记忆" : !memory.recall && !memory.save ? "不用记忆" : !memory.recall ? "不召回" : "不沉淀"}
              </span>
            }>
              <div className="w-64 space-y-3 p-3">
                <Switch checked={memory.recall} onChange={(recall) => setMemory({ ...memory, recall })} label={<span>召回<span className="ml-1 text-[11.5px] text-fg-3">先查记忆与方法</span></span>} />
                <Switch checked={memory.save} onChange={(save) => setMemory({ ...memory, save })} label={<span>沉淀<span className="ml-1 text-[11.5px] text-fg-3">回答后存可复用结论</span></span>} />
                <div className="text-[11.5px] text-fg-3">只影响接下来的消息；平台默认在 设置 → 记忆。</div>
              </div>
            </Popover>
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label="消息" placeholder={envOff ? `${service} 在 ${env} 环境已停用` : `问 ${svc?.title ?? "agent"} 点什么…（Enter 发送，Shift+Enter 换行）`}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
            className="block max-h-48 w-full resize-none bg-transparent px-4 pt-3 text-[13.5px] leading-relaxed text-fg outline-none placeholder:text-fg-3" />
          <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
            <span className="text-[11px] text-fg-3">{locked ? "同一会话内服务、环境、任务、对象固定；要换就开新对话" : subtask && !(tasks ?? []).some((t) => t.name === `${task}:${subtask}`) ? `发送时会按 ${task} 新建子任务 ${task}:${subtask}` : ""}</span>
            <div className="ml-auto">
              {streaming ? <Button size="icon-sm" variant="secondary" onClick={stop} aria-label="停止"><LuCircleStop /></Button>
                : <Button size="icon-sm" variant="primary" disabled={!text.trim() || !service || !task || envOff} onClick={send} aria-label="发送"><LuArrowUp /></Button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Dim({ label, hint, locked, children }: { label: string; hint?: string; locked: boolean; children: React.ReactNode }) {
  const name = <span className={cn("text-[11px] text-fg-3", hint && "cursor-help underline decoration-dotted underline-offset-2")}>{label}</span>;
  return (
    <div className={cn("flex items-center gap-1.5 rounded-md pl-1.5", locked && "opacity-80")}>
      {hint ? <Tooltip content={hint}>{name}</Tooltip> : name}
      {children}
    </div>
  );
}

/** 子任务：选已有对象，或直接输入新对象名（发送时自动按父任务建） */
function SubtaskPicker({ task, value, onChange }: { task: string; value: string; onChange: (v: string) => void }) {
  const { data } = useSubtasks(task);
  return (
    <CreatableSelect className="w-44" value={value} onChange={onChange} placeholder={data?.length ? `不指定（${data.length} 个可选）` : "不指定"} validate={objectNameError}
      createLabel="新对象" options={(data ?? []).map((t) => ({ value: t.name.split(":")[1], label: t.name.split(":")[1], hint: t.title || (t.auto_created ? "自动创建，档案待补" : undefined) }))} />
  );
}

/** 欢迎页的示例问题：按服务给几条像样的 */
const EXAMPLES: Record<string, string[]> = {
  "vision-dagster": ["昨天 dws_account_pnl_daily 为什么物化失败？", "dwd_position_daily 依赖哪些上游资产？", "ck 里 ods_trade_fills 昨天有多少行？", "在本环境跑一下 pnl 相关的测试"],
  "vision-board": ["账户收益日报的数据来自哪张表？", "策略周报页面在 test 能正常打开吗？", "离线 HTML 导出为什么报 Chrome 找不到？", "本环境 settings 里 STATIC_ROOT 配的是哪？"],
  "vision-web": ["策略 alpha_mm_03 挂在哪些账户上？", "vision_cfg 里组合（Portfolio）有哪些字段？", "本地应用授权码是怎么生成的？", "nginx 错误日志里最近有什么？"],
};
const DEFAULT_EXAMPLES = ["这个服务的代码目录和配置文件在哪？", "线上代码目录现在是哪个提交？", "最近的应用日志里有没有报错？", "这台主机的内存和磁盘还够吗？"];

function Welcome({ service, title, onPick }: { service: string; title: string; onPick: (q: string) => void }) {
  const examples = EXAMPLES[service] ?? DEFAULT_EXAMPLES;
  return (
    <div className="pt-12 text-center">
      <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent"><LuSparkles className="size-5" /></div>
      <div className="mt-4 text-[17px] font-semibold text-fg">问 {title || "agent"}</div>
      <div className="mt-1 text-[13px] text-fg-3">口径以档案为准，取数只走该环境登记的只读库；每一步都能在运行详情里回放</div>
      <div className="mx-auto mt-6 grid max-w-lg gap-2 sm:grid-cols-2">
        {examples.map((e) => (
          <button key={e} type="button" onClick={() => onPick(e)} className="rounded-lg border border-line bg-panel px-3 py-2.5 text-left text-[12.5px] text-fg-2 transition-colors hover:border-accent hover:text-fg">{e}</button>
        ))}
      </div>
    </div>
  );
}

function Turn({ turn, onCorrect }: { turn: LiveTurn; onCorrect: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState("");
  /** 思考 = 带内容的模型调用（模型的思考过程；旧运行是 thought）；不带内容的模型调用在这里不显示 */
  const thought = (e: RunEvent) => e.kind === "thought" || (e.kind === "model_call" && !!e.payload.content);
  const shown = turn.events.filter((e) => e.kind !== "model_call" || thought(e));
  const steps = turn.events.filter((e) => thought(e) || e.kind === "tool_call");
  return (
    <div className="mb-7">
      <div className="mb-3 flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[13.5px] text-accent-fg">{turn.question}</div>
      </div>
      <div className="flex gap-3">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"><LuSparkles className="size-3.5" /></div>
        <div className="min-w-0 flex-1">
          {steps.length > 0 && (
            <button type="button" onClick={() => setOpen(!open)} className="mb-2 inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-fg-3 hover:text-fg">
              {open ? <LuChevronDown className="size-3.5" /> : <LuChevronRight className="size-3.5" />}
              {turn.streaming && !turn.answer ? "思考中…" : "查看过程"} · {steps.length} 步
            </button>
          )}
          {open && (
            <div className="mb-3 space-y-1.5 border-l-2 border-line pl-3">
              {shown.map((e) => (
                <div key={e.seq} className="min-w-0 text-[12px]">
                  {thought(e) && <div className="flex gap-1.5 text-fg-2"><LuSparkles className="mt-0.5 size-3 shrink-0 text-accent" /><span className="min-w-0 whitespace-pre-wrap break-words">{String(e.payload.content)}</span></div>}
                  {e.kind === "tool_call" && (
                    <div className="flex min-w-0 gap-1.5 font-mono text-fg-2" title={summarizeArgs(e.payload.args, String(e.payload.tool))}>
                      <LuWrench className="mt-0.5 size-3 shrink-0 text-info" /><span className="shrink-0">{String(e.payload.tool)}</span>
                      <span className="truncate text-fg-3">{summarizeArgs(e.payload.args, String(e.payload.tool))}</span>
                    </div>
                  )}
                  {e.kind === "tool_result" && (isDbTool(e.payload.tool)
                    ? <ToolOutput tool={String(e.payload.tool)} output={String(e.payload.output ?? "")} className="ml-4" />
                    : <pre className="ml-4 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-sunken px-2 py-1 font-mono text-[11px] text-fg-3">{String(e.payload.output ?? "")}</pre>)}
                  {e.kind === "stage" && <div className="truncate text-fg-3" title={String(e.payload.title ?? e.payload.stage)}>· {String(e.payload.title ?? e.payload.stage)}</div>}
                </div>
              ))}
            </div>
          )}
          {turn.answer ? <Markdown text={turn.answer} className={cn("text-[13.5px]", turn.status === "failed" && "text-bad")} />
              : turn.streaming ? <div className="flex gap-1 py-2" aria-label="正在回答">{[0, 1, 2].map((i) => <span key={i} className="size-1.5 animate-bounce rounded-full bg-fg-3" style={{ animationDelay: `${i * 120}ms` }} />)}</div>
                : turn.status === "cancelled" ? <div className="text-[12.5px] text-fg-3">已停止</div>
                  : turn.status === "running" ? <div className="text-[12.5px] text-fg-3">执行中…</div> : null}
          {!turn.streaming && turn.answer && (
            <div className="mt-2 flex items-center gap-0.5 text-fg-3">
              <CopyButton text={turn.answer} />
              {turn.run_id && <FeedbackButtons runId={turn.run_id} mine={turn.feedback} onCorrect={turn.status === "success" ? onCorrect : undefined} />}
              {turn.run_id && turn.status === "success" && <button type="button" onClick={() => setCorrecting(!correcting)} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] hover:bg-hover hover:text-fg"><LuPenLine className="size-3" />纠正</button>}
              {turn.run_id && <Link to={`/runs/${turn.run_id}`} className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] hover:bg-hover hover:text-fg"><LuExternalLink className="size-3" />运行详情</Link>}
            </div>
          )}
          {correcting && (
            <div className="mt-2 space-y-2 rounded-lg border border-line bg-panel p-3">
              <Textarea rows={2} autoFocus value={correction} onChange={(e) => setCorrection(e.target.value)} placeholder="哪里不对？例如：收益要按交易日统计，不按自然日"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && correction.trim()) { e.preventDefault(); onCorrect(correction.trim()); setCorrecting(false); setCorrection(""); }
                }} />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11.5px] text-fg-3">会在本会话开新一轮（Ctrl+Enter 提交）；成功后上一轮沉淀的记忆被取代</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setCorrecting(false)}>取消</Button>
                  <Button size="sm" variant="primary" disabled={!correction.trim()} onClick={() => { onCorrect(correction.trim()); setCorrecting(false); setCorrection(""); }}>提交纠正</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
