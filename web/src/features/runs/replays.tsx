/**
 * 回归重放：改完提示词 / 任务定义 / 档案后，拿被 👎 的运行用当前定义重跑，看问题改好没有。
 * 只看 👎：被指出问题的运行自带"错在哪"（问题类型 + 说明），正好当判卷标准；
 * 模型对照"原答案 + 人指出的问题 + 新答案"给出判定。
 *
 * - ReplayList          运行页「回归重放」标签：重放批次列表
 * - ReplayDetailPage    /replays/:id：逐条并排看原答案与新答案、判定与理由；有没判完的每 5 秒刷新
 * - StartReplayDialog   发起：反馈收件箱带上当前筛选，运行详情点名一条
 */
import { useEffect, useState, type ReactNode } from "react";
import { LuArrowUpRight, LuFlaskConical, LuNotebookPen, LuRefreshCw, LuScale, LuThumbsDown } from "react-icons/lu";

import { ApiError } from "@/api/client";
import { api, useReplay, useReplays } from "@/api/hooks";
import type { Recipe, ReplayCounts, ReplayFilter, ReplayItem, ReplayRequest, ReplaySide, ReplayVerdict, RunStatus } from "@/api/types";
import { Page, PageHeader } from "@/components/layout/shell";
import { EnvBadge, REPLAY_VERDICT, RunStatusBadge, VerdictBadge } from "@/components/status";
import { Button, LinkButton } from "@/components/ui/button";
import { Markdown } from "@/components/ui/data";
import { Field, Input, Segmented, Textarea } from "@/components/ui/form";
import { Dialog, Tooltip, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, Dot, Empty, ErrorState, Skeleton, SkeletonRows, type Tone } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, datetime, shortId } from "@/lib/format";
import { invalidate, setQueryData, useMutation } from "@/lib/query";
import { Link, navigate, useParams, useSearch } from "@/lib/router";

const LIVE: RunStatus[] = ["queued", "running"];
const TONE_TEXT: Partial<Record<Tone, string>> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", idle: "text-fg-2", info: "text-info" };

// ———————— 计数 / 选样条件 ————————

/** 计数里的 unclear 已含 error（都是"判断不了"一类，灰色） */
const COUNTS: { key: Exclude<keyof ReplayCounts, "total">; verdict: ReplayVerdict | "pending"; bar: string }[] = [
  { key: "fixed", verdict: "fixed", bar: "bg-ok" },
  { key: "same", verdict: "same", bar: "bg-warn" },
  { key: "worse", verdict: "worse", bar: "bg-bad" },
  { key: "unclear", verdict: "unclear", bar: "bg-idle" },
  { key: "pending", verdict: "pending", bar: "bg-info/40" },
];

export function ReplayCountBadges({ counts, className }: { counts: ReplayCounts; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {COUNTS.filter((c) => counts[c.key] > 0).map((c) => {
        const v = REPLAY_VERDICT[c.verdict];
        return <Badge key={c.key} tone={v.tone} icon={v.icon}><span className="tabular-nums">{counts[c.key]}</span> {v.label}</Badge>;
      })}
      <span className="text-[11.5px] tabular-nums text-fg-3">共 {counts.total} 条</span>
    </div>
  );
}

/** 判定分布条：绿 / 琥珀 / 红 / 灰 / 淡蓝（判定中） */
function VerdictBar({ counts, className }: { counts: ReplayCounts; className?: string }) {
  return (
    <div className={cn("flex h-1.5 w-full overflow-hidden rounded-full bg-sunken", className)}>
      {counts.total > 0 && COUNTS.map((c) => counts[c.key] > 0 && (
        <div key={c.key} className={c.bar} style={{ width: `${(counts[c.key] / counts.total) * 100}%` }} />
      ))}
    </div>
  );
}

function filterChips(f: ReplayFilter): string[] {
  const named = !!f.run_ids?.length;
  const out: string[] = [];
  if (named) out.push(f.run_ids!.length === 1 ? `点名运行 ${shortId(f.run_ids![0])}` : `点名 ${f.run_ids!.length} 条运行`);
  if (f.task) out.push(`任务 ${f.task}`);
  if (f.service) out.push(`服务 ${f.service}`);
  if (f.env) out.push(`环境 ${f.env}`);
  if (f.hours) out.push(f.hours % 24 === 0 ? `最近 ${f.hours / 24} 天` : `最近 ${f.hours} 小时`);
  if (f.limit && !named) out.push(`最多 ${f.limit} 条`);
  return out;
}

function FilterChips({ filter, className, empty = "全部被 👎 的 agent 运行" }: { filter: ReplayFilter; className?: string; empty?: string }) {
  const chips = filterChips(filter);
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {chips.length === 0 && <span className="text-[11.5px] text-fg-3">{empty}</span>}
      {chips.map((c) => <span key={c} className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-fg-2">{c}</span>)}
    </span>
  );
}

// ———————— 列表（运行页「回归重放」标签） ————————

export function ReplayList() {
  const { data, loading, error, refetch } = useReplays({ refetchInterval: 10_000 });
  if (error) return <Card><ErrorState error={error} onRetry={refetch} /></Card>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-fg-3">
        <LuFlaskConical className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">改完提示词 / 任务定义 / 档案后，拿被 👎 的运行用当前定义重跑；模型对照原答案、人指出的问题和新答案判定改好没有。</span>
        <LinkButton size="sm" to="/runs?view=feedback" icon={<LuThumbsDown />}>去反馈里发起</LinkButton>
      </div>
      <Card>
        {loading && !data ? <SkeletonRows /> : !data?.length ? (
          <Empty icon={<LuFlaskConical />} title="还没有回归重放"
            description="在「反馈」里筛出要验证的 👎（服务 / 环境 / 任务），点「用当前定义重放」；也可以在被 👎 的运行详情里单独重放一条。" />
        ) : (
          <ul className="divide-y divide-line">
            {data.map((r) => (
              <li key={r.id}>
                <Link to={`/replays/${r.id}`} className="group block px-4 py-3 hover:bg-hover/70">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0 truncate text-[13.5px] font-medium text-fg group-hover:text-accent" title={r.title || undefined}>{r.title || `回归重放 #${r.id}`}</span>
                    <span className="font-mono text-[11.5px] text-fg-3">#{r.id}</span>
                    {r.counts.pending > 0 && <span className="flex items-center gap-1 text-[11.5px] text-info"><Dot tone="info" pulse />判定中</span>}
                    <span className="ml-auto text-[11.5px] text-fg-3">{r.created_by} · <span title={datetime(r.created_at, true)}>{ago(r.created_at)}</span></span>
                  </div>
                  {r.note && <div className="mt-1 line-clamp-2 text-[12.5px] text-fg-2">{r.note}</div>}
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                    <ReplayCountBadges counts={r.counts} />
                    <FilterChips filter={r.filter} className="ml-auto" />
                  </div>
                  <VerdictBar counts={r.counts} className="mt-2.5" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** /replays 直接回到运行页的「回归重放」标签 */
export function ReplaysRedirect() {
  useEffect(() => { navigate("/runs?view=replays", { replace: true }); }, []);
  return null;
}

// ———————— 发起 ————————

/**
 * 发起一次重放。preset：反馈收件箱传当前的服务 / 环境 / 任务 / 时间筛选；运行详情传 {run_ids: [id]}。
 * 成功后跳到详情；没有符合条件的 👎 运行时后端返回 400 nothing_to_replay。
 */
export function StartReplayDialog({ open, onClose, preset, hint }: { open: boolean; onClose: () => void; preset: ReplayRequest; hint?: ReactNode }) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [limit, setLimit] = useState("20");
  useEffect(() => {
    if (!open) return;
    setTitle(""); setNote(""); setLimit(String(preset.limit ?? 20));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const named = !!preset.run_ids?.length;
  const n = Math.min(100, Math.max(1, Number(limit) || 20));

  const start = useMutation(async () => {
    const body: ReplayRequest = { ...preset, ...(named ? {} : { limit: n }) };
    if (title.trim()) body.title = title.trim();
    if (note.trim()) body.note = note.trim();
    try {
      const r = await api.startReplay(body);
      invalidate("replays");
      onClose();
      toast(`已发起 ${r.counts.total} 条重放`, { description: "重放运行结束后自动判定，详情页每 5 秒刷新" });
      navigate(`/replays/${r.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "nothing_to_replay") {
        toast.error("没有可重放的运行", named ? "这条运行没有被 👎，或者不是 agent 运行" : "当前筛选下没有被 👎 的 agent 运行，放宽服务 / 环境 / 任务 / 时间试试");
      } else {
        toast.error("发起失败", (e as Error).message);
      }
    }
  });

  return (
    <Dialog open={open} onClose={onClose} title="用当前定义重放"
      description="拿被 👎 的运行，用现在的提示词 / 任务定义 / 档案重跑一遍（新会话、不沉淀记忆、不投递）；模型对照原答案、人指出的问题和新答案，判定问题改好没有。"
      footer={<>
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon={<LuFlaskConical />} loading={start.pending} onClick={() => start.mutate(undefined)}>开始重放</Button>
      </>}>
      <div className="space-y-4">
        <div className="rounded-md border border-line bg-sunken/50 px-3 py-2.5">
          <div className="mb-1.5 text-[11.5px] font-medium text-fg-3">重放范围</div>
          <FilterChips filter={{ ...preset, limit: named ? undefined : n }} />
          {hint && <div className="mt-1.5 text-[11.5px] text-fg-3">{hint}</div>}
        </div>
        {!named && (
          <Field label="最多条数" help="1~100，最近被 👎 的在前">
            <Input className="w-24" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ""))} />
          </Field>
        )}
        <Field label="标题" help="不填按范围自动生成，如「data-qa · vision-board · 12 条 👎」">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="data_searcher 提示词 v5 回归" />
        </Field>
        <Field label="这次改了什么" help="写给以后回看的人：改了哪个角色的提示词、哪个任务的档案…">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：data_searcher 的提示词补了「收益按交易日统计；大结果用 pandas 读文件汇总」" />
        </Field>
      </div>
    </Dialog>
  );
}

// ———————— 详情 ————————

type VerdictTab = "all" | "fixed" | "same" | "worse" | "unclear" | "pending";

const matches = (it: ReplayItem, tab: VerdictTab) =>
  tab === "all" || (tab === "pending" ? it.verdict === null : tab === "unclear" ? it.verdict === "unclear" || it.verdict === "error" : it.verdict === tab);

export function ReplayDetailPage() {
  const { id } = useParams<{ id: string }>();
  const rid = Number(id);
  const [s, setS] = useSearch<{ verdict: VerdictTab }>();
  /** 有还没判的条目时每 5 秒刷新（首屏先按"有"处理，拿到数据后再定） */
  const [live, setLive] = useState(true);
  const { data: r, error, refetch } = useReplay(rid, live);
  useEffect(() => { if (r) setLive(r.counts.pending > 0); }, [r]);

  const rejudge = useMutation(async () => {
    try {
      const next = await api.rejudgeReplay(rid);
      setQueryData(["replays", "one", rid], () => next);
      invalidate("replays", "list");
      setLive(next.counts.pending > 0);
      toast("已重判", { description: "没判定的、判断不了的条目重新判了一遍" });
    } catch (e) {
      toast.error("重判失败", (e as Error).message);
    }
  });

  if (!Number.isFinite(rid)) return <Page><Empty title="回归重放不存在" description="链接可能已失效" action={<LinkButton to="/runs?view=replays">回到回归重放列表</LinkButton>} /></Page>;
  if (error) return <Page><ErrorState error={error} onRetry={refetch} /></Page>;
  if (!r) return <Page wide><Skeleton className="mb-4 h-20" /><Skeleton className="mb-4 h-32" /><Skeleton className="h-96" /></Page>;

  const tab: VerdictTab = s.verdict ?? "all";
  const items = r.items.filter((it) => matches(it, tab));
  const c = r.counts;

  return (
    <Page wide>
      <PageHeader
        crumbs={[{ label: "运行", to: "/runs" }, { label: "回归重放", to: "/runs?view=replays" }, { label: <span className="font-mono">#{r.id}</span> }]}
        icon={<LuFlaskConical />}
        title={r.title || `回归重放 #${r.id}`}
        meta={<>
          <span>{r.created_by} 发起于 <span title={datetime(r.created_at, true)}>{ago(r.created_at)}</span></span>
          <FilterChips filter={r.filter} />
        </>}
        actions={<>
          {c.pending > 0 && <span className="flex items-center gap-1.5 text-xs text-fg-3"><Dot tone="info" pulse />{c.pending} 条判定中 · 每 5 秒刷新</span>}
          <Tooltip content="把还没判定、判断不了的条目重判一遍">
            <Button icon={<LuRefreshCw />} loading={rejudge.pending} onClick={() => rejudge.mutate(undefined)}>重判</Button>
          </Tooltip>
        </>}
      />

      <div className="mb-4 grid gap-4 lg:grid-cols-[1fr_420px]">
        <Card>
          <CardHeader icon={<LuNotebookPen />} title="这次改了什么" />
          <div className="whitespace-pre-wrap px-4 py-3 text-[13px] leading-relaxed text-fg-2">{r.note || <span className="text-fg-3">发起时没写备注</span>}</div>
        </Card>
        <Card>
          <CardHeader icon={<LuScale />} title="判定" description="模型对照原答案、人指出的问题和新答案给出" />
          <div className="space-y-3 px-4 py-3">
            <VerdictBar counts={c} className="h-2" />
            <div className="grid grid-cols-5 gap-2">
              {COUNTS.map((x) => {
                const v = REPLAY_VERDICT[x.verdict];
                return (
                  <div key={x.key} className="min-w-0">
                    <div className={cn("text-[20px] font-semibold tabular-nums leading-tight", c[x.key] ? (TONE_TEXT[v.tone] ?? "text-fg") : "text-fg-3")}>{c[x.key]}</div>
                    <div className="truncate text-[11.5px] text-fg-3">{v.label}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented size="sm" value={tab} onChange={(v) => setS({ verdict: v === "all" ? undefined : v })} options={[
          { value: "all", label: `全部 ${c.total}` },
          ...COUNTS.filter((x) => c[x.key] > 0).map((x) => ({ value: x.key as VerdictTab, label: `${REPLAY_VERDICT[x.verdict].label} ${c[x.key]}` })),
        ]} />
        <span className="ml-auto text-xs text-fg-3">左边是被 👎 的原答案，右边是用当前定义重答的新答案</span>
      </div>

      {items.length === 0 ? <Card><Empty icon={<LuFlaskConical />} title="这一类没有条目" /></Card> : (
        <div className="space-y-3">{items.map((it) => <ReplayItemCard key={it.id} item={it} />)}</div>
      )}
    </Page>
  );
}

function ReplayItemCard({ item }: { item: ReplayItem }) {
  const running = !!item.after.status && LIVE.includes(item.after.status);
  const reasonTone = { fixed: "bg-ok-soft/50", same: "bg-warn-soft/50", worse: "bg-bad-soft/50", unclear: "bg-sunken/60", error: "bg-sunken/60" }[item.verdict ?? "unclear"];
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-2.5">
        <VerdictBadge verdict={item.verdict} className="h-6 px-2 text-[12px]" />
        <Link to={`/tasks/${encodeURIComponent(item.task)}`} className="font-mono text-[12.5px] text-fg-2 hover:text-accent">{item.task}</Link>
        <span className="text-[12.5px] text-fg-3">{item.service ?? "平台"}</span>
        <EnvBadge env={item.env} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg" title={item.summary}>{item.summary}</span>
        <VersionDelta before={item.before} after={item.after} />
      </div>
      {item.reason && (
        <div className={cn("flex items-start gap-2 border-b border-line px-4 py-2.5 text-[12.5px] leading-relaxed", reasonTone)}>
          <LuScale className="mt-0.5 size-3.5 shrink-0 text-fg-3" />
          <span className="min-w-0 flex-1 text-fg-2"><span className="text-fg-3">判定理由：</span>{item.reason}</span>
          {item.judged_at && <span className="shrink-0 text-[11.5px] text-fg-3" title={datetime(item.judged_at, true)}>{ago(item.judged_at)}</span>}
        </div>
      )}
      <div className="grid divide-y divide-line md:grid-cols-2 md:divide-x md:divide-y-0">
        <AnswerPane title="原答案" hint={<LuThumbsDown className="size-3.5 text-bad" />} runId={item.source_run} answer={item.before.answer}
          status={item.before.status} empty="原运行没有输出" />
        <AnswerPane title="新答案" hint={<span className="text-[11px] text-fg-3">当前定义</span>} runId={item.new_run} answer={item.after.answer}
          status={item.after.status} empty={!item.new_run ? "没有建成重放运行" : running ? "重放运行中…结束后自动判定" : "重放运行没有输出"} />
      </div>
    </Card>
  );
}

/** 两份配方之间变了什么：任务、父任务、各层角色（含子代理）、服务、平台提示词、模型、平台版本 */
function recipeChanges(a: Recipe, b: Recipe): { label: string; from: string; to: string }[] {
  const out: { label: string; from: string; to: string }[] = [];
  const add = (label: string, x: string | number | null | undefined, y: string | number | null | undefined, v = true) => {
    if (x === y || (x == null && y == null)) return;
    const f = (n: string | number | null | undefined) => (n == null ? "—" : v ? `v${n}` : String(n));
    out.push({ label, from: f(x), to: f(y) });
  };
  add("任务", a.task.version, b.task.version);
  if (a.task.parent || b.task.parent) add(`父任务 ${(b.task.parent ?? a.task.parent)!.name}`, a.task.parent?.version, b.task.parent?.version);
  const roles = (r: Recipe) => new Map([...(r.role?.lineage ?? []), ...(r.subagents ?? []).flatMap((s) => s.lineage)].map((x) => [x.name, x.version]));
  const ra = roles(a), rb = roles(b);
  for (const name of new Set([...ra.keys(), ...rb.keys()])) add(`角色 ${name}`, ra.get(name), rb.get(name));
  if (a.service || b.service) add(`服务 ${(b.service ?? a.service)!.name}`, a.service?.version, b.service?.version);
  add("平台提示词", a.prompts, b.prompts);
  add("模型", a.model, b.model, false);
  add("平台", a.platform, b.platform);
  return out;
}

/** 有配方时列出变了的（"角色 data_searcher v4 → v5 · 平台提示词 v2 → v3"）；旧运行没有配方，退回"任务 v3 → v5 · 角色 v2 → v4" */
function VersionDelta({ before, after }: { before: ReplaySide; after: ReplaySide }) {
  if (before.recipe && after.recipe) {
    const changes = recipeChanges(before.recipe, after.recipe);
    if (!changes.length) return <span className="shrink-0 text-[11.5px] text-fg-3">配方未变</span>;
    return (
      <span className="flex shrink-0 flex-wrap items-center gap-x-1.5 font-mono text-[11.5px] text-fg-2">
        {changes.map((c, i) => (
          <span key={c.label} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-fg-3">·</span>}
            <span>{c.label} {c.from} → <span className="font-semibold text-accent">{c.to}</span></span>
          </span>
        ))}
      </span>
    );
  }
  const part = (label: string, a: number | null, b: number | null) => {
    if (a === null && b === null) return null;
    const changed = b !== null && a !== b;
    return (
      <span key={label} className={changed ? "text-fg-2" : "text-fg-3"}>
        {label} v{a ?? "—"} → <span className={cn(changed && "font-semibold text-accent")}>{b === null ? "…" : `v${b}`}</span>
      </span>
    );
  };
  const parts = [part("任务", before.task_version, after.task_version), part("角色", before.role_version, after.role_version)].filter(Boolean);
  if (!parts.length) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11.5px]">
      {parts.map((p, i) => <span key={i} className="flex items-center gap-1.5">{i > 0 && <span className="text-fg-3">·</span>}{p}</span>)}
    </span>
  );
}

function AnswerPane({ title, hint, runId, answer, status, empty }: {
  title: string; hint?: ReactNode; runId: string | null; answer: string | null; status: RunStatus | null; empty: string;
}) {
  return (
    <div className="min-w-0 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11.5px] font-semibold uppercase tracking-wider text-fg-3">{title}</span>
        {hint}
        {status && <RunStatusBadge status={status} />}
        {runId && (
          <Link to={`/runs/${runId}`} className="ml-auto inline-flex items-center gap-1 font-mono text-[11.5px] text-fg-3 hover:text-accent">
            {shortId(runId)}<LuArrowUpRight className="size-3" />
          </Link>
        )}
      </div>
      {answer ? (
        <div className="max-h-96 overflow-auto rounded-md border border-line bg-sunken/40 px-3.5 py-3"><Markdown text={answer} className="text-[13px]" /></div>
      ) : (
        <div className="rounded-md border border-dashed border-line px-3 py-6 text-center text-xs text-fg-3">{empty}</div>
      )}
    </div>
  );
}
