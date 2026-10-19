/**
 * 运行列表：状态 / 时间 / 服务 / 任务 / 触发 筛选全部在 URL 上（可分享、可回退），
 * 环境默认跟随顶栏全局环境。每 8 秒自动刷新。
 */
import { LuActivity, LuChevronLeft, LuChevronRight, LuRefreshCw } from "react-icons/lu";

import { useRuns, useServices, useTasks } from "@/api/hooks";
import type { RunFilters, RunStatus } from "@/api/types";
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

export function RunsPage() {
  const [s, setS] = useSearch<{ status: string; hours: string; service: string; task: string; trigger: string; q: string; cursor: string; env: string; session: string }>();
  const { env: globalEnv } = useUi();
  const filters: RunFilters = {
    status: (s.status as RunStatus) || "", hours: s.hours ? Number(s.hours) : undefined, service: s.service, task: s.task, trigger: s.trigger,
    q: s.q, cursor: s.cursor, env: s.env ?? globalEnv, session: s.session, limit: 30,
  };
  const { data, loading, fetching, refetch } = useRuns(filters);
  const { data: services } = useServices();
  const { data: tasks } = useTasks();
  const set = (patch: Record<string, string | undefined>) => setS({ ...patch, cursor: undefined });
  const active = Object.entries(filters).filter(([k, v]) => v && !["limit", "cursor"].includes(k) && !(k === "env" && v === globalEnv)).length;

  return (
    <Page wide>
      <PageHeader title="运行" description="每一次执行的事实记录：钉死任务/角色版本，全过程事件可回放"
        actions={<Button variant="ghost" size="sm" icon={<LuRefreshCw className={cn(fetching && "animate-spin")} />} onClick={() => refetch()}>刷新</Button>} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
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
        <FilterSelect label="服务" allLabel="全部" value={s.service ?? ""} onChange={(v) => set({ service: v })} options={(services ?? []).map((x) => ({ value: x.name, label: x.title }))} />
        <FilterSelect label="任务" allLabel="全部" value={s.task ?? ""} onChange={(v) => set({ task: v })} options={(tasks ?? []).filter((t) => !t.extends).map((t) => ({ value: t.name, label: t.title || t.name }))} />
        <FilterSelect label="触发" allLabel="全部" value={s.trigger ?? ""} onChange={(v) => set({ trigger: v })} options={["api", "chat", "schedule", "event", "web", "rerun"].map((t) => ({ value: t, label: TRIGGER[t].label }))} />
        {s.env !== undefined && s.env !== globalEnv && <FilterSelect label="环境" allLabel="全部" value={s.env} onChange={(v) => set({ env: v })} options={["prod", "test", "dev"].map((e) => ({ value: e, label: e }))} />}
        <SearchInput value={s.q ?? ""} onChange={(v) => set({ q: v || undefined })} placeholder="run id 或问题关键词" className="w-60" />
        {active > 0 && <Button size="xs" variant="ghost" onClick={() => setS({ status: undefined, hours: undefined, service: undefined, task: undefined, trigger: undefined, q: undefined, cursor: undefined, env: undefined, session: undefined })}>清除筛选</Button>}
        <div className="ml-auto flex items-center gap-2 text-xs text-fg-3">
          <Dot tone="ok" pulse /> 实时
          {data && <span>共 {data.total} 条</span>}
        </div>
      </div>

      <Card>
        <RunsTable runs={data?.items} loading={loading}
          empty={<Empty icon={<LuActivity />} title="没有符合条件的运行" description={active ? "试试放宽筛选条件" : "任务运行后会出现在这里"} />} />
        {data && (data.next_cursor || data.prev_cursor) && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
            <span className="text-xs text-fg-3">第 {Math.floor(Number(s.cursor || 0) / 30) + 1} 页 / 共 {Math.ceil(data.total / 30)} 页</span>
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
