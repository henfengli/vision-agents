/**
 * 反馈收件箱：大家对运行（或其中一步）的评价，默认只看 👎。
 * 用来回答"agent 最近哪里做得不好"：按服务 / 环境 / 任务 / 问题类型筛，点进运行看现场。
 */
import { LuMessageSquareWarning } from "react-icons/lu";

import { useFeedbackInbox, useMeta, useTasks } from "@/api/hooks";
import type { FeedbackFilters } from "@/api/types";
import { FeedbackItem } from "@/components/feedback";
import { EnvFilter, FilterBar, ServiceFilter } from "@/components/filters";
import { EnvBadge, RunStatusDot } from "@/components/status";
import { FilterSelect, Segmented } from "@/components/ui/form";
import { Card, Empty, SkeletonRows } from "@/components/ui/primitives";
import { Link } from "@/lib/router";

export type InboxSearch = { score: string; service: string; env: string; task: string; reason: string; hours: string };

export function FeedbackInbox({ s, set }: { s: Partial<InboxSearch>; set: (patch: Partial<InboxSearch>) => void }) {
  const { data: meta } = useMeta();
  const { data: tasks } = useTasks();
  const score = s.score ?? "-1";
  const filters: FeedbackFilters = {
    score: score === "all" ? undefined : (Number(score) as 1 | -1), service: s.service, env: s.env, task: s.task, reason: s.reason,
    hours: Number(s.hours) || undefined,
  };
  const { data, loading } = useFeedbackInbox(filters);
  const active = !!(s.service || s.env || s.task || s.reason);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented size="sm" value={score} onChange={(v) => set({ score: v })} options={[
          { value: "-1", label: "👎 有问题" }, { value: "1", label: "👍 有用" }, { value: "all", label: "全部" },
        ]} />
        <Segmented size="sm" value={s.hours ?? ""} onChange={(v) => set({ hours: v || undefined })} options={[
          { value: "24", label: "24h" }, { value: "168", label: "7d" }, { value: "720", label: "30d" }, { value: "", label: "全部" },
        ]} />
        <FilterBar active={active} onClear={() => set({ service: undefined, env: undefined, task: undefined, reason: undefined })}>
          <ServiceFilter value={s.service ?? ""} onChange={(v) => set({ service: v })} />
          <EnvFilter value={s.env ?? ""} onChange={(v) => set({ env: v })} />
          <FilterSelect label="任务" allLabel="全部" value={s.task ?? ""} onChange={(v) => set({ task: v })}
            options={(tasks ?? []).filter((t) => !t.extends).map((t) => ({ value: t.name, label: t.name, hint: t.title }))} />
          {score !== "1" && <FilterSelect label="问题" allLabel="全部" value={s.reason ?? ""} onChange={(v) => set({ reason: v })}
            options={(meta?.feedback_reasons ?? []).map((r) => ({ value: r.value, label: r.label }))} />}
        </FilterBar>
      </div>
      <Card>
        {loading && !data ? <SkeletonRows /> : !data?.length ? (
          <Empty icon={<LuMessageSquareWarning />} title="没有符合条件的反馈" description="运行详情、对话里的 👍👎 都会出现在这里" />
        ) : (
          <ul className="divide-y divide-line">
            {data.map((f) => (
              <li key={`${f.run_id}/${f.step_seq}/${f.created_by}`} className="px-4 py-3">
                <FeedbackItem entry={f} extra={<>
                  <Link to={`/tasks/${encodeURIComponent(f.task)}`} className="font-mono text-[11.5px] text-fg-3 hover:text-accent">{f.task}</Link>
                  <span className="text-[11.5px] text-fg-3">{f.service ?? "平台"}</span>
                  <EnvBadge env={f.env} />
                </>} />
                <Link to={`/runs/${f.run_id}`} className="mt-1.5 flex items-center gap-1.5 rounded-md bg-sunken/60 px-2.5 py-1.5 text-[12.5px] text-fg-2 hover:text-accent">
                  <RunStatusDot status={f.run_status} /><span className="truncate">{f.summary}</span>
                  <span className="ml-auto shrink-0 text-[11.5px] text-fg-3">查看运行 →</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
