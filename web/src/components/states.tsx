/**
 * 列表与详情的加载 / 错误 / 空态，全站一个顺序：
 *   出错且没有数据 → 错误态（带重试）；还没有数据 → 骨架；空 → 空态。
 * 查询层出错时 loading=false、data=undefined：不先判错误的话，失败会显示成"没有数据"，或者骨架一直转。
 * 空态的措辞：没数据「还没有 X」；筛选后为空「没有符合条件的 X」+「清除筛选」。
 */
import { type ReactNode } from "react";
import { LuCircleAlert, LuX } from "react-icons/lu";

import { ApiError } from "@/api/client";
import { Button, LinkButton } from "./ui/button";
import { Empty, ErrorState, SkeletonRows } from "./ui/primitives";

interface QueryLike<T> { data: T | undefined; error?: Error; refetch?: () => unknown }

/** 筛选后为空：「没有符合条件的 X」+ 清除筛选 */
export function EmptyFiltered({ what, icon, onClear, className }: { what: string; icon?: ReactNode; onClear?: () => void; className?: string }) {
  return (
    <Empty className={className} icon={icon} title={`没有符合条件的${what}`} description="换个关键词，或者放宽筛选"
      action={onClear && <Button size="sm" icon={<LuX />} onClick={onClear}>清除筛选</Button>} />
  );
}

/**
 * query：useXxx() 的返回值；children 只在有数据且不为空时调用。
 * filtered：当前有筛选生效（空态换成「没有符合条件的 what」，onClear 给了就带「清除筛选」）。
 */
export function ListState<T>({ query, what, empty, filtered, onClear, icon, skeleton, isEmpty, compact, children }: {
  query: QueryLike<T>;
  /** 列表里装的是什么（"记忆"、"方法"、"反馈"）：拼进空态标题 */
  what: string;
  /** 真的没有数据时的空态；不给就是「还没有 X」 */
  empty?: ReactNode;
  filtered?: boolean;
  onClear?: () => void;
  icon?: ReactNode;
  skeleton?: ReactNode;
  isEmpty?: (data: T) => boolean;
  /** 卡片里的窄列表：空态、错误态用小一号的留白 */
  compact?: boolean;
  children: (data: T) => ReactNode;
}) {
  const { data, error, refetch } = query;
  const pad = compact ? "py-6" : undefined;
  if (error && data === undefined) return <ErrorState error={error} onRetry={refetch ? () => void refetch() : undefined} className={pad} />;
  if (data === undefined) return <>{skeleton ?? <SkeletonRows rows={compact ? 3 : 6} />}</>;
  const none = isEmpty ? isEmpty(data) : Array.isArray(data) && data.length === 0;
  if (none) return filtered ? <EmptyFiltered what={what} icon={icon} onClear={onClear} className={pad} /> : <>{empty ?? <Empty icon={icon} title={`还没有${what}`} className={pad} />}</>;
  return <>{children(data)}</>;
}

/**
 * 详情页加载失败：404 → 「X 不存在」+ 回到列表；其它错误 → 错误态（重试）+ 回到列表。
 * 页头（面包屑）由调用方照常渲染，这里只管正文那一块。
 */
export function DetailError({ error, onRetry, what, back }: {
  error: Error; onRetry?: () => void; what: string; back: { to: string; label: string };
}) {
  if (error instanceof ApiError && error.status === 404) {
    return <Empty title={`${what}不存在`} description="可能已经删除了，或者链接有误" action={<LinkButton to={back.to}>{back.label}</LinkButton>} />;
  }
  return (
    <Empty icon={<LuCircleAlert className="text-bad" />} title="加载失败" description={error.message}
      action={<div className="flex items-center gap-2">{onRetry && <Button size="sm" onClick={onRetry}>重试</Button>}<LinkButton size="sm" to={back.to}>{back.label}</LinkButton></div>} />
  );
}
