/**
 * 时间显示：列表、meta 行里的相对时间一律用这里的组件，悬停看精确时间（不用原生 title）。
 * className 给外层（Tooltip 那层 span 才是父级 flex 里的一项）；颜色、字号这些会继承给里面的文字。
 */
import { Tooltip } from "./ui/overlay";
import { ago, datetime, until } from "@/lib/format";
import { cn } from "@/lib/cn";

/** "3 分钟前"；悬停 2026-10-21 14:03:22 */
export function TimeAgo({ at, className, prefix }: { at: string | null | undefined; className?: string; prefix?: string }) {
  if (!at) return <span className={cn("text-fg-3", className)}>—</span>;
  return (
    <Tooltip content={datetime(at, true)} className={className}>
      <span>{prefix}{ago(at)}</span>
    </Tooltip>
  );
}

/** "22 小时后"；悬停精确时间 */
export function TimeUntil({ at, className, prefix }: { at: string | null | undefined; className?: string; prefix?: string }) {
  if (!at) return <span className={cn("text-fg-3", className)}>—</span>;
  return (
    <Tooltip content={datetime(at, true)} className={className}>
      <span>{prefix}{until(at)}</span>
    </Tooltip>
  );
}
