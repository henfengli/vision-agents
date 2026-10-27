/**
 * 版本历史：时间线 + 任选两版 diff + 恢复。服务 / 角色 / 任务与平台配置各节共用。
 */
import { useEffect, useMemo, useState } from "react";
import { LuGitCompare, LuHistory, LuRotateCcw } from "react-icons/lu";

import { api, useVersions, useVersionStats, type DefinitionPath, type StatsPath } from "@/api/hooks";
import type { ConfigSection, Version, VersionStat } from "@/api/types";
import { cn } from "@/lib/cn";
import { ago, datetime, duration, pct } from "@/lib/format";
import { invalidate } from "@/lib/query";
import { Button } from "./ui/button";
import { DiffView, stableYaml } from "./ui/data";
import { confirm, toast } from "./ui/overlay";
import { Badge, Card, CardHeader, Empty, SkeletonRows } from "./ui/primitives";

const STRIP = new Set(["version", "updated_by", "updated_at", "name", "section", "overrides", "stats_24h", "last_run", "next_fire", "subtask_count", "task_count", "generic_task_count", "health"]);

function clean(def: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(def).filter(([k]) => !STRIP.has(k)));
}

const kTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** "12 次 · 成功 92% · 👎 1 · 均 8.4k tokens · 21s" */
function StatLine({ s }: { s: VersionStat }) {
  const parts = [`${s.runs} 次`, `成功 ${pct(s.success, s.success + s.failed)}`];
  if (s.negative) parts.push(`👎 ${s.negative}`);
  if (s.avg_tokens) parts.push(`均 ${kTokens(s.avg_tokens)} tokens`);
  if (s.avg_ms !== null) parts.push(duration(s.avg_ms));
  return (
    <div className="mt-0.5 text-[11px] tabular-nums text-fg-3" title={`失败 ${s.failed} 次 · ${datetime(s.first_at)} ~ ${datetime(s.last_at)}（回归重放不算）`}>
      {parts.join(" · ")}
    </div>
  );
}

/** stats：每个版本下附一行运行效果（任务、角色、平台提示词有） */
export function VersionHistory({ kind, name, onRestored, stats }: {
  kind: DefinitionPath | `settings/${ConfigSection}`; name?: string; onRestored?: () => void; stats?: boolean;
}) {
  const { data, loading, refetch } = useVersions(kind, name);
  const statsKind: StatsPath | null = stats && (kind === "tasks" || kind === "roles" || kind === "settings/prompts") ? kind : null;
  const { data: statList } = useVersionStats(statsKind ?? "tasks", name, !!statsKind);
  const statOf = useMemo(() => new Map((statsKind ? statList ?? [] : []).map((s) => [s.version, s])), [statsKind, statList]);
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);

  useEffect(() => {
    if (data && data.length && a === null) {
      setB(data[0].version);
      setA(data[1]?.version ?? data[0].version);
    }
  }, [data, a]);

  const va = data?.find((v) => v.version === a);
  const vb = data?.find((v) => v.version === b);
  const [before, after] = useMemo(() => [va ? stableYaml(clean(va.definition)) : "", vb ? stableYaml(clean(vb.definition)) : ""], [va, vb]);

  const restore = async (v: Version) => {
    const ok = await confirm({ title: `恢复到 v${v.version}？`, description: "会把 v" + v.version + " 的内容写成一个新版本（历史只增不改，可再恢复回来），立即生效。", confirmText: "恢复" });
    if (!ok) return;
    try {
      await api.restore(kind, name, v.version);
      toast(`已恢复为 v${v.version} 的内容`);
      await refetch();
      invalidate(kind.startsWith("settings/") ? "settings" : kind);
      if (kind === "settings/envs" || kind === "settings/notifications") invalidate("meta");   // meta 里有环境与渠道名
      onRestored?.();
      setA(null);
    } catch (e) {
      toast.error("恢复失败", (e as Error).message);
    }
  };

  const pick = (v: number) => {
    if (v === b) return;
    if (a === v) return;
    if (b !== null && v > b) { setA(b); setB(v); } else setA(v);
  };

  if (loading) return <Card><SkeletonRows /></Card>;
  if (!data?.length) return <Card><Empty icon={<LuHistory />} title="没有历史版本" /></Card>;
  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      <Card className="h-fit">
        <CardHeader title="版本" description={statsKind ? "点击任一版本与当前选中的新版对比；版本下是它跑出来的效果" : "点击任一版本与当前选中的新版对比"} icon={<LuHistory />} />
        <ol className="relative py-2">
          {data.map((v, i) => (
            <li key={v.version} className="group relative flex items-start gap-3 px-4 py-2">
              {i < data.length - 1 && <span className="absolute left-[23px] top-6 h-full w-px bg-line" />}
              <button type="button" onClick={() => pick(v.version)}
                className={cn("relative z-10 mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 bg-panel",
                  v.version === b ? "border-accent" : v.version === a ? "border-warn" : "border-line-strong group-hover:border-fg-3")}>
                {(v.version === a || v.version === b) && <span className={cn("size-1.5 rounded-full", v.version === b ? "bg-accent" : "bg-warn")} />}
              </button>
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => pick(v.version)}>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[12.5px] font-semibold text-fg">v{v.version}</span>
                  {i === 0 && <Badge tone="ok">当前</Badge>}
                  {v.deleted && <Badge tone="bad">已删除</Badge>}
                  {v.version === a && <Badge tone="warn">对比基准</Badge>}
                </div>
                <div className="mt-0.5 text-[11.5px] text-fg-3" title={datetime(v.created_at, true)}>{v.updated_by} · {ago(v.created_at)}</div>
                {statOf.has(v.version) && <StatLine s={statOf.get(v.version)!} />}
              </button>
              {i > 0 && (
                <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100" title="恢复到此版本" onClick={() => restore(v)}><LuRotateCcw /></Button>
              )}
            </li>
          ))}
        </ol>
      </Card>
      <Card className="min-w-0">
        <CardHeader icon={<LuGitCompare />} title={va && vb ? <>v{va.version} → v{vb.version}</> : "对比"} description="按键排序后逐行比较；红色为删除，绿色为新增" />
        <div className="p-4"><DiffView before={before} after={after} className="max-h-[560px]" /></div>
      </Card>
    </div>
  );
}
