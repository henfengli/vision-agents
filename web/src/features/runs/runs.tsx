/**
 * 运行页三个标签：
 * - 运行：状态 / 时间 / 服务 / 环境 / 任务 / 触发 / 发起方 筛选全部在 URL 上；环境默认跟随顶栏，每页 50 条。
 * - 反馈：大家点的 👍👎（默认只看 👎），见 feedback-inbox.tsx。
 * - 回归重放：拿被 👎 的运行用当前定义重跑、看问题改好没有，见 replays.tsx。
 */
import { LuActivity, LuChevronLeft, LuChevronRight, LuFlaskConical, LuMessageSquareWarning, LuRefreshCw } from "react-icons/lu";

import { useApiKeys, useMeta, useRuns, useTasks } from "@/api/hooks";
import type { RunFilters, RunStatus } from "@/api/types";
import { EnvFilter, FilterBar, ServiceFilter, envOf, envParam } from "@/components/filters";
import { Page, PageHeader } from "@/components/layout/shell";
import { RUN_STATUS, TRIGGER } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/data";
import { FilterSelect, SearchInput, Segmented } from "@/components/ui/form";
import { Card, Dot, Empty } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { useSearch } from "@/lib/router";
import { useUi } from "@/lib/store";
import { FeedbackInbox, type InboxSearch } from "./feedback-inbox";
import { ReplayList } from "./replays";
import { RunsTable } from "./runs-table";

const STATUS_TABS: { value: RunStatus | ""; label: string }[] = [
  { value: "", label: "全部" }, { value: "running", label: "运行中" }, { value: "queued", label: "排队中" }, { value: "failed", label: "失败" },
  { value: "success", label: "成功" }, { value: "cancelled", label: "已取消" },
];

const TRIGGER_TYPES = ["api", "chat", "schedule", "event", "web", "rerun", "resume", "correction", "replay"];

const PAGE_SIZE = 50;

type View = "runs" | "feedback" | "replays";

type Search = { status: string; hours: string; service: string; env: string; task: string; trigger: string; caller: string; q: string; session_id: string; cursor: string };

export function RunsPage() {
  const [s, setS] = useSearch<Search & InboxSearch & { view: View }>();
  const view: View = s.view === "feedback" || s.view === "replays" ? s.view : "runs";
  return (
    <Page wide>
      <PageHeader title="运行" description="每一次执行的事实记录：配方钉死用到的每样定义的版本，全过程事件可回放；人给的评价集中在「反馈」，改完定义或记忆后在「回归重放」里拿过去的运行重跑验证" />
      <Tabs className="mb-4" value={view} onChange={(v) => setS({ view: v === "runs" ? undefined : v, cursor: undefined, score: undefined, reason: undefined })} tabs={[
        { value: "runs", label: "运行", icon: <LuActivity /> },
        { value: "feedback", label: "反馈", icon: <LuMessageSquareWarning /> },
        { value: "replays", label: "回归重放", icon: <LuFlaskConical /> },
      ]} />
      {view === "runs" ? <RunList /> : view === "feedback" ? <FeedbackInbox s={s} set={(patch) => setS(patch)} /> : <ReplayList />}
    </Page>
  );
}

function RunList() {
  const [s, setS] = useSearch<Search>();
  const ui = useUi();
  const env = envOf(s.env, ui.env);
  const filters: RunFilters = {
    status: (s.status as RunStatus) || "", hours: Number(s.hours) || undefined, service: s.service, env: env || undefined,
    task: s.task, trigger: s.trigger, caller: s.caller, q: s.q, session_id: s.session_id, cursor: s.cursor, limit: PAGE_SIZE,
  };
  const { data, loading, fetching, refetch } = useRuns(filters);
  const { data: tasks } = useTasks();

  /** 改筛选就回到第一页 */
  const set = (patch: Partial<Search>) => setS({ ...patch, cursor: undefined });
  const clear = () => setS({ status: undefined, hours: undefined, service: undefined, env: undefined, task: undefined, trigger: undefined, caller: undefined, q: undefined, session_id: undefined, cursor: undefined });
  const active = !!(s.status || s.hours || s.service || s.env !== undefined || s.task || s.trigger || s.caller || s.q || s.session_id);

  return (
    <>
      <div className="mb-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-md border border-line bg-sunken p-0.5">
            {STATUS_TABS.map((t) => (
              <button key={t.value} type="button" onClick={() => set({ status: t.value || undefined })}
                className={cn("flex h-6 items-center gap-1.5 rounded-[5px] px-2.5 text-[12px] font-medium transition-colors",
                  (s.status ?? "") === t.value ? "bg-panel text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-fg-3 hover:text-fg")}>
                {t.value && <Dot tone={RUN_STATUS[t.value].tone as "ok"} pulse={t.value === "running"} />}{t.label}
              </button>
            ))}
          </div>
          <Segmented size="sm" value={s.hours ?? ""} onChange={(v) => set({ hours: v || undefined })} options={[
            { value: "1", label: "1h" }, { value: "24", label: "24h" }, { value: "72", label: "3d" }, { value: "168", label: "7d" }, { value: "", label: "全部" },
          ]} />
          <SearchInput value={s.q ?? ""} onChange={(v) => set({ q: v || undefined })} placeholder="运行 id 或问题关键词" className="w-60" />
          <div className="ml-auto flex items-center gap-2 text-xs text-fg-3">
            <><Dot tone="ok" pulse /> 实时</>
            {data && <span>共 {data.total} 条</span>}
            <Button variant="ghost" size="sm" icon={<LuRefreshCw className={cn(fetching && "animate-spin")} />} onClick={() => refetch()}>刷新</Button>
          </div>
        </div>
        <FilterBar active={active} onClear={clear}>
          <ServiceFilter value={s.service ?? ""} onChange={(v) => set({ service: v })} />
          <EnvFilter value={env} onChange={(v) => set({ env: envParam(v, ui.env) })} />
          <FilterSelect label="任务" allLabel="全部" value={s.task ?? ""} onChange={(v) => set({ task: v })}
            options={(tasks ?? []).filter((t) => !t.extends && (!s.service || t.service === s.service || t.service === "*")).map((t) => ({ value: t.name, label: t.name, hint: t.title }))} />
          <FilterSelect label="触发" allLabel="全部" value={s.trigger ?? ""} onChange={(v) => set({ trigger: v })}
            options={TRIGGER_TYPES.map((t) => ({ value: t, label: TRIGGER[t]?.label ?? t }))} />
          <CallerFilter value={s.caller ?? ""} onChange={(v) => set({ caller: v })} />
          {s.session_id && <FilterSelect label="会话" allLabel="全部" value={s.session_id} onChange={(v) => set({ session_id: v })} options={[{ value: s.session_id, label: s.session_id }]} />}
        </FilterBar>
      </div>

      <Card>
        <RunsTable runs={data?.items} loading={loading}
          empty={<Empty icon={<LuActivity />} title="没有符合条件的运行" description={active ? "试试放宽筛选条件" : "任务运行后会出现在这里"} />} />
        {data && (data.next_cursor || data.prev_cursor) && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
            <span className="text-xs text-fg-3">共 {data.total} 条 · 每页 {PAGE_SIZE} 条</span>
            <div className="flex gap-1.5">
              <Button size="sm" icon={<LuChevronLeft />} disabled={!data.prev_cursor} onClick={() => setS({ cursor: data.prev_cursor ?? undefined }, false)}>上一页</Button>
              <Button size="sm" disabled={!data.next_cursor} onClick={() => setS({ cursor: data.next_cursor ?? undefined }, false)}>下一页<LuChevronRight /></Button>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

/** 发起方 = API 密钥名（事件也是推事件那把密钥）/ 控制台用户 / schedule */
function CallerFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: meta } = useMeta();
  const { data: keys } = useApiKeys();
  const names = new Set([meta?.me.name ?? "", ...(keys ?? []).filter((k) => !k.revoked_at).map((k) => k.name), "schedule", value].filter(Boolean));
  return <FilterSelect label="发起方" allLabel="全部" value={value} onChange={onChange} options={[...names].map((n) => ({ value: n, label: n }))} />;
}
