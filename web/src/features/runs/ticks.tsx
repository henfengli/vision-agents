/**
 * 触发记录：定时、事件、上游联动、自动重试每做一次判定记一条——建了哪条运行，或者为什么没建。
 * 回答「昨晚的巡检为什么没跑」「Dagster 推过来了，为什么没有任务接」。运行页的「触发记录」标签、任务详情的卡片共用。
 */
import { useEffect, useState } from "react";
import { LuArrowRight, LuRadar, LuRefreshCw } from "react-icons/lu";

import { api, useTasks, useTicks } from "@/api/hooks";
import type { Tick, TickFilters, TickKind, TickOutcome } from "@/api/types";
import { EnvFilter, FilterBar, envOf, envParam } from "@/components/filters";
import { ListState } from "@/components/states";
import { EnvBadge, TICK_OUTCOME, TRIGGER, TickOutcomeBadge } from "@/components/status";
import { TimeAgo } from "@/components/time";
import { Button } from "@/components/ui/button";
import { FilterSelect, Segmented } from "@/components/ui/form";
import { Tooltip } from "@/components/ui/overlay";
import { Card, Empty } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { shortId } from "@/lib/format";
import { Link } from "@/lib/router";
import { useUi } from "@/lib/store";

const KINDS: TickKind[] = ["schedule", "event", "after", "retry"];

/** 一条触发记录：结果 · 类型 · 环境 · 时间；下一行是原因和建出来的运行 */
export function TickItem({ tick, titles, showTask = true }: { tick: Tick; titles?: Record<string, string>; showTask?: boolean }) {
  const kind = TRIGGER[tick.kind];
  const base = tick.task?.split(":")[0];
  const detail = tick.detail && Object.keys(tick.detail).length ? JSON.stringify(tick.detail) : null;
  return (
    <li className="px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <TickOutcomeBadge outcome={tick.outcome} />
        <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-fg-3 [&_svg]:size-3.5">{kind?.icon}{kind?.label ?? tick.kind}
          {tick.trigger_id && <code className="font-mono text-[11px]">#{tick.trigger_id}</code>}</span>
        {showTask && tick.task && (
          <Link to={`/tasks/${encodeURIComponent(tick.task)}`} className="min-w-0 truncate text-[12.5px] text-fg-2 hover:text-accent">
            {(base && titles?.[base]) || tick.task}{tick.task.includes(":") && <span className="font-mono text-fg-3"> :{tick.task.split(":")[1]}</span>}
          </Link>
        )}
        {tick.env && <EnvBadge env={tick.env} />}
        <TimeAgo at={tick.at} className="ml-auto shrink-0 text-[11.5px] text-fg-3" />
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2 text-[12px]">
        {detail ? (
          <Tooltip content={<code className="whitespace-pre-wrap break-all font-mono text-[11px]">{detail}</code>} className="min-w-0">
            <span className="truncate text-fg-3">{tick.reason || "—"}</span>
          </Tooltip>
        ) : <span className="min-w-0 truncate text-fg-3">{tick.reason || "—"}</span>}
        {tick.source && tick.kind === "after" && (
          <Link to={`/runs/${tick.source}`} className="shrink-0 font-mono text-[11px] text-fg-3 hover:text-accent">上游 {shortId(tick.source)}</Link>
        )}
        {tick.run_id && (
          <Link to={`/runs/${tick.run_id}`} className="ml-auto inline-flex shrink-0 items-center gap-0.5 font-mono text-[11px] text-accent hover:underline">
            {tick.outcome === "skipped" ? "还在跑的 " : tick.kind === "retry" ? "" : "→ "}{shortId(tick.run_id)}
          </Link>
        )}
      </div>
    </li>
  );
}

/** 任务详情里的小卡片：最近几条 */
export function TaskTicksCard({ task }: { task: string }) {
  const q = useTicks({ task, limit: 8 });
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <LuRadar className="size-4 text-fg-3" />
        <span className="text-[13px] font-medium text-fg">触发记录</span>
        <span className="hidden truncate text-xs text-fg-3 sm:inline">定时、事件、联动、自动重试每次判定一条：建了哪条运行，或者为什么没建</span>
        <Link to={`/runs?view=ticks&task=${encodeURIComponent(task)}`} className="ml-auto flex shrink-0 items-center gap-1 text-xs text-fg-3 hover:text-accent">全部 <LuArrowRight className="size-3" /></Link>
      </div>
      <ListState query={{ data: q.data?.items, error: q.error, refetch: q.refetch }} what="触发记录" compact
        empty={<Empty title="还没有触发记录" description="定时到点、事件进来、上游结束时会记在这里；手动运行和 API 调用不记" className="py-6" />}>
        {(items) => <ul className="divide-y divide-line">{items.map((t) => <TickItem key={t.id} tick={t} showTask={!!t.task?.includes(":") && !task.includes(":")} />)}</ul>}
      </ListState>
    </Card>
  );
}

type TickSearch = { task: string; kind: string; outcome: string; env: string; hours: string };

/** 运行页的「触发记录」标签：筛选在 URL 上，往下翻页（before = 最后一条的 id） */
export function TicksPanel({ s, set }: { s: Partial<TickSearch>; set: (patch: Partial<Record<keyof TickSearch, string | undefined>>) => void }) {
  const ui = useUi();
  const env = envOf(s.env, ui.env);
  const filters: TickFilters = { task: s.task || undefined, kind: (s.kind as TickKind) || undefined, outcome: (s.outcome as TickOutcome) || undefined,
    env: env || undefined, hours: Number(s.hours) || undefined, limit: 100 };
  const q = useTicks(filters);
  const { data: tasks } = useTasks();
  const titles = Object.fromEntries((tasks ?? []).filter((t) => !t.extends).map((t) => [t.name, t.title || t.name]));
  // 往下翻的几页：筛选一变就丢掉
  const [more, setMore] = useState<Tick[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const key = JSON.stringify(filters);
  useEffect(() => { setMore([]); setNext(null); }, [key]);
  const cursor = more.length ? next : q.data?.next_before ?? null;
  const loadMore = async () => {
    if (cursor == null) return;
    setLoadingMore(true);
    try {
      const page = await api.ticks({ ...filters, before: cursor });
      setMore((m) => [...m, ...page.items]);
      setNext(page.next_before);
    } finally { setLoadingMore(false); }
  };
  const active = !!(s.task || s.kind || s.outcome || s.hours || s.env !== undefined);
  const clear = () => set({ task: undefined, kind: undefined, outcome: undefined, hours: undefined, env: undefined });
  const items = q.data ? [...q.data.items, ...more.filter((m) => !q.data!.items.some((x) => x.id === m.id))] : undefined;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented size="sm" value={s.hours ?? ""} onChange={(v) => set({ hours: v || undefined })} options={[
          { value: "1", label: "1h" }, { value: "24", label: "24h" }, { value: "72", label: "3d" }, { value: "168", label: "7d" }, { value: "", label: "全部" },
        ]} />
        <FilterBar active={active} onClear={clear}
          right={<Button variant="ghost" size="sm" icon={<LuRefreshCw className={cn(q.fetching && "animate-spin")} />} onClick={() => q.refetch()}>刷新</Button>}>
          <FilterSelect label="任务" allLabel="全部" value={s.task ?? ""} onChange={(v) => set({ task: v || undefined })}
            options={(tasks ?? []).filter((t) => !t.extends).map((t) => ({ value: t.name, label: t.name, hint: t.title }))} />
          <FilterSelect label="类型" allLabel="全部" value={s.kind ?? ""} onChange={(v) => set({ kind: v || undefined })}
            options={KINDS.map((k) => ({ value: k, label: TRIGGER[k]?.label ?? k }))} />
          <FilterSelect label="结果" allLabel="全部" value={s.outcome ?? ""} onChange={(v) => set({ outcome: v || undefined })}
            options={(Object.keys(TICK_OUTCOME) as TickOutcome[]).map((o) => ({ value: o, label: TICK_OUTCOME[o].label }))} />
          <EnvFilter value={env} onChange={(v) => set({ env: envParam(v, ui.env) })} />
        </FilterBar>
      </div>
      <Card>
        <ListState query={{ data: items, error: q.error, refetch: q.refetch }} what="触发记录" filtered={active} onClear={clear} icon={<LuRadar />}
          empty={<Empty icon={<LuRadar />} title="还没有触发记录" description="定时到点、事件进来、上游任务结束、失败后自动重试时，每次判定记一条；手动运行和 API 调用不记在这里" />}>
          {(list) => (
            <>
              <ul className="divide-y divide-line">{list.map((t) => <TickItem key={t.id} tick={t} titles={titles} />)}</ul>
              {cursor != null && (
                <div className="border-t border-line px-4 py-2.5 text-center">
                  <Button size="sm" loading={loadingMore} onClick={() => void loadMore()}>再往前看</Button>
                </div>
              )}
            </>
          )}
        </ListState>
      </Card>
    </>
  );
}
