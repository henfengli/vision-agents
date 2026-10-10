// Runs 列表：近 100 条 + 目标环境过滤（多环境部署时）。

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "@/lib/api";
import type { Meta, RunRow } from "@/lib/api";
import { PageHead, StatusPill } from "@/components/common";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export default function RunsPage() {
  const [rows, setRows] = useState<RunRow[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [params, setParams] = useSearchParams();
  const env = params.get("env") || "";

  useEffect(() => { api.meta().then(setMeta).catch(() => {}); }, []);
  useEffect(() => { api.runs(env || undefined).then(setRows).catch(() => {}); },
            [env]);

  return (
    <div>
      <PageHead eyebrow="EXECUTIONS" title="最近 Runs"
                meta="近 100 条 · 点击 run id 查看执行过程"
                right={meta && meta.target_envs.length > 0 && (
                  <Select value={env || "__all__"}
                          onValueChange={(v) => setParams(
                            v === "__all__" ? {} : { env: v })}>
                    <SelectTrigger className="w-40">
                      <SelectValue placeholder="全部环境" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">全部环境</SelectItem>
                      {meta.target_envs.map((e) => (
                        <SelectItem key={e} value={e}>{e}</SelectItem>))}
                    </SelectContent>
                  </Select>
                )} />
      <Card><CardContent className="pt-4">
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
            {rows.map((r) => (
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
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={7}
                className="text-center text-muted-foreground">暂无</TableCell>
              </TableRow>)}
          </TableBody>
        </Table>
      </CardContent></Card>
    </div>
  );
}
