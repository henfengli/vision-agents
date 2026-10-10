// Run 详情：状态轮询 + Langfuse trace 内嵌 + 时间线（节点级反馈）+ 重跑。
//
// 区块顺序：头部（状态+重跑）→ ⏸ 待审批横幅 → Langfuse trace 卡（可内嵌
// 则 iframe，否则外链说明）→ 输入 → 自研轨迹图（仅 trace 不可内嵌时）→
// 时间线（始终渲染：每步 👍👎 节点级反馈的载体）→ 最终输出 → run 级反馈。

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ExternalLink, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react";
import { api } from "@/lib/api";
import type { RunDetail, RunEvent } from "@/lib/api";
import { JsonBlock, PageHead, StatusPill } from "@/components/common";
import CyGraph from "@/components/CyGraph";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const KIND_LABEL: Record<string, string> = {
  thought: "思考", tool_call: "工具调用", tool_result: "工具结果",
  llm: "结论", final: "结论", note: "备注", trace: "trace",
};
const KIND_COLOR: Record<string, string> = {
  thought: "border-l-violet-400", tool_call: "border-l-amber-400",
  tool_result: "border-l-emerald-400", llm: "border-l-blue-400",
  final: "border-l-blue-400", note: "border-l-border",
  trace: "border-l-border",
};

export default function RunDetailPage() {
  const { runId = "" } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState<RunDetail | null>(null);
  const [err, setErr] = useState("");

  // 轮询：终态后停止。用 ref 持定时器，卸载即清。
  const timer = useRef<ReturnType<typeof setTimeout>>(null);
  const load = useCallback(async () => {
    try {
      const detail = await api.runDetail(runId);
      setD(detail);
      if (detail.run.status === "queued" || detail.run.status === "running") {
        timer.current = setTimeout(load, 2000);
      }
    } catch (e) {
      setErr(String(e));
    }
  }, [runId]);
  useEffect(() => {
    load();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [load]);

  if (err) return <p className="text-destructive">{err}</p>;
  if (!d) return <p className="text-muted-foreground">加载中…</p>;

  const terminal = d.run.status === "success" || d.run.status === "failed";

  return (
    <div className="space-y-4">
      <PageHead
        eyebrow={`RUN · ${d.run.task_type}`}
        title={d.run.run_id}
        meta={`任务 ${d.run.task_type} v${d.run.task_version ?? "?"} · 角色 ` +
              `${d.run.role} v${d.run.role_version ?? "?"} · 来源 ` +
              `${d.run.trigger_source}` +
              (d.run.target_env ? ` · 目标环境 ${d.run.target_env}` : "") +
              ` · 耗时 ${d.run.duration_ms ?? "-"}ms · ${d.created_at}`}
        right={
          <div className="flex items-center gap-3">
            <StatusPill status={d.run.status} />
            {terminal && (
              <Button size="sm" variant="outline" onClick={async () => {
                try {
                  const r = await api.rerun(runId);
                  nav(`/runs/${r.run_id}`);
                } catch (e) { alert(`无法重跑：${e}`); }
              }}>
                <RotateCcw className="size-3.5 mr-1" />
                {d.run.status === "failed" ? "重跑（断点续跑）" : "重跑"}
              </Button>
            )}
          </div>
        } />

      {d.pending && (
        <Card className="border-amber-500/50 bg-amber-500/5">
          <CardContent className="py-3 text-sm">
            ⏸ 待审批：<code className="font-mono text-xs">
              {d.pending.command}</code>{" "}
            — 到 <Link to="/approvals"
              className="text-cyan-400 hover:underline">审批台</Link> 放行或拒绝
          </CardContent>
        </Card>
      )}

      {d.trace?.url && d.trace.embed ? (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-xs text-muted-foreground font-normal
                                  flex justify-between">
              <span>Langfuse trace（{d.trace.publish
                ? "公开链接 · 免登" : "登录会话 · Annotate 可用"}）</span>
              <a href={d.trace.url} target="_blank" rel="noreferrer"
                 className="text-cyan-400 hover:underline flex items-center
                            gap-1">
                新窗口打开 <ExternalLink className="size-3" />
              </a>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <iframe src={d.trace.url} title="Langfuse trace"
                    className="w-full h-[72vh] min-h-[480px] rounded-md
                               border border-border bg-[#0b1020]" />
          </CardContent>
        </Card>
      ) : d.trace?.url ? (
        <Card><CardContent className="py-3 text-sm">
          <b>Langfuse 暂不可内嵌</b>
          <p className="text-xs text-muted-foreground mt-1">
            在 Langfuse 反向代理剥掉
            <code> proxy_hide_header X-Frame-Options;</code> 与 CSP 后自动内嵌。
            现在：<a href={d.trace.url} target="_blank" rel="noreferrer"
                    className="text-cyan-400 hover:underline">
              新窗口打开完整 trace ↗</a>
          </p>
        </CardContent></Card>
      ) : null}

      <Card>
        <CardHeader className="py-3"><CardTitle className="text-sm">输入</CardTitle></CardHeader>
        <CardContent><JsonBlock value={d.run.input} /></CardContent>
      </Card>

      {!d.trace?.embed && d.graph && d.graph.nodes.length > 0 && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">执行轨迹</CardTitle>
          </CardHeader>
          <CardContent>
            <CyGraph graph={d.graph}
                     onNodeTap={(id) => document.getElementById(id)
                       ?.scrollIntoView({ behavior: "smooth", block: "center" })} />
            <p className="text-xs text-muted-foreground mt-2">
              绿=已执行 · 黄=进行中 · 红=失败点 · 点击节点跳到对应步骤
            </p>
          </CardContent>
        </Card>
      )}

      <div>
        <h3 className="text-sm font-semibold mt-6 mb-1">执行过程</h3>
        <p className="text-xs text-muted-foreground mb-3">
          每步可 👍👎 留反馈（节点级，回写 Langfuse 对应 span）
        </p>
        <div className="space-y-2">
          {d.events.filter((e) => e.kind !== "graph").map((e) => (
            <Step key={e.seq} ev={e} runId={runId} />
          ))}
        </div>
      </div>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">最终输出</CardTitle>
        </CardHeader>
        <CardContent><JsonBlock value={d.run.output} /></CardContent>
      </Card>

      <RunFeedback runId={runId} />
    </div>
  );
}

function Step({ ev, runId }: { ev: RunEvent; runId: string }) {
  const [voted, setVoted] = useState<0 | 1 | -1>(0);
  return (
    <div id={`seq-${ev.seq}`}
         className={`rounded-md border border-border border-l-2
                     ${KIND_COLOR[ev.kind] ?? "border-l-border"}
                     bg-card px-3 py-2`}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">#{ev.seq}</span>
        <span>{KIND_LABEL[ev.kind] ?? ev.kind}</span>
        {ev.tool && <span className="font-mono text-cyan-400">{ev.tool}</span>}
        <span className="ml-auto">{String(ev.created_at).slice(0, 19)}</span>
        <button title="这步做得好" disabled={voted !== 0}
          className="hover:scale-110 disabled:opacity-40 transition"
          onClick={async () => {
            await api.stepFeedback(runId, ev.seq, 1); setVoted(1);
          }}>👍</button>
        <button title="这步有问题" disabled={voted !== 0}
          className="hover:scale-110 disabled:opacity-40 transition"
          onClick={async () => {
            await api.stepFeedback(runId, ev.seq, -1); setVoted(-1);
          }}>👎</button>
        {voted !== 0 && <span className="text-emerald-400">✓</span>}
      </div>
      {ev.text && (
        <pre className="mt-1.5 text-xs font-mono whitespace-pre-wrap
                        break-all">{ev.text}</pre>)}
    </div>
  );
}

function RunFeedback({ runId }: { runId: string }) {
  const [comment, setComment] = useState("");
  const [done, setDone] = useState(false);
  if (done) {
    return <Card><CardContent className="py-3 text-sm text-emerald-400">
      已记录，感谢。</CardContent></Card>;
  }
  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm">这个结论有帮助吗？</CardTitle>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button size="sm" variant="outline"
                className="text-emerald-400 border-emerald-500/40"
                onClick={async () => {
                  await api.runFeedback(runId, 1, comment); setDone(true);
                }}>
          <ThumbsUp className="size-3.5 mr-1" /> 有用
        </Button>
        <Button size="sm" variant="outline"
                className="text-red-400 border-red-500/40"
                onClick={async () => {
                  await api.runFeedback(runId, -1, comment); setDone(true);
                }}>
          <ThumbsDown className="size-3.5 mr-1" /> 有问题
        </Button>
        <Input className="flex-1" placeholder="补充说明（可选）"
               value={comment} onChange={(e) => setComment(e.target.value)} />
      </CardContent>
    </Card>
  );
}
