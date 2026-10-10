// 总览：近 24h 状态统计卡 + 任务分布 + 最近失败 + 最近 Runs。

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "@/lib/api";
import type { Overview, RunRow } from "@/lib/api";
import { PageHead, StatusPill } from "@/components/common";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export default function OverviewPage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [recent, setRecent] = useState<RunRow[]>([]);

  useEffect(() => {
    api.overview().then(setOv).catch(() => {});
    api.runs().then((r) => setRecent(r.slice(0, 10))).catch(() => {});
  }, []);

  const stats = ["success", "failed", "running", "queued"] as const;

  return (
    <div>
      <PageHead eyebrow="OVERVIEW" title="总览"
                meta={`近 ${ov?.hours ?? 24} 小时 · 每页数据来自台账聚合`} />
      <div className="grid grid-cols-4 gap-4 mb-6">
        {stats.map((s) => (
          <Card key={s}>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-mono text-muted-foreground">
                {s}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold font-mono">
                {ov?.by_status?.[s] ?? "–"}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <Card>
          <CardHeader><CardTitle className="text-sm">任务分布</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {(ov?.tasks ?? []).map((t) => (
              <div key={t.task_type} className="text-xs">
                <div className="flex justify-between mb-1">
                  <span className="font-mono">{t.task_type}</span>
                  <span className="text-muted-foreground">
                    {t.success}/{t.total} 成功
                  </span>
                </div>
                <div className="h-1.5 rounded bg-muted overflow-hidden">
                  <div className="h-full bg-emerald-500"
                       style={{ width: `${(t.success / t.total) * 100}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">最近失败</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {(ov?.failed ?? []).map((f) => (
              <Link key={f.run_id} to={`/runs/${f.run_id}`}
                    className="block text-xs font-mono text-red-400
                               hover:underline truncate">
                {f.run_id.slice(0, 8)} · {f.task_type} · {f.target_env} ·{" "}
                {f.created_at}
              </Link>
            ))}
            {ov && ov.failed.length === 0 && (
              <p className="text-xs text-muted-foreground">暂无失败 🎉</p>)}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">最近 Runs</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>run</TableHead><TableHead>任务</TableHead>
                <TableHead>角色</TableHead><TableHead>环境</TableHead>
                <TableHead>状态</TableHead><TableHead>来源</TableHead>
                <TableHead>时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((r) => (
                <TableRow key={r.run_id}>
                  <TableCell>
                    <Link to={`/runs/${r.run_id}`}
                          className="font-mono text-cyan-400 hover:underline">
                      {r.run_id.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.task_type}</TableCell>
                  <TableCell className="font-mono text-xs">{r.role}</TableCell>
                  <TableCell className="text-xs">{r.target_env || "-"}</TableCell>
                  <TableCell><StatusPill status={r.status} /></TableCell>
                  <TableCell className="text-xs">{r.trigger_source}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {String(r.created_at).slice(0, 19)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
