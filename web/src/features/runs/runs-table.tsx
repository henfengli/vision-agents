/**
 * 运行表格：运行页、服务页、任务页、概览复用。列可按场景裁剪。
 */
import { LuHourglass, LuRefreshCw } from "react-icons/lu";

import type { RunListItem } from "@/api/types";
import { EnvBadge, ResolutionTag, RunStatusBadge, TriggerBadge } from "@/components/status";
import { TimeUntil } from "@/components/time";
import { Table, Td, Th, Tr } from "@/components/ui/data";
import { Badge, Empty, ErrorState, SkeletonRows } from "@/components/ui/primitives";
import { Tooltip } from "@/components/ui/overlay";
import { ago, datetime, duration, num, shortId } from "@/lib/format";
import { Link, navigate } from "@/lib/router";

export type RunColumn = "status" | "task" | "service" | "env" | "trigger" | "duration" | "tokens" | "time";

/** 还在跑的已经跑了多久：列里只给到分钟（"12 分…"），精确值在悬停提示里 */
function runningFor(since: string) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  return s < 60 ? `${s} 秒…` : s < 3600 ? `${Math.floor(s / 60)} 分…` : `${Math.floor(s / 3600)} 时…`;
}

const ALL: RunColumn[] = ["status", "task", "service", "env", "trigger", "duration", "tokens", "time"];

/** 状态旁边的小标：等着自动重试 / 在等点名的上游 / 第几次执行 */
export function RunFlags({ run }: { run: Pick<RunListItem, "status" | "retry_at" | "depends_on" | "attempt"> }) {
  return (
    <>
      {run.status === "failed" && run.retry_at && (
        <Tooltip content={<>失败后等着自动重试：<TimeUntil at={run.retry_at} /></>}><Badge tone="info" icon={<LuRefreshCw />}>将重试</Badge></Tooltip>
      )}
      {run.status === "queued" && run.depends_on.length > 0 && (
        <Tooltip content={`点名等 ${run.depends_on.length} 个上游运行成功后才开始`}><Badge tone="idle" icon={<LuHourglass />}>等上游</Badge></Tooltip>
      )}
      {run.attempt > 1 && <Tooltip content="续跑 / 自动重试过：同一个运行接着跑的第几次"><Badge tone="outline">第 {run.attempt} 次</Badge></Tooltip>}
    </>
  );
}

export function RunsTable({ runs, loading, columns = ALL, empty, compact, error, onRetry }: {
  runs: RunListItem[] | undefined; loading?: boolean; columns?: RunColumn[]; empty?: React.ReactNode; compact?: boolean;
  /** 查询出错且还没有数据：显示错误态（带重试），不要显示成"没有运行" */
  error?: Error; onRetry?: () => void;
}) {
  if (error && !runs) return <ErrorState error={error} onRetry={onRetry} className={compact ? "py-6" : undefined} />;
  if (loading && !runs) return <SkeletonRows rows={compact ? 5 : 10} />;
  if (!runs?.length) return <>{empty ?? <Empty title="还没有运行" className={compact ? "py-6" : undefined} />}</>;
  const has = (c: RunColumn) => columns.includes(c);
  return (
    <Table>
      <thead>
        <tr>
          {has("status") && <Th className="w-[96px]">状态</Th>}
          <Th>运行</Th>
          {has("task") && <Th>任务</Th>}
          {/* 窄屏（< 1280）服务并到运行那一格的第二行、Tokens 不显示：表格不用横向滚 */}
          {has("service") && <Th className="hidden xl:table-cell">服务</Th>}
          {has("env") && <Th className="w-[72px]">环境</Th>}
          {has("trigger") && <Th>触发</Th>}
          {has("duration") && <Th className="text-right">耗时</Th>}
          {has("tokens") && <Th className="hidden text-right xl:table-cell">Tokens</Th>}
          {has("time") && <Th className="w-[92px] text-right">时间</Th>}
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <Tr key={r.run_id} onClick={() => navigate(`/runs/${r.run_id}`)}>
            {has("status") && <Td><RunStatusBadge status={r.status} /></Td>}
            {/* 摘要列吃掉剩余宽度并截断，其余短列不换行：窄屏下行高不被挤成三四行 */}
            <Td className="w-full min-w-[196px] max-w-0">
              <div className="flex items-center gap-2">
                <Link to={`/runs/${r.run_id}`} onClick={(e) => e.stopPropagation()} title={r.summary || r.task_title} className="min-w-0 truncate font-medium text-fg hover:text-accent">{r.summary || r.task_title}</Link>
                <ResolutionTag resolution={r.resolution} />
                <RunFlags run={r} />
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-fg-3">
                {shortId(r.run_id)}{r.trigger.caller && r.trigger.caller !== r.trigger.type ? ` · ${r.trigger.caller}` : ""}
                {has("service") && r.service && <span className="xl:hidden"> · {r.service}</span>}
              </div>
            </Td>
            {has("task") && (
              <Td className="max-w-[220px]">
                <Link to={`/tasks/${encodeURIComponent(r.task)}`} onClick={(e) => e.stopPropagation()} className="block truncate text-fg-2 hover:text-accent">{r.task_title || r.task}</Link>
                {r.task.includes(":") && <div className="truncate font-mono text-[11px] text-fg-3">:{r.task.split(":")[1]}</div>}
              </Td>
            )}
            {has("service") && <Td className="hidden whitespace-nowrap xl:table-cell">{r.service ? <Link to={`/services/${r.service}`} onClick={(e) => e.stopPropagation()} className="text-fg-2 hover:text-accent">{r.service}</Link> : <span className="text-fg-3">平台</span>}</Td>}
            {has("env") && <Td><EnvBadge env={r.env} /></Td>}
            {has("trigger") && <Td className="whitespace-nowrap"><TriggerBadge type={r.trigger.type} source={r.trigger.source} /></Td>}
            {has("duration") && (
              <Td className="whitespace-nowrap text-right tabular-nums text-fg-2">
                {/* 还在跑的显示已经跑了多久（列表随轮询刷新） */}
                {r.status === "running" && r.duration_ms == null
                  ? <Tooltip content={`已经跑了 ${duration(Math.max(0, Date.now() - Date.parse(r.created_at)))}`}><span className="text-fg-3">{runningFor(r.created_at)}</span></Tooltip>
                  : duration(r.duration_ms)}
              </Td>
            )}
            {has("tokens") && <Td className="hidden whitespace-nowrap text-right tabular-nums text-fg-3 xl:table-cell">{r.tokens ? num(r.tokens) : "—"}</Td>}
            {has("time") && (
              <Td className="whitespace-nowrap text-right">
                <Tooltip content={datetime(r.created_at, true)}><span className="text-fg-3">{ago(r.created_at)}</span></Tooltip>
              </Td>
            )}
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

/** 紧凑列表（侧栏、卡片里） */
export function RunMiniList({ runs, limit = 6 }: { runs: RunListItem[] | undefined; limit?: number }) {
  if (!runs) return <SkeletonRows rows={4} />;
  if (!runs.length) return <div className="px-4 py-6 text-center text-xs text-fg-3">还没有运行</div>;
  return (
    <ul className="divide-y divide-line">
      {runs.slice(0, limit).map((r) => (
        <li key={r.run_id}>
          <Link to={`/runs/${r.run_id}`} className="group flex items-center gap-3 px-4 py-2.5 hover:bg-hover/70">
            <RunStatusBadge status={r.status} className="w-[68px] justify-center" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-fg group-hover:text-accent" title={r.summary || r.task_title}>{r.summary || r.task_title}</div>
              <div className="mt-0.5 truncate text-[11.5px] text-fg-3">{r.task_title || r.task}{r.service ? ` · ${r.service}` : ""}</div>
            </div>
            {/* 环境和时间叠在右边：窄卡片里把宽度留给标题 */}
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <EnvBadge env={r.env} />
              <span className="whitespace-nowrap text-[11px] text-fg-3">{ago(r.created_at)}</span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
