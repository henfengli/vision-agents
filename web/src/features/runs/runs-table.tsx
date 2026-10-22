/**
 * 运行表格：运行页、服务页、任务页、概览复用。列可按场景裁剪。
 */
import { LuArrowUpRight, LuThumbsDown, LuThumbsUp } from "react-icons/lu";

import type { RunListItem } from "@/api/types";
import { EnvBadge, ResolutionTag, RunStatusBadge, TriggerBadge } from "@/components/status";
import { Table, Td, Th, Tr } from "@/components/ui/data";
import { Empty, SkeletonRows } from "@/components/ui/primitives";
import { Tooltip } from "@/components/ui/overlay";
import { ago, datetime, duration, num, shortId } from "@/lib/format";
import { Link, navigate } from "@/lib/router";

export type RunColumn = "status" | "task" | "service" | "env" | "trigger" | "duration" | "tokens" | "time";

const ALL: RunColumn[] = ["status", "task", "service", "env", "trigger", "duration", "tokens", "time"];

export function RunsTable({ runs, loading, columns = ALL, empty, compact }: {
  runs: RunListItem[] | undefined; loading?: boolean; columns?: RunColumn[]; empty?: React.ReactNode; compact?: boolean;
}) {
  if (loading && !runs) return <SkeletonRows rows={compact ? 5 : 10} />;
  if (!runs?.length) return <>{empty ?? <Empty title="没有运行记录" description="调整筛选条件或时间范围" />}</>;
  const has = (c: RunColumn) => columns.includes(c);
  return (
    <Table>
      <thead>
        <tr>
          {has("status") && <Th className="w-[96px]">状态</Th>}
          <Th>运行</Th>
          {has("task") && <Th>任务</Th>}
          {has("service") && <Th>服务</Th>}
          {has("env") && <Th className="w-[72px]">环境</Th>}
          {has("trigger") && <Th>触发</Th>}
          {has("duration") && <Th className="text-right">耗时</Th>}
          {has("tokens") && <Th className="text-right">Tokens</Th>}
          {has("time") && <Th className="w-[110px] text-right">时间</Th>}
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <Tr key={r.run_id} onClick={() => navigate(`/runs/${r.run_id}`)}>
            {has("status") && <Td><RunStatusBadge status={r.status} /></Td>}
            <Td className="max-w-[420px]">
              <div className="flex items-center gap-2">
                <Link to={`/runs/${r.run_id}`} onClick={(e) => e.stopPropagation()} className="min-w-0 truncate font-medium text-fg hover:text-accent">{r.summary || r.task_title}</Link>
                <ResolutionTag resolution={r.resolution} />
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-fg-3">{shortId(r.run_id)}{r.trigger.caller && r.trigger.caller !== r.trigger.type ? ` · ${r.trigger.caller}` : ""}</div>
            </Td>
            {has("task") && (
              <Td className="max-w-[220px]">
                <Link to={`/tasks/${encodeURIComponent(r.task)}`} onClick={(e) => e.stopPropagation()} className="block truncate text-fg-2 hover:text-accent">{r.task_title || r.task}</Link>
                {r.task.includes(":") && <div className="truncate font-mono text-[11px] text-fg-3">:{r.task.split(":")[1]}</div>}
              </Td>
            )}
            {has("service") && <Td>{r.service ? <Link to={`/services/${r.service}`} onClick={(e) => e.stopPropagation()} className="text-fg-2 hover:text-accent">{r.service}</Link> : <span className="text-fg-3">平台</span>}</Td>}
            {has("env") && <Td><EnvBadge env={r.env} /></Td>}
            {has("trigger") && <Td><TriggerBadge type={r.trigger.type} source={r.trigger.source} /></Td>}
            {has("duration") && <Td className="text-right tabular-nums text-fg-2">{duration(r.duration_ms)}</Td>}
            {has("tokens") && <Td className="text-right tabular-nums text-fg-3">{r.tokens ? num(r.tokens) : "—"}</Td>}
            {has("time") && (
              <Td className="text-right">
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
  if (!runs.length) return <div className="px-4 py-6 text-center text-xs text-fg-3">暂无运行</div>;
  return (
    <ul className="divide-y divide-line">
      {runs.slice(0, limit).map((r) => (
        <li key={r.run_id}>
          <Link to={`/runs/${r.run_id}`} className="group flex items-center gap-3 px-4 py-2.5 hover:bg-hover/70">
            <RunStatusBadge status={r.status} className="w-[68px] justify-center" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-fg group-hover:text-accent">{r.summary || r.task_title}</div>
              <div className="mt-0.5 truncate text-[11.5px] text-fg-3">{r.task_title || r.task}{r.service ? ` · ${r.service}` : ""}</div>
            </div>
            <EnvBadge env={r.env} />
            <span className="w-[72px] text-right text-[11.5px] text-fg-3">{ago(r.created_at)}</span>
            <LuArrowUpRight className="size-3.5 text-fg-3 opacity-0 group-hover:opacity-100" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function FeedbackMark({ score }: { score: number | null | undefined }) {
  if (!score) return null;
  return score > 0 ? <LuThumbsUp className="size-3.5 text-ok" /> : <LuThumbsDown className="size-3.5 text-bad" />;
}
