/**
 * 反馈：对整次运行（step=0）或其中一步的 👍👎。
 *
 * - 👍 一点即存，再点撤回（只留档；记忆的召回权重只看 👎）。
 * - 👎 打开面板：选问题类型（可多选）+ 写说明；整次运行还可以勾选"按这条意见让 agent 重答"（= 纠正）。
 * - 一人一步一条，再提交就是改；面板里能撤回。
 *
 * mine 是当前用户已有的评价；保存后通过 onSaved 交回，由调用方决定刷新什么。
 */
import { useState } from "react";
import { LuThumbsDown, LuThumbsUp } from "react-icons/lu";

import { api, useMeta } from "@/api/hooks";
import type { FeedbackEntry, FeedbackReason } from "@/api/types";
import { Button } from "./ui/button";
import { Checkbox, Textarea } from "./ui/form";
import { Popover, Tooltip, toast } from "./ui/overlay";
import { cn } from "@/lib/cn";
import { ago } from "@/lib/format";

export function useReasonLabel() {
  const { data: meta } = useMeta();
  return (r: string) => meta?.feedback_reasons.find((x) => x.value === r)?.label ?? r;
}

export function FeedbackButtons({ runId, step = 0, mine, onSaved, onCorrect, size = "md", className }: {
  runId: string;
  step?: number;
  mine: FeedbackEntry | null | undefined;
  onSaved?: (entry: FeedbackEntry | null) => void;
  onCorrect?: (text: string) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const [current, setCurrent] = useState<FeedbackEntry | null>(mine ?? null);
  const label = useReasonLabel();
  const icon = size === "sm" ? "size-3" : "size-3.5";
  const btn = cn("rounded hover:bg-hover", size === "sm" ? "p-1" : "p-1.5");

  const save = (entry: FeedbackEntry | null) => {
    setCurrent(entry);
    onSaved?.(entry);
  };

  const thumbUp = async () => {
    try {
      if (current?.score === 1) {
        await api.unrate(runId, step);
        save(null);
      } else {
        save(await api.rate(runId, step, { score: 1, reasons: [], comment: "" }));
        if (!step) toast("已标记为有用");
      }
    } catch (e) { toast.error("反馈失败", (e as Error).message); }
  };

  const negativeHint = current?.score === -1
    ? [current.reasons.map(label).join("、"), current.comment].filter(Boolean).join("：") || "已标记为有问题"
    : "有问题";

  return (
    <span className={cn("inline-flex items-center gap-0.5 text-fg-3", className)} onClick={(e) => e.stopPropagation()}>
      <Tooltip content={current?.score === 1 ? "已标记有用（再点撤回）" : "有用"}>
        <button type="button" onClick={thumbUp} className={cn(btn, current?.score === 1 && "text-ok")} aria-label="有用"><LuThumbsUp className={icon} /></button>
      </Tooltip>
      <Popover align="end" trigger={
        <Tooltip content={negativeHint}>
          <span role="button" tabIndex={0} aria-label="有问题" className={cn(btn, "inline-flex", current?.score === -1 && "text-bad")}><LuThumbsDown className={icon} /></span>
        </Tooltip>
      }>
        {(close) => <NegativeForm runId={runId} step={step} current={current} onCorrect={onCorrect}
          onDone={(entry) => { save(entry); close(); }} />}
      </Popover>
    </span>
  );
}

function NegativeForm({ runId, step, current, onCorrect, onDone }: {
  runId: string; step: number; current: FeedbackEntry | null; onCorrect?: (text: string) => void; onDone: (e: FeedbackEntry | null) => void;
}) {
  const { data: meta } = useMeta();
  const editing = current?.score === -1;
  const [reasons, setReasons] = useState<FeedbackReason[]>(editing ? current.reasons : []);
  const [comment, setComment] = useState(editing ? current.comment : "");
  const [redo, setRedo] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggle = (r: FeedbackReason) => setReasons(reasons.includes(r) ? reasons.filter((x) => x !== r) : [...reasons, r]);
  const valid = reasons.length > 0 || comment.trim().length > 0;

  const submit = async () => {
    setBusy(true);
    try {
      const entry = await api.rate(runId, step, { score: -1, reasons, comment: comment.trim() });
      if (redo && onCorrect && comment.trim()) onCorrect(comment.trim());
      toast(editing ? "反馈已更新" : "已记录反馈", { description: step ? "单步反馈只留档，供改进角色时回看" : "这次运行记下的、召回的记忆会扣分，召回时排在后面" });
      onDone(entry);
    } catch (e) { toast.error("反馈失败", (e as Error).message); } finally { setBusy(false); }
  };
  const withdraw = async () => {
    setBusy(true);
    try { await api.unrate(runId, step); toast("已撤回"); onDone(null); } catch (e) { toast.error("撤回失败", (e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="w-80 space-y-3 p-3">
      <div className="text-[12.5px] font-medium text-fg">{step ? `第 ${step} 步哪里有问题？` : "哪里有问题？"}</div>
      <div className="flex flex-wrap gap-1.5">
        {(meta?.feedback_reasons ?? []).filter((r) => step || r.value !== "wrong_tool").map((r) => (
          <button key={r.value} type="button" onClick={() => toggle(r.value)}
            className={cn("h-6 rounded-full border px-2.5 text-[12px] transition-colors",
              reasons.includes(r.value) ? "border-bad/40 bg-bad-soft text-bad" : "border-line text-fg-2 hover:bg-hover")}>
            {r.label}
          </button>
        ))}
      </div>
      <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)}
        placeholder={step ? "例如：这里应该查 ods 层而不是 dwd 层" : "说说正确的应该是什么，例如：GMV 不扣退款，按支付日统计"} />
      {onCorrect && !step && (
        <Checkbox checked={redo} onChange={setRedo} disabled={!comment.trim()}
          label="按这条意见让 agent 重答" hint="在同一会话开新一轮（纠正），意见会记成人工记忆" />
      )}
      <div className="flex items-center gap-2">
        {editing && <span className="text-[11px] text-fg-3">{ago(current.updated_at)}提交</span>}
        <div className="ml-auto flex gap-2">
          {editing && <Button size="sm" variant="ghost" disabled={busy} onClick={withdraw}>撤回</Button>}
          <Button size="sm" variant="primary" disabled={!valid} loading={busy} onClick={submit}>{editing ? "更新" : "提交"}</Button>
        </div>
      </div>
    </div>
  );
}

/** 一条反馈的只读展示：谁、对哪一步、什么问题、怎么说 */
export function FeedbackItem({ entry, showStep = true, extra }: { entry: FeedbackEntry; showStep?: boolean; extra?: React.ReactNode }) {
  const label = useReasonLabel();
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        {entry.score > 0 ? <LuThumbsUp className="size-3.5 text-ok" /> : <LuThumbsDown className="size-3.5 text-bad" />}
        <span className="font-medium text-fg">{entry.created_by}</span>
        {showStep && <span className="text-fg-3">{entry.step_seq ? `第 ${entry.step_seq} 步` : "整次运行"}</span>}
        {extra}
        <span className="ml-auto text-[11px] text-fg-3">{ago(entry.updated_at)}</span>
      </div>
      {entry.reasons.length > 0 && (
        <div className="flex flex-wrap gap-1">{entry.reasons.map((r) => <span key={r} className="rounded-full bg-bad-soft px-2 py-0.5 text-[11px] text-bad">{label(r)}</span>)}</div>
      )}
      {entry.comment && <div className="whitespace-pre-wrap text-[12.5px] text-fg-2">{entry.comment}</div>}
    </div>
  );
}
