/**
 * 详情页 meta 行的共用件。各详情页（服务、角色、回归重放、设置各节）的 meta 按同一个顺序排：
 *   [标识 + 复制] · [归属 / 关系] · [类型 / 环境 / 触发] · [对象特有] · vN · by · TimeAgo
 * 版本行统一是「v3 · zhangsan · 3 小时前」，不写"更新于"。
 */
import { type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { TimeAgo } from "./time";
import { CopyButton } from "./ui/data";

/** 标识（服务名、角色名、#id）：等宽 + 复制按钮。meta 行就是给人复制标识的地方，按钮一直显示 */
export function IdCopy({ value, children, className }: { value: string; children?: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-0.5 font-mono", className)}>
      <span className="truncate">{children ?? value}</span>
      <CopyButton text={value} label={`复制 ${value}`} className="size-5" />
    </span>
  );
}

/** 版本行："v3 · zhangsan · 3 小时前"；悬停时间看精确时刻。缺的段不显示 */
export function MetaVersion({ version, by, at, className }: { version?: number | null; by?: string | null; at?: string | null; className?: string }) {
  const parts: ReactNode[] = [];
  if (version != null) parts.push(<span key="v" className="font-mono">v{version}</span>);
  if (by) parts.push(<span key="by">{by}</span>);
  if (at) parts.push(<TimeAgo key="at" at={at} />);
  if (!parts.length) return null;
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {parts.flatMap((p, i) => (i ? [<span key={`s${i}`} className="text-fg-3/70">·</span>, p] : [p]))}
    </span>
  );
}
