/**
 * 对话：会话侧栏（可按服务 / 环境 / 任务筛）+ 消息流 + 输入区。
 *
 * 输入区上方的维度条决定"问谁、在哪问"：服务、环境、任务、对象（子任务，可直接输入新对象）、
 * 任务的其它输入字段、记忆开关。一个会话 = 一个 LangGraph thread，服务 / 环境 / 任务 / 对象在会话内固定；
 * 记忆开关和其它输入每轮都能改。回答下面可以 👍、👎（选问题类型、写说明，可顺手让 agent 按意见重答）、纠正。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LuArrowUp, LuBrain, LuChevronDown, LuChevronRight, LuCircleAlert, LuCircleStop, LuExternalLink, LuMessageSquare, LuPencilLine,
  LuPlus, LuSlidersHorizontal, LuSparkles, LuWrench, LuX,
} from "react-icons/lu";

import { ApiError, stream } from "@/api/client";
import { api, useEnvs, useServices, useSession, useSessions, useSettings, useSubtasks, useTasks } from "@/api/hooks";
import type { ChatRequest, ChatTurn, MemoryOverride, RunEvent, TaskSummary } from "@/api/types";
import { EnvFilter, ServiceFilter, envOf, envParam } from "@/components/filters";
import { FeedbackButtons } from "@/components/feedback";
import { IdCopy } from "@/components/meta";
import { EnvBadge } from "@/components/status";
import { TimeAgo } from "@/components/time";
import { ToolOutput, isDbTool, summarizeArgs } from "@/components/tool-call";
import { Button } from "@/components/ui/button";
import { CopyButton, Markdown } from "@/components/ui/data";
import { CreatableSelect, FilterSelect, SearchInput, Segmented, Select, Textarea, objectNameError } from "@/components/ui/form";
import { Popover, Tooltip, toast } from "@/components/ui/overlay";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { shortId } from "@/lib/format";
import { invalidate } from "@/lib/query";
import { Link, navigate, useLocation, useParams, useSearch } from "@/lib/router";
import { getUi, setUi, useUi, type UiState } from "@/lib/store";
import { InputControl, inputErrors, inputValue } from "../tasks/input-control";
import { ASK_TASK } from "../tasks/run-dialog";

/**
 * key：这一轮在页面上的身份（流式事件按它落到对应的那一轮，不按"最后一轮"）；
 * broken：推流中断（stream_broken）时后端给的说明；运行照常在跑，结果去运行详情看
 */
interface LiveTurn extends ChatTurn { key: string; streaming?: boolean; broken?: string }

const LIVE_STATUS = new Set(["queued", "running"]);
let turnSeq = 0;

/** 通用入口 ask 排第一个（没指定任务时后端也是：服务专属的对话任务优先，其次 ask） */
const askFirst = (a: TaskSummary, b: TaskSummary) => Number(b.name === ASK_TASK) - Number(a.name === ASK_TASK);
/** 能在对话里选的任务：启用、声明了（开着的）对话触发、属于这个服务（或通用）、允许这个环境 */
const chatTasksFor = (tasks: TaskSummary[] | undefined, service: string, env: string) =>
  (tasks ?? []).filter((t) => !t.extends && t.enabled && t.triggers.some((tr) => tr.type === "chat" && tr.enabled !== false)
    && (t.service === service || t.service === "*") && (!env || !t.envs.length || t.envs.includes(env))).sort(askFirst);

const chatTaskOption = (t: TaskSummary) => t.name === ASK_TASK
  ? { value: t.name, label: <span className="flex items-center gap-1.5">{t.title || t.name}<Badge tone="accent">通用</Badge></span>, hint: "ask · 任何服务任何环境直接问" }
  : { value: t.name, label: t.title || t.name, hint: `${t.name}${t.service === "*" ? " · 通用" : ""}` };

export function ChatPage() {
  const { "*": rest } = useParams<{ "*"?: string }>();
  const session = rest || undefined;
  const [f, setF] = useSearch<{ service: string; env: string; task: string }>();
  const [q, setQ] = useState("");
  /** 「新对话」：已经在 /chat 上聊着的新会话也要清空重来 */
  const [fresh, setFresh] = useState(0);
  /**
   * 新对话发完一轮后地址换成了 /chat/<会话>（刷新还在）：这个会话沿用原来的视图（同一个 key，不重新挂载、不清空）。
   * 用 ref 不用 state：要和换地址引起的那次渲染同时生效，state 可能晚一拍，那一拍就按会话 id 重新挂载了
   */
  const adopted = useRef<{ sid: string; key: string } | null>(null);
  useEffect(() => { if (adopted.current && adopted.current.sid !== session) adopted.current = null; }, [session]);
  const ui = useUi();
  /** 会话列表和其它列表一样默认跟随顶栏的环境视角 */
  const env = envOf(f.env, ui.env);
  const { data: sessions, error: sessionsError, refetch: refetchSessions } = useSessions({ service: f.service, env: env || undefined, task: f.task, q: q || undefined });
  /** 侧栏的筛选（环境跟随顶栏视角不算）：空态分"还没有会话"和"没有符合条件的" */
  const filtered = !!(f.service || f.env || f.task || q);
  const clearFilters = () => { setQ(""); setF({ service: undefined, env: undefined, task: undefined }); };
  /** 打开会话、开新对话时带上侧栏的筛选，不然一点就被清掉 */
  const { search } = useLocation();
  const keep = search.toString() ? "?" + search.toString() : "";
  const adopt = (sid: string) => {
    if (sid === session) return;
    adopted.current = { sid, key: `new-${fresh}` };
    navigate(`/chat/${encodeURIComponent(sid)}${keep}`, { replace: true });
    // 之后再回到 /chat 就是另一个新对话
    setFresh((n) => n + 1);
  };
  const own = !!session && adopted.current?.sid === session;
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
          <Button className="w-full" icon={<LuPlus />} onClick={() => { navigate("/chat" + keep); setFresh((n) => n + 1); }}>新对话</Button>
          <SearchInput value={q} onChange={setQ} placeholder="搜索会话内容" />
          <div className="flex flex-wrap gap-1.5">
            <ServiceFilter value={f.service ?? ""} onChange={(v) => setF({ service: v || undefined })} />
            <EnvFilter value={env} onChange={(v) => setF({ env: envParam(v, ui.env) })} />
            {chatTaskOptions.length > 1 && <FilterSelect label="任务" allLabel="全部" value={f.task ?? ""} onChange={(v) => setF({ task: v || undefined })} options={chatTaskOptions} />}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {/* 出错先判：查询层出错时 data 是 undefined，不判的话骨架一直转 */}
          {sessionsError && !sessions ? (
            <div className="px-3 py-6 text-center text-[12.5px]">
              <div className="text-bad">会话列表加载失败</div>
              <div className="mt-0.5 break-words text-[11.5px] text-fg-3">{sessionsError.message}</div>
              <Button size="xs" className="mt-2" onClick={() => void refetchSessions()}>重试</Button>
            </div>
          ) : !sessions ? <div className="space-y-2 p-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>
            : !sessions.length ? (
              <div className="px-3 py-6 text-center text-[12.5px] text-fg-3">
                {filtered ? "没有符合条件的会话" : "还没有会话"}
                {filtered && <div className="mt-2"><Button size="xs" icon={<LuX />} onClick={clearFilters}>清除筛选</Button></div>}
              </div>
            )
              : groups.map(([label, items]) => items.length > 0 && (
                <div key={label} className="mb-2">
                  <div className="px-2 pb-1 pt-2 text-[11px] font-semibold text-fg-3">{label}</div>
                  {items.map((s) => (
                    <Link key={s.session_id} to={`/chat/${encodeURIComponent(s.session_id)}${keep}`} title={s.title} aria-current={session === s.session_id ? "page" : undefined}
                      className={cn("block rounded-md px-2.5 py-2 hover:bg-hover", session === s.session_id && "bg-accent-soft hover:bg-accent-soft")}>
                      <div className={cn("truncate text-[13px]", session === s.session_id ? "font-medium text-accent" : "text-fg")}>{s.title}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-3">
                        <span className="truncate">{s.service ?? "平台"}</span><EnvBadge env={s.env} className="h-4 px-1 text-[10px]" />
                        {s.task.includes(":") && <span className="truncate font-mono">{s.task.split(":")[1]}</span>}
                        <span className="shrink-0">· {s.runs} 轮</span><span className="ml-auto shrink-0"><TimeAgo at={s.last_at} /></span>
                      </div>
                    </Link>
                  ))}
                </div>
              ))}
        </div>
      </aside>
      <Conversation key={own ? adopted.current!.key : session ?? `new-${fresh}`} sessionId={own ? undefined : session} onSession={adopt}
        prefer={{ service: f.service, task: f.task }} />
    </div>
  );
}

/**
 * sessionId：地址里的会话（要从服务端加载）；onSession：新对话的一轮结束后报会话 id，好把地址换成 /chat/<会话>；
 * prefer：侧栏筛的服务 / 任务，新对话优先用它们（筛了 vision-board 却在问 vision-dagster 很别扭）
 */
function Conversation({ sessionId, onSession, prefer }: { sessionId?: string; onSession?: (sid: string) => void; prefer?: { service?: string; task?: string } }) {
  const ui = useUi();
  const { data: detail, loading, error: sessionError } = useSession(sessionId ?? "");
  const { data: services } = useServices();
  const { data: envs } = useEnvs();
  const { data: tasks } = useTasks();
  const [service, setService] = useState("");
  const [env, setEnv] = useState("");
  const [task, setTask] = useState("");
  const [subtask, setSubtask] = useState("");
  const [extra, setExtra] = useState<Record<string, unknown>>({});
  /** null = 跟随任务 / 平台的默认；以前存成 true 的就是"开着没动过"，也当跟随 */
  const [memory, setMemory] = useState<MemoryOverride>({ recall: ui.chat.recall === false ? false : null, save: ui.chat.save === false ? false : null });
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [text, setText] = useState("");
  const [sid, setSid] = useState<string | undefined>(sessionId);
  const cancelRef = useRef<(() => void) | null>(null);
  /** 受理之前点了停止 */
  const stopRequested = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const bottom = useRef<HTMLDivElement>(null);
  const streaming = turns.some((t) => t.streaming);
  /** 服务端那边还有一轮没结束（别的标签页发的、刷新前发的、纠正）：不能再发，等它结束 */
  const serverLive = turns.some((t) => !t.streaming && LIVE_STATUS.has(t.status));
  const busy = streaming || serverLive;
  /** 会话建起来了（有一轮被受理）才锁维度：第一条就被拒的话还能改了再发 */
  const locked = !!sid || turns.some((t) => !!t.run_id);
  useSessionPoll(sessionId, serverLive);
  /**
   * 这个页面里发出的、推流断了还在服务端跑的轮次：新对话发完第一轮后没有按地址加载会话（sessionId 为空），
   * 上面的会话轮询不管它。每 2 秒查一次运行，结束了补上结论，输入框也就解锁了（不用为了解锁去取消一个好好的运行）
   */
  const orphaned = sessionId ? "" : turns.filter((t) => !t.streaming && LIVE_STATUS.has(t.status) && t.run_id).map((t) => `${t.key}|${t.run_id}`).join(",");
  useEffect(() => {
    if (!orphaned) return;
    const timer = window.setInterval(() => {
      for (const item of orphaned.split(",")) {
        const [key, runId] = item.split("|");
        void api.run(runId).then((run) => {
          if (!LIVE_STATUS.has(run.status)) patchTurn(key, (t) => ({ ...t, status: run.status, answer: run.output?.answer ?? run.output?.error ?? t.answer, broken: undefined }));
        }).catch(() => undefined);
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [orphaned]); // eslint-disable-line react-hooks/exhaustive-deps
  /** 新对话里改了服务 / 环境 / 任务 / 记忆开关：记在这台浏览器，下次新对话默认用上次的；已有会话里改的不记 */
  const remember = (patch: Partial<UiState["chat"]>) => {
    if (sessionId || Object.values(patch).some((v) => v === "")) return;
    setUi({ chat: { ...getUi().chat, ...patch } });
  };

  // 已有会话：维度取自会话；新会话：取上次新对话用的（见 remember）
  useEffect(() => {
    // 正在流式回答时不拿服务端的版本覆盖（切回窗口会后台刷新）：会丢掉"回答中"的状态和停止按钮
    if (!detail || turns.some((t) => t.streaming)) return;
    setTurns(detail.turns.map((t) => ({ ...t, key: t.run_id })));
    setService(detail.service ?? "");
    setEnv(detail.env);
    const [base, obj] = detail.task.split(":");
    setTask(base);
    setSubtask(obj ?? "");
  }, [detail]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sessionId) return;
    const usable = (name?: string) => services?.find((s) => s.name === name && s.enabled);
    if (!service && services?.length) setService((usable(prefer?.service) ?? usable(ui.chat.service) ?? services.find((s) => s.enabled))?.name ?? "");
    if (!env && envs?.length) setEnv((envs.find((e) => e.name === (ui.chat.env || ui.env)) ?? envs.find((e) => !e.protected) ?? envs[0]).name);
  }, [sessionId, services, envs, service, env, ui.chat.service, ui.chat.env, ui.env]); // eslint-disable-line react-hooks/exhaustive-deps
  // 新对话还没发出去时改了侧栏的服务 / 任务筛选：跟着换
  useEffect(() => {
    if (sessionId || locked) return;
    if (prefer?.service && services?.some((s) => s.name === prefer.service && s.enabled)) { setService(prefer.service); setSubtask(""); }
  }, [prefer?.service]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sessionId || locked || !prefer?.task) return;
    setTask(prefer.task); setSubtask(""); setExtra({});
  }, [prefer?.task]); // eslint-disable-line react-hooks/exhaustive-deps

  const chatTasks = chatTasksFor(tasks, service, env);
  useEffect(() => {
    if (locked || !tasks) return;
    // 换到没有对话任务的服务：清掉上一个服务的任务，免得发到不属于它的任务上
    if (!chatTasks.length) { if (task) setTask(""); return; }
    if (!chatTasks.some((t) => t.name === task)) {
      const pick = (name?: string) => chatTasks.find((t) => t.name === name);
      setTask((pick(sessionId ? undefined : prefer?.task) ?? pick(ui.chat.task) ?? chatTasks.find((t) => t.service === service) ?? chatTasks[0]).name);
    }
  }, [chatTasks, tasks, task, locked, service, ui.chat.task]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [turns]);
  useEffect(() => () => cancelRef.current?.(), []);
  // 新对话的这一轮结束了（回答完、出错或停止）：地址换成 /chat/<会话>，刷新还能看到
  useEffect(() => { if (sid && !sessionId && !streaming) onSession?.(sid); }, [sid, sessionId, streaming]); // eslint-disable-line react-hooks/exhaustive-deps

  const taskDef = tasks?.find((t) => t.name === task);
  /** 其它输入：question 是消息本身；对象字段由「对象」那一格给（后端按子任务把它填上），不再单独填一遍 */
  const extraDefs = Object.fromEntries(Object.entries(taskDef?.input ?? {}).filter(([k]) => k !== "question" && k !== taskDef?.object_input));
  const extraFields = Object.entries(extraDefs);
  /** 续会话时其它输入后端沿用上一轮，不用再填；新会话里必填的没填就不能发 */
  const extraErrors = locked ? {} : inputErrors(extraDefs, extra);
  const objectField = taskDef?.object_input ? taskDef.input[taskDef.object_input] : undefined;
  /** 对象字段必填：新会话里要先选对象（续会话沿用上一轮的） */
  const needObject = !locked && !!objectField?.required && objectField.default == null && !subtask;
  const missingExtra = Object.keys(extraErrors);
  const svc = services?.find((s) => s.name === service);
  const envOff = !!svc && svc.health[env]?.enabled === false;
  /** 链接里的会话不存在（或加载失败）：不能往一个不存在的会话里续 */
  const sessionGone = !!sessionId && !!sessionError && !detail;
  const canSend = !!text.trim() && !busy && !!service && !!task && !envOff && !sessionGone && !missingExtra.length && !needObject;
  /** 写了内容却发不出去的原因（悬停发送按钮时看到）；还没写内容就只是灰着 */
  const sendBlocked = !text.trim() || busy ? null
    : sessionGone ? "会话不存在，开个新对话"
      : !service ? "先选服务"
        : envOff ? `${service} 在 ${env} 已停用`
          : !task ? "这个服务没有对话任务"
            : needObject ? `先选对象（${taskDef?.object_input}）`
              : missingExtra.length ? `先在「输入」里填 ${missingExtra.join("、")}` : null;

  const patchTurn = (key: string, fn: (t: LiveTurn) => LiveTurn) => setTurns((all) => all.map((t) => (t.key === key ? fn(t) : t)));

  const send = () => {
    const message = text.trim();
    // 与发送按钮的禁用条件一致：Enter 也不能绕过（环境已停用、还没选服务 / 任务、必填输入没填）
    if (!canSend) return;
    setText("");
    const key = `t${++turnSeq}`;
    const patchLast = (fn: (t: LiveTurn) => LiveTurn) => patchTurn(key, fn);
    setTurns((t) => [...t, { key, run_id: "", question: message, answer: "", status: "running", events: [], feedback: null, created_at: new Date().toISOString(), streaming: true }]);
    const input: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(extra)) {
      try { const val = inputValue(extraDefs[k], v); if (val !== undefined) input[k] = val; } catch { /* 不合法的 JSON：上面已拦 */ }
    }
    const body: ChatRequest = { message, session_id: sid ?? null, service, env, task, subtask: subtask || null, input, memory };
    let runId = "";
    let seq = 0;
    stopRequested.current = false;
    cancelRef.current = stream("/v1/chat", body, (ev) => {
      const type = String(ev.type);
      if (type === "run") {
        if (stopRequested.current) {
          // 受理前就点了停止：拿到 run_id 立刻取消，再断开推流
          patchLast((t) => ({ ...t, run_id: String(ev.run_id), streaming: false, status: "cancelled" }));
          if (!sid) setSid(String(ev.session_id));
          cancelRun(String(ev.run_id));
          cancelRef.current?.();
          cancelRef.current = null;
          return;
        }
        runId = String(ev.run_id);
        patchLast((t) => ({ ...t, run_id: runId }));
        if (!sid) setSid(String(ev.session_id));
        if (ev.subtask_created) toast(`已新建子任务 ${String(ev.subtask_created)}`, { description: `${task} 的对象，档案待补` });
      } else if (type === "error" && ev.code === "stream_broken") {
        // 推流断了（库连接断开），运行没失败、还在跑：不标失败，给运行详情的链接
        patchLast((t) => ({ ...t, broken: String(ev.message), streaming: false }));
      } else if (type === "error") {
        patchLast((t) => ({ ...t, status: "failed", answer: `**${String(ev.code)}**：${String(ev.message)}`, streaming: false }));
      } else if (type === "final") {
        const out = (ev.output ?? {}) as { answer?: string; error?: string };
        patchLast((t) => ({ ...t, answer: out.answer ?? out.error ?? t.answer, status: (ev.status as LiveTurn["status"]) ?? "success", streaming: false }));
      } else if (["stage", "model_call", "thought", "tool_call", "tool_result"].includes(type)) {
        const { type: _t, ...payload } = ev;
        void _t;
        patchLast((t) => ({ ...t, events: [...t.events, { seq: Number(ev.seq) || ++seq, kind: type as RunEvent["kind"], at: new Date().toISOString(), payload } as RunEvent] }));
      }
    }, (err) => {
      // 已经受理了（有 run_id）：连接断了不等于运行失败，它在服务端照常跑，给运行详情的入口
      if (err && runId) patchLast((t) => ({ ...t, streaming: false, broken: `连接断了（${err.message}），运行还在服务端执行` }));
      else if (err) { patchLast((t) => ({ ...t, status: "failed", answer: err.message, streaming: false })); toast.error("发送失败", err.message); }
      else patchLast((t) => ({ ...t, streaming: false }));
      invalidate("sessions");
      cancelRef.current = null;
    });
  };
  const cancelRun = (runId: string) => api.cancelRun(runId)
    .catch((e: Error) => { if (!(e instanceof ApiError && e.code === "already_finished")) toast.error("取消运行失败", e.message); })
    .finally(() => invalidate("sessions"));
  /** 停止 = 取消这次运行：只断开推流的话，agent 在服务端照样跑完（还会沉淀记忆、耗 token） */
  const stop = () => {
    const live = [...turns].reverse().find((t) => t.streaming || LIVE_STATUS.has(t.status));
    if (!live) return;
    if (!live.run_id && cancelRef.current) {
      // 还没收到受理（没有 run_id）：先别断开，等 run 事件到了再取消（见 send 里的 run 分支）
      stopRequested.current = true;
      return;
    }
    if (live.streaming) { cancelRef.current?.(); cancelRef.current = null; }
    patchTurn(live.key, (t) => ({ ...t, streaming: false, status: "cancelled" }));
    if (live.run_id) void cancelRun(live.run_id);
  };

  /** 纠正：同会话开新一轮；结果轮询拿回来（离开页面就停） */
  const correct = async (runId: string, correction: string) => {
    if (busy) return;
    try {
      const acc = await api.correct(runId, correction);
      const key = `t${++turnSeq}`;
      setTurns((t) => [...t, { key, run_id: acc.run_id, question: `[纠正] ${correction}`, answer: "", status: "running", events: [], feedback: null, created_at: new Date().toISOString(), streaming: true }]);
      while (alive.current) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!alive.current) return;
        const run = await api.run(acc.run_id).catch(() => null);
        if (run && !LIVE_STATUS.has(run.status)) {
          patchTurn(key, (t) => ({ ...t, status: run.status, answer: run.output?.answer ?? run.output?.error ?? "", streaming: false }));
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
        {sid && <span className="hidden sm:inline-flex"><IdCopy value={sid} className="text-[11px]">{shortId(sid)}</IdCopy></span>}
        <div className="ml-auto flex items-center gap-2">{service && <span className="truncate">{svc?.title ?? service}</span>}{env && <EnvBadge env={env} />}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[820px] px-4 py-6 md:px-6">
          {sessionGone ? (
            <div className="pt-16 text-center">
              <div className="text-[14px] font-medium text-fg">{sessionError instanceof ApiError && sessionError.status === 404 ? "会话不存在" : "会话加载失败"}</div>
              <div className="mt-1 text-[12.5px] text-fg-3">{sessionError?.message}</div>
              <Button className="mt-4" icon={<LuPlus />} onClick={() => navigate("/chat")}>开始新对话</Button>
            </div>
          ) : sessionId && loading ? <div className="space-y-4"><Skeleton className="h-16" /><Skeleton className="h-40" /></div> : turns.length === 0 ? (
            <Welcome service={service} title={svc?.title ?? service} onPick={(q) => setText(q)} />
          ) : turns.map((t) => <Turn key={t.key} turn={t} onCorrect={busy ? undefined : (c) => correct(t.run_id, c)} />)}
          <div ref={bottom} />
        </div>
      </div>
      <div className="shrink-0 px-4 pb-5 md:px-6">
        <div className="mx-auto max-w-[820px] rounded-xl border border-line bg-panel shadow-[var(--shadow-pop)] focus-within:border-accent">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
            <Dim label="服务" locked={locked}>
              <Select size="sm" className="w-36" value={service || null} disabled={locked} onChange={(v) => { setService(v); setSubtask(""); remember({ service: v }); }}
                options={(services ?? []).filter((s) => s.enabled).map((s) => ({ value: s.name, label: s.name, hint: s.title }))} />
            </Dim>
            <Dim label="环境" locked={locked}>
              <Select size="sm" className="w-24" value={env || null} disabled={locked} onChange={(v) => { setEnv(v); remember({ env: v }); }}
                options={(envs ?? []).map((e) => ({ value: e.name, label: <span className="font-mono uppercase">{e.name}</span>, hint: svc?.health[e.name]?.enabled === false ? "该服务在此环境已停用" : e.title }))} />
            </Dim>
            <Dim label="任务" locked={locked} hint="问哪一类问题：服务上声明了「对话」触发的任务都能选，不同任务用不同的角色与档案；拿不准就用「问一下」（通用入口，什么都能问、能交代事）">
              <Select size="sm" className="w-40" value={task || null} disabled={locked} onChange={(v) => { setTask(v); setSubtask(""); setExtra({}); remember({ task: v }); }}
                placeholder="该服务没有对话任务" options={chatTasks.map(chatTaskOption)} />
            </Dim>
            {/* 通用入口 ask 不分对象（运行对话框、任务页也不给它建子任务）；锁定后只在真有对象时显示 */}
            {task && task !== ASK_TASK && (!locked || subtask) && (
              <Dim label="对象" locked={locked} hint={`可选：针对 ${taskDef?.title || task} 的某个具体对象（一个资产、一张表、一个报表）问。会带上这个对象的专属档案，沉淀的记忆也记在它名下；输入新名字会自动建一个子任务。`}>
                {locked ? <span className="font-mono text-[12px] text-fg-2">{subtask}</span> : <SubtaskPicker task={task} value={subtask} onChange={setSubtask} />}
              </Dim>
            )}
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label="消息" placeholder={envOff ? `${service} 在 ${env} 环境已停用` : `问 ${svc?.title ?? "agent"} 点什么…（Enter 发送，Shift+Enter 换行）`}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
            className="block max-h-48 w-full resize-none bg-transparent px-4 pt-3 text-[13.5px] leading-relaxed text-fg outline-none placeholder:text-fg-3" />
          <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
            <span className={cn("text-[11px]", missingExtra.length || needObject ? "text-warn" : "text-fg-3")}>
              {serverLive ? "上一轮还在执行，结束后才能接着问"
                : needObject ? `先选对象（${taskDef?.object_input}）`
                : missingExtra.length ? `先在「输入」里填 ${missingExtra.join("、")}`
                  : locked ? "同一会话内服务、环境、任务、对象固定；要换就开新对话"
                    : subtask && !(tasks ?? []).some((t) => t.name === `${task}:${subtask}`) ? `发送时会新建对象 ${subtask}（${task} 的子任务）` : ""}
            </span>
            {/* 输入 / 记忆开关放在发送按钮旁：上面一行只放 服务 / 环境 / 任务 / 对象，不会折成两行 */}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {extraFields.length > 0 && (
                <Popover align="end" trigger={
                  <span className={cn("inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12px] [&_svg]:size-3.5",
                    missingExtra.length ? "border-warn/40 bg-warn-soft text-warn" : Object.values(extra).some((v) => v !== "" && v != null && v !== false) ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-fg-2 hover:bg-hover")}>
                    <LuSlidersHorizontal />输入{missingExtra.length ? ` · ${missingExtra.length} 项必填` : ""}
                  </span>
                }>
                  <div className="w-80 space-y-3 p-3">
                    <div className="text-[12px] text-fg-3">{locked ? `${taskDef?.title || task} 的其它输入：不改就沿用上一轮的` : `${taskDef?.title || task} 的其它输入，随消息一起发送`}</div>
                    {extraFields.map(([k, f]) => (
                      <InputControl key={k} name={k} field={f} value={extra[k]} error={extraErrors[k]} onChange={(v) => setExtra({ ...extra, [k]: v })} />
                    ))}
                  </div>
                </Popover>
              )}
              <MemoryPopover task={taskDef} value={memory} onChange={(m) => { setMemory(m); remember({ recall: m.recall ?? null, save: m.save ?? null }); }} />
              {busy ? <Button size="icon-sm" variant="secondary" onClick={stop} aria-label="停止这一轮" tip="停止这一轮"><LuCircleStop /></Button>
                : <Button size="icon-sm" variant="primary" disabled={!canSend} reason={sendBlocked ?? undefined} onClick={send} aria-label="发送"><LuArrowUp /></Button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 会话里还有一轮在服务端执行（不是这个页面在推流的）：每 2 秒刷一次会话，直到它结束 */
function useSessionPoll(id: string | undefined, on: boolean) {
  useEffect(() => {
    if (!id || !on) return;
    const t = window.setInterval(() => invalidate("sessions", "one", id), 2000);
    return () => window.clearInterval(t);
  }, [id, on]);
}

/** 记忆开关：默认跟随任务 / 平台；这里改了只影响接下来的消息 */
function MemoryPopover({ task, value, onChange }: { task: TaskSummary | undefined; value: MemoryOverride; onChange: (v: MemoryOverride) => void }) {
  const { data: settings } = useSettings();
  const dflt = (k: "recall" | "save") => task?.memory?.[k] ?? settings?.memory[k];
  const eff = (k: "recall" | "save") => value[k] ?? dflt(k);
  const changed = value.recall != null || value.save != null;
  const label = eff("recall") !== false && eff("save") !== false ? "记忆" : eff("recall") === false && eff("save") === false ? "不用记忆" : eff("recall") === false ? "不召回" : "不沉淀";
  const row = (k: "recall" | "save", title: string, hint: string) => (
    <div>
      <div className="mb-1 flex items-baseline gap-1.5 text-[12.5px] text-fg">{title}<span className="text-[11.5px] text-fg-3">{hint}</span></div>
      <Segmented size="sm" value={value[k] == null ? "inherit" : value[k] ? "on" : "off"} onChange={(m) => onChange({ ...value, [k]: m === "inherit" ? null : m === "on" })}
        options={[{ value: "inherit", label: dflt(k) === undefined ? "默认" : `默认（${dflt(k) ? "开" : "关"}）` }, { value: "on", label: "开" }, { value: "off", label: "关" }]} />
    </div>
  );
  return (
    <Popover align="end" trigger={
      <span className={cn("inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12px] [&_svg]:size-3.5", changed ? "border-warn/40 bg-warn-soft text-warn" : "border-line text-fg-2 hover:bg-hover")}>
        <LuBrain />{label}
      </span>
    }>
      <div className="w-72 space-y-3 p-3">
        {row("recall", "召回", "回答前先查以前记下的")}
        {row("save", "沉淀", "回答后把结论记下来")}
        <div className="text-[11.5px] text-fg-3">默认 = 任务的设置，任务没写就用平台的（设置 → 记忆）。只影响接下来的消息。</div>
      </div>
    </Popover>
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
      <div className="mt-1 text-[13px] text-fg-3">口径以档案为准，取数只走该环境配置的只读库；每一步都能在运行详情里回放</div>
      <div className="mx-auto mt-6 grid max-w-lg gap-2 sm:grid-cols-2">
        {examples.map((e) => (
          <button key={e} type="button" onClick={() => onPick(e)} className="rounded-lg border border-line bg-panel px-3 py-2.5 text-left text-[12.5px] text-fg-2 transition-colors hover:border-accent hover:text-fg">{e}</button>
        ))}
      </div>
    </div>
  );
}

/** 回答还没拿到（推流中断、还在跑）时给的运行详情入口 */
function RunLink({ runId }: { runId: string }) {
  return <Link to={`/runs/${runId}`} className="ml-1.5 inline-flex items-center gap-1 text-accent hover:underline"><LuExternalLink className="size-3" />运行详情</Link>;
}

/** onCorrect 不给 = 现在不能纠正（会话里还有一轮在跑） */
function Turn({ turn, onCorrect }: { turn: LiveTurn; onCorrect?: (text: string) => void }) {
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
          {turn.broken ? (
            <div className="flex items-start gap-1.5 text-[12.5px] text-warn">
              <LuCircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{turn.broken}{turn.run_id && <RunLink runId={turn.run_id} />}</span>
            </div>
          ) : turn.answer ? <Markdown text={turn.answer} className={cn("text-[13.5px]", turn.status === "failed" && "text-bad")} />
              : turn.streaming ? <div className="flex gap-1 py-2" aria-label="正在回答">{[0, 1, 2].map((i) => <span key={i} className="size-1.5 animate-bounce rounded-full bg-fg-3" style={{ animationDelay: `${i * 120}ms` }} />)}</div>
                : turn.status === "cancelled" ? <div className="text-[12.5px] text-fg-3">已停止</div>
                  : turn.status === "running" ? <div className="text-[12.5px] text-fg-3">执行中…{turn.run_id && <RunLink runId={turn.run_id} />}</div> : null}
          {!turn.streaming && turn.answer && (
            <div className="mt-2 flex items-center gap-0.5 text-fg-3">
              <CopyButton text={turn.answer} />
              {turn.run_id && <FeedbackButtons key={turn.feedback?.updated_at ?? "none"} runId={turn.run_id} mine={turn.feedback} onCorrect={turn.status === "success" ? onCorrect : undefined} />}
              {turn.run_id && turn.status === "success" && onCorrect && <button type="button" onClick={() => setCorrecting(!correcting)} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] hover:bg-hover hover:text-fg"><LuPencilLine className="size-3" />纠正</button>}
              {turn.run_id && <Link to={`/runs/${turn.run_id}`} className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] hover:bg-hover hover:text-fg"><LuExternalLink className="size-3" />运行详情</Link>}
            </div>
          )}
          {correcting && (
            <div className="mt-2 space-y-2 rounded-lg border border-line bg-panel p-3">
              <Textarea rows={2} autoFocus value={correction} onChange={(e) => setCorrection(e.target.value)} placeholder="哪里不对？例如：收益要按交易日统计，不按自然日"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && correction.trim() && onCorrect) { e.preventDefault(); onCorrect(correction.trim()); setCorrecting(false); setCorrection(""); }
                }} />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11.5px] text-fg-3">在本会话开新一轮重答（Ctrl+Enter 提交）；成功后这一轮记下的东西被新的取代</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setCorrecting(false)}>取消</Button>
                  <Button size="sm" variant="primary" disabled={!correction.trim() || !onCorrect} onClick={() => { onCorrect?.(correction.trim()); setCorrecting(false); setCorrection(""); }}>提交纠正</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
