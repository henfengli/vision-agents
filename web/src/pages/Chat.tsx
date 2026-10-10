// 对话页：SSE 流式。每次问答生成一个 Run（可跳详情）。

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "@/lib/api";
import type { Meta } from "@/lib/api";
import { PageHead } from "@/components/common";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

interface Msg {
  role: "user" | "thought" | "tool_call" | "tool_result" | "final" | "run";
  label: string; text: string; runId?: string;
}

export default function ChatPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [server, setServer] = useState("");
  const [env, setEnv] = useState("");
  const [role, setRole] = useState("data_searcher");
  const [session, setSession] = useState("");
  const [q, setQ] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.meta().then((m) => {
      setMeta(m);
      if (m.domains.length) setServer(m.domains[0]);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  const push = (m: Msg) => setMsgs((prev) => [...prev, m]);

  async function send() {
    const question = q.trim();
    if (!question || busy) return;
    setQ("");
    setBusy(true);
    push({ role: "user", label: "我", text: question });
    try {
      const resp = await api.chatStream({
        server, role, question, env: env || null,
        session_id: session || null,
      });
      const reader = resp.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop()!;
        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          const ev = JSON.parse(part.slice(6));
          if (ev.type === "run") {
            setSession(ev.session_id);
            push({ role: "run", label: "run", text: ev.run_id,
                   runId: ev.run_id });
          } else if (ev.type === "thought") {
            push({ role: "thought", label: "思考", text: ev.content });
          } else if (ev.type === "tool_call") {
            push({ role: "tool_call", label: `工具 · ${ev.tool}`,
                   text: ev.args });
          } else if (ev.type === "tool_result") {
            push({ role: "tool_result", label: `结果 · ${ev.tool}`,
                   text: ev.output });
          } else if (ev.type === "final") {
            push({ role: "final", label: "结论",
                   text: JSON.stringify(ev.output, null, 2) });
          }
        }
      }
    } catch (e) {
      push({ role: "final", label: "错误", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHead eyebrow="CHAT" title="Agent 对话"
                meta="流式输出 · 每次问答生成一个 Run，可点击跳转详情" />
      <Card className="mb-4"><CardContent className="pt-4 flex gap-2">
        {meta && meta.domains.length > 0 && (
          <Select value={server} onValueChange={setServer}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              {meta.domains.map((d) => (
                <SelectItem key={d} value={d}>{d}</SelectItem>))}
            </SelectContent>
          </Select>
        )}
        {meta && meta.target_envs.length > 0 && (
          <Select value={env || "__default__"}
                  onValueChange={(v) => setEnv(v === "__default__" ? "" : v)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">目标环境：默认</SelectItem>
              {meta.target_envs.map((e) => (
                <SelectItem key={e} value={e}>{e}</SelectItem>))}
            </SelectContent>
          </Select>
        )}
        <Input className="w-40" value={role} placeholder="角色"
               onChange={(e) => setRole(e.target.value)} />
        <Input className="flex-1 font-mono text-xs" value={session}
               placeholder="session_id（留空自动新建）"
               onChange={(e) => setSession(e.target.value)} />
      </CardContent></Card>

      <div className="space-y-2 mb-4 min-h-40">
        {msgs.map((m, i) => (
          <div key={i} className={
            m.role === "user"
              ? "ml-16 rounded-lg border border-cyan-500/30 bg-cyan-500/5 px-4 py-2"
              : "rounded-md border border-border bg-card px-3 py-2"}>
            <div className="text-xs font-mono text-muted-foreground mb-1">
              {m.role === "run" && m.runId ? (
                <Link to={`/runs/${m.runId}`}
                      className="text-cyan-400 hover:underline">
                  run {m.runId.slice(0, 8)}
                </Link>
              ) : m.label}
            </div>
            <pre className="text-sm whitespace-pre-wrap break-all">{m.text}</pre>
          </div>
        ))}
        {busy && <p className="text-xs text-muted-foreground">思考中…</p>}
        <div ref={bottomRef} />
      </div>

      <Card><CardContent className="pt-4">
        <Input placeholder="输入问题，回车发送" value={q} disabled={busy}
               onChange={(e) => setQ(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && send()} />
      </CardContent></Card>
    </div>
  );
}
