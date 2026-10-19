/**
 * 对话：会话侧栏 + 消息流 + 输入区（服务 / 环境 / 任务）。
 * 回答流式出现，过程步骤折叠在每条回答下；会话 = 同一个 LangGraph thread，多轮共享上下文。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LuArrowUp, LuChevronDown, LuChevronRight, LuCircleStop, LuExternalLink, LuMessageSquare, LuPlus, LuSparkles,
  LuThumbsDown, LuThumbsUp, LuWrench,
} from "react-icons/lu";

import { stream } from "@/api/client";
import { api, useEnvs, useServices, useSession, useSessions, useTasks } from "@/api/hooks";
import type { ChatTurn, RunEvent } from "@/api/types";
import { EnvBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { CopyButton, Markdown } from "@/components/ui/data";
import { SearchInput, Select } from "@/components/ui/form";
import { toast } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago } from "@/lib/format";
import { invalidate } from "@/lib/query";
import { Link, navigate, useParams, useSearch } from "@/lib/router";
import { useUi } from "@/lib/store";

interface LiveTurn extends ChatTurn { streaming?: boolean }

export function ChatPage() {
  const { session } = useParams<{ session?: string }>();
  const [search, setSearch] = useSearch<{ new: string }>();
  const { data: sessions } = useSessions();
  const [q, setQ] = useState("");
  useEffect(() => { if (search.new) { setSearch({ new: undefined }); navigate("/chat", { replace: true }); } }, [search.new, setSearch]);
  const list = (sessions ?? []).filter((s) => !q || s.title.includes(q));
  const groups = useMemo(() => {
    const today: typeof list = [], week: typeof list = [], older: typeof list = [];
    for (const s of list) {
      const days = (Date.now() - new Date(s.last_at).getTime()) / 86400_000;
      (days < 1 ? today : days < 7 ? week : older).push(s);
    }
    return [["今天", today], ["近 7 天", week], ["更早", older]] as const;
  }, [list]);

  return (
    <div className="flex h-full">
      <aside className="flex w-[264px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="space-y-2 p-3">
          <Button className="w-full" icon={<LuPlus />} onClick={() => navigate("/chat")}>新对话</Button>
          <SearchInput value={q} onChange={setQ} placeholder="搜索会话" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {!sessions ? <div className="space-y-2 p-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div> : groups.map(([label, items]) => items.length > 0 && (
            <div key={label} className="mb-2">
              <div className="px-2 pb-1 pt-2 text-[11px] font-semibold text-fg-3">{label}</div>
              {items.map((s) => (
                <Link key={s.session_id} to={`/chat/${s.session_id}`}
                  className={cn("block rounded-md px-2.5 py-2 hover:bg-hover", session === s.session_id && "bg-accent-soft hover:bg-accent-soft")}>
                  <div className={cn("truncate text-[13px]", session === s.session_id ? "font-medium text-accent" : "text-fg")}>{s.title}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-3">
                    <span>{s.service}</span><span className="font-mono uppercase">{s.env}</span><span>· {s.runs} 轮</span><span className="ml-auto">{ago(s.last_at)}</span>
                  </div>
                </Link>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <Conversation key={session ?? "new"} sessionId={session} />
    </div>
  );
}

function Conversation({ sessionId }: { sessionId?: string }) {
  const { data: detail, loading } = useSession(sessionId ?? "");
  const { data: services } = useServices();
  const { data: envs } = useEnvs();
  const { data: tasks } = useTasks();
  const { env: globalEnv } = useUi();
  const chatTasks = (tasks ?? []).filter((t) => !t.extends && t.enabled && t.triggers.some((tr) => tr.type === "chat"));
  const [service, setService] = useState("");
  const [env, setEnv] = useState("");
  const [task, setTask] = useState("data-qa");
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [text, setText] = useState("");
  const [sid, setSid] = useState<string | undefined>(sessionId);
  const cancelRef = useRef<(() => void) | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const streaming = turns.some((t) => t.streaming);

  useEffect(() => {
    if (detail) {
      setTurns(detail.turns);
      setService(detail.service ?? "");
      setEnv(detail.env);
      setTask(detail.task);
    }
  }, [detail]);
  useEffect(() => {
    if (!service && services?.length) setService(services.find((s) => s.enabled)?.name ?? "");
    if (!env && envs?.length) setEnv((envs.find((e) => e.name === globalEnv) ?? envs.find((e) => !e.protected) ?? envs[0]).name);
  }, [services, envs, service, env, globalEnv]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [turns]);
  useEffect(() => () => cancelRef.current?.(), []);

  const send = () => {
    const message = text.trim();
    if (!message || streaming) return;
    setText("");
    const turn: LiveTurn = { run_id: "", question: message, answer: "", status: "running", events: [], feedback: null, created_at: new Date().toISOString(), streaming: true };
    setTurns((t) => [...t, turn]);
    let seq = 0;
    const patch = (fn: (t: LiveTurn) => LiveTurn) => setTurns((all) => all.map((t, i) => (i === all.length - 1 ? fn(t) : t)));
    cancelRef.current = stream("/v1/chat", { service, env, task, message, session_id: sid ?? null }, (ev) => {
      const type = String(ev.type);
      if (type === "run") {
        patch((t) => ({ ...t, run_id: String(ev.run_id) }));
        if (!sid) setSid(String(ev.session_id));
      } else if (type === "delta") {
        patch((t) => ({ ...t, answer: (t.answer ?? "") + String(ev.content) }));
      } else if (type === "final") {
        patch((t) => ({ ...t, answer: String((ev.output as { answer?: string })?.answer ?? t.answer), status: (ev.status as "success") ?? "success", streaming: false }));
      } else if (["stage", "thought", "tool_call", "tool_result"].includes(type)) {
        const { type: _t, ...payload } = ev;
        void _t;
        patch((t) => ({ ...t, events: [...t.events, { seq: ++seq, kind: type as RunEvent["kind"], at: new Date().toISOString(), payload } as RunEvent] }));
      }
    }, (err) => {
      if (err) { patch((t) => ({ ...t, status: "failed", answer: err.message, streaming: false })); toast.error("发送失败", err.message); }
      else patch((t) => ({ ...t, streaming: false }));
      invalidate("sessions");
      cancelRef.current = null;
    });
  };
  const stop = () => {
    cancelRef.current?.();
    setTurns((all) => all.map((t, i) => (i === all.length - 1 ? { ...t, streaming: false, status: "cancelled" } : t)));
  };

  const svc = services?.find((s) => s.name === service);
  return (
    <div className="flex min-w-0 flex-1 flex-col bg-bg">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel/60 px-5 text-[12.5px] text-fg-3">
        <LuMessageSquare className="size-4" />
        <span className="truncate text-fg">{detail?.title ?? (turns[0]?.question.slice(0, 40) || "新对话")}</span>
        {sid && <span className="font-mono text-[11px]">{sid.slice(0, 12)}</span>}
        <div className="ml-auto flex items-center gap-2">{service && <span>{svc?.title ?? service}</span>}{env && <EnvBadge env={env} />}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[820px] px-6 py-6">
          {sessionId && loading ? <div className="space-y-4"><Skeleton className="h-16" /><Skeleton className="h-40" /></div> : turns.length === 0 ? (
            <Welcome service={svc?.title ?? service} onPick={(q) => setText(q)} />
          ) : turns.map((t, i) => <Turn key={t.run_id || i} turn={t} />)}
          <div ref={bottom} />
        </div>
      </div>
      <div className="shrink-0 px-6 pb-5">
        <div className="mx-auto max-w-[820px] rounded-xl border border-line bg-panel shadow-[var(--shadow-pop)] focus-within:border-accent">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder={`问 ${svc?.title ?? "agent"} 点什么… （Enter 发送，Shift+Enter 换行）`}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
            className="block max-h-48 w-full resize-none bg-transparent px-4 pt-3 text-[13.5px] leading-relaxed text-fg outline-none placeholder:text-fg-3" />
          <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
            <div className="w-36"><Select size="sm" value={service || null} onChange={setService} disabled={turns.length > 0} options={(services ?? []).filter((s) => s.enabled).map((s) => ({ value: s.name, label: s.title }))} /></div>
            <div className="w-24"><Select size="sm" value={env || null} onChange={setEnv} disabled={turns.length > 0} options={(envs ?? []).filter((e) => e.enabled).map((e) => ({ value: e.name, label: <span className="font-mono uppercase">{e.name}</span> }))} /></div>
            {chatTasks.length > 1 && <div className="w-40"><Select size="sm" value={task} onChange={setTask} disabled={turns.length > 0} options={chatTasks.map((t) => ({ value: t.name, label: t.title || t.name }))} /></div>}
            {turns.length > 0 && <span className="text-[11px] text-fg-3">同一会话内服务与环境固定</span>}
            <div className="ml-auto">
              {streaming ? <Button size="icon-sm" variant="secondary" onClick={stop} aria-label="停止"><LuCircleStop /></Button>
                : <Button size="icon-sm" variant="primary" disabled={!text.trim() || !service} onClick={send} aria-label="发送"><LuArrowUp /></Button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Welcome({ service, onPick }: { service: string; onPick: (q: string) => void }) {
  const examples = ["上周 GMV 环比为什么下跌？", "退款率指标的口径是什么？", "近 7 天每天的订单量", "dwd_trade_order 昨天行数正常吗？"];
  return (
    <div className="pt-16 text-center">
      <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent"><LuSparkles className="size-5" /></div>
      <div className="mt-4 text-[17px] font-semibold text-fg">问 {service || "agent"}</div>
      <div className="mt-1 text-[13px] text-fg-3">口径以服务档案为准，取数只走该环境的只读库；每一步都可以在运行详情里回放</div>
      <div className="mx-auto mt-6 grid max-w-lg grid-cols-2 gap-2">
        {examples.map((e) => (
          <button key={e} type="button" onClick={() => onPick(e)} className="rounded-lg border border-line bg-panel px-3 py-2.5 text-left text-[12.5px] text-fg-2 transition-colors hover:border-accent hover:text-fg">{e}</button>
        ))}
      </div>
    </div>
  );
}

function Turn({ turn }: { turn: LiveTurn }) {
  const [open, setOpen] = useState(false);
  const [fb, setFb] = useState(turn.feedback ?? 0);
  const steps = turn.events.filter((e) => e.kind === "thought" || e.kind === "tool_call");
  const sendFb = async (s: number) => {
    const next = fb === s ? 0 : s;
    setFb(next);
    if (next && turn.run_id) await api.runFeedback(turn.run_id, next);
  };
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
              {turn.events.map((e) => (
                <div key={e.seq} className="text-[12px]">
                  {e.kind === "thought" && <div className="flex gap-1.5 text-fg-2"><LuSparkles className="mt-0.5 size-3 shrink-0 text-accent" />{String(e.payload.content)}</div>}
                  {e.kind === "tool_call" && <div className="flex gap-1.5 font-mono text-fg-2"><LuWrench className="mt-0.5 size-3 shrink-0 text-info" />{String(e.payload.tool)} <span className="truncate text-fg-3">{JSON.stringify(e.payload.args).slice(0, 100)}</span></div>}
                  {e.kind === "tool_result" && <pre className="ml-4 max-h-32 overflow-auto rounded bg-sunken px-2 py-1 font-mono text-[11px] text-fg-3">{String(e.payload.output)}</pre>}
                  {e.kind === "stage" && <div className="text-fg-3">· {String(e.payload.title ?? e.payload.stage)} {String(e.payload.content ?? "")}</div>}
                </div>
              ))}
            </div>
          )}
          {turn.answer ? <Markdown text={turn.answer} className={cn("text-[13.5px]", turn.status === "failed" && "text-bad")} />
            : turn.streaming ? <div className="flex gap-1 py-2">{[0, 1, 2].map((i) => <span key={i} className="size-1.5 animate-bounce rounded-full bg-fg-3" style={{ animationDelay: `${i * 120}ms` }} />)}</div>
              : turn.status === "cancelled" ? <div className="text-[12.5px] text-fg-3">已停止</div>
                : turn.status === "awaiting_approval" ? <div className="text-[12.5px] text-warn">等待审批，通过后继续</div>
                  : turn.status === "running" ? <div className="text-[12.5px] text-fg-3">执行中…</div> : null}
          {!turn.streaming && turn.answer && (
            <div className="mt-2 flex items-center gap-0.5 text-fg-3">
              <CopyButton text={turn.answer} />
              <button type="button" onClick={() => sendFb(1)} className={cn("rounded p-1 hover:bg-hover", fb > 0 && "text-ok")}><LuThumbsUp className="size-3.5" /></button>
              <button type="button" onClick={() => sendFb(-1)} className={cn("rounded p-1 hover:bg-hover", fb < 0 && "text-bad")}><LuThumbsDown className="size-3.5" /></button>
              {turn.run_id && <Link to={`/runs/${turn.run_id}`} className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] hover:bg-hover hover:text-fg"><LuExternalLink className="size-3" />运行详情</Link>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

