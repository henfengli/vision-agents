/**
 * 运行列表：状态 / 时间 / 服务 / 环境 / 任务 / 触发 / 发起方 筛选全部在 URL 上（可分享、可回退）。
 * 环境默认跟随顶栏全局环境；每页条数取个人偏好。
 */
import { LuActivity, LuChevronLeft, LuChevronRight, LuRefreshCw } from "react-icons/lu";

import { useApiKeys, useMeta, useRuns, useTasks } from "@/api/hooks";
import type { RunFilters, RunStatus } from "@/api/types";
import { EnvFilter, FilterBar, ServiceFilter } from "@/components/filters";
import { Page, PageHeader } from "@/components/layout/shell";
import { RUN_STATUS, TRIGGER } from "@/components/status";
import { Button } from "@/components/ui/button";
import { FilterSelect, SearchInput, Segmented } from "@/components/ui/form";
import { Card, Dot, Empty } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { useSearch } from "@/lib/router";
import { useUi } from "@/lib/store";
import { RunsTable } from "./runs-table";

const STATUS_TABS: { value: RunStatus | ""; label: string }[] = [
  { value: "", label: "全部" }, { value: "running", label: "运行中" }, { value: "failed", label: "失败" },
  { value: "awaiting_approval", label: "待审批" }, { value: "success", label: "成功" }, { value: "cancelled", label: "已取消" },
];

const TRIGGER_TYPES = ["api", "chat", "schedule", "event", "web", "rerun", "resume", "correction"];

type Search = { status: string; hours: string; service: string; env: string; task: string; trigger: string; caller: string; q: string; session_id: string; cursor: string };

export function RunsPage() {
  const [s, setS] = useSearch<Search>();
  const ui = useUi();
  const env = s.env ?? ui.env;
  const filters: RunFilters = {
    status: (s.status as RunStatus) || "", hours: Number(s.hours) || undefined, service: s.service, env: env || undefined,
    task: s.task, trigger: s.trigger, caller: s.caller, q: s.q, session_id: s.session_id, cursor: s.cursor, limit: ui.pageSize,
  };
  const { data, loading, fetching, refetch } = useRuns(filters);
  const { data: tasks } = useTasks();

  /** 改筛选就回到第一页 */
  const set = (patch: Partial<Search>) => setS({ ...patch, cursor: undefined });
  const clear = () => setS({ status: undefined, hours: undefined, service: undefined, env: undefined, task: undefined, trigger: undefined, caller: undefined, q: undefined, session_id: undefined, cursor: undefined });
  const active = !!(s.status || s.hours || s.service || s.env !== undefined || s.task || s.trigger || s.caller || s.q || s.session_id);
  const page = Math.floor(Number(s.cursor || 0) / ui.pageSize) + 1;

  return (
    <Page wide>
      <PageHeader title="运行" description="每一次执行的事实记录：钉死任务 / 角色版本，全过程事件可回放"
        actions={<Button variant="ghost" size="sm" icon={<LuRefreshCw className={cn(fetching && "animate-spin")} />} onClick={() => refetch()}>刷新</Button>} />

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
          <SearchInput value={s.q ?? ""} onChange={(v) => set({ q: v || undefined })} placeholder="run id 或问题关键词" className="w-60" />
          <div className="ml-auto flex items-center gap-2 text-xs text-fg-3">
            {ui.autoRefresh && <><Dot tone="ok" pulse /> 实时</>}
            {data && <span>共 {data.total} 条</span>}
          </div>
        </div>
        <FilterBar active={active} onClear={clear}>
          <ServiceFilter value={s.service ?? ""} onChange={(v) => set({ service: v })} />
          <EnvFilter value={env} onChange={(v) => set({ env: v })} />
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
            <span className="text-xs text-fg-3">第 {page} 页 / 共 {Math.ceil(data.total / ui.pageSize)} 页</span>
            <div className="flex gap-1.5">
              <Button size="sm" icon={<LuChevronLeft />} disabled={!data.prev_cursor} onClick={() => setS({ cursor: data.prev_cursor ?? undefined }, false)}>上一页</Button>
              <Button size="sm" disabled={!data.next_cursor} onClick={() => setS({ cursor: data.next_cursor ?? undefined }, false)}>下一页<LuChevronRight /></Button>
            </div>
          </div>
        )}
      </Card>
    </Page>
  );
}

/** 发起方 = API 密钥名 / 控制台用户 / schedule / event。管理员能列出全部密钥；其他人只看到自己和系统发起方 */
function CallerFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: meta } = useMeta();
  const { data: keys } = useApiKeys();
  const names = new Set([...(keys ?? []).map((k) => k.name), meta?.me.name ?? "", "schedule", "event", value].filter(Boolean));
  return <FilterSelect label="发起方" allLabel="全部" value={value} onChange={onChange} options={[...names].map((n) => ({ value: n, label: n }))} />;
}
