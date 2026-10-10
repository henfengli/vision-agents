// 审批台：待办收件箱 + 处理（放行/拒绝）。钉钉 deep-link 之外的兜底入口。

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "@/lib/api";
import type { ApprovalItem } from "@/lib/api";
import { PageHead } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export default function ApprovalsPage() {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const load = useCallback(() => {
    api.approvals().then((a) => setItems(a.items)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  return (
    <div>
      <PageHead eyebrow="APPROVALS" title="审批待办"
                meta="危险命令需人工放行；处理后刷新列表" />
      <Card><CardContent className="pt-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>命令</TableHead><TableHead>任务</TableHead>
              <TableHead>来源</TableHead><TableHead>时间</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-mono text-xs max-w-md truncate">
                  <Link to={`/runs/${a.run_id}`}
                        className="text-cyan-400 hover:underline">
                    {a.command}
                  </Link>
                </TableCell>
                <TableCell className="text-xs">{a.task_type}</TableCell>
                <TableCell className="text-xs">{a.trigger_source}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {a.created_at.slice(0, 19)}
                </TableCell>
                <TableCell className="text-right space-x-2">
                  <Button size="sm" variant="outline"
                    className="text-emerald-400 border-emerald-500/40"
                    onClick={async () => {
                      await api.decide(a.run_id, true, "viewer"); load();
                    }}>放行执行</Button>
                  <Button size="sm" variant="outline"
                    className="text-red-400 border-red-500/40"
                    onClick={async () => {
                      await api.decide(a.run_id, false, "viewer"); load();
                    }}>拒绝</Button>
                </TableCell>
              </TableRow>
            ))}
            {items.length === 0 && (
              <TableRow><TableCell colSpan={5}
                className="text-center text-muted-foreground">
                没有待审批项</TableCell></TableRow>)}
          </TableBody>
        </Table>
      </CardContent></Card>
    </div>
  );
}
