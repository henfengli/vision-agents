// 管理页：角色/任务/策略定义的查看与编辑（写后即时生效，历史全留）。

import { useCallback, useEffect, useState } from "react";
import { api, getToken } from "@/lib/api";
import type { DefinitionRow } from "@/lib/api";
import { PageHead } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type Kind = "role" | "task" | "policy";
const KIND_LABEL: Record<Kind, string> = {
  role: "角色", task: "任务", policy: "策略" };

export default function AdminPage() {
  const [data, setData] = useState<Record<Kind, DefinitionRow[]>>({
    role: [], task: [], policy: [] });
  const [editing, setEditing] = useState<{ kind: Kind; row: DefinitionRow }
    | null>(null);
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    Promise.all([api.roles(), api.tasks(), api.policies()])
      .then(([role, task, policy]) => setData({ role, task, policy }))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function save() {
    if (!editing) return;
    try {
      const definition = JSON.parse(draft);
      const resp = await fetch(`/v1/admin/${editing.kind}s`, {
        method: "POST",
        headers: { "Content-Type": "application/json",
                   Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ name: editing.row.name, definition,
                               updated_by: "admin-ui" }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setMsg("已保存（新版本即时生效）");
      setTimeout(() => { setEditing(null); load(); }, 800);
    } catch (e) {
      setMsg(`保存失败：${e}`);
    }
  }

  return (
    <div>
      <PageHead eyebrow="ADMIN" title="定义管理"
                meta="角色/任务/策略 · 写后即时生效 · 历史版本全留" />
      <Tabs defaultValue="role">
        <TabsList>
          {(["role", "task", "policy"] as Kind[]).map((k) => (
            <TabsTrigger key={k} value={k}>{KIND_LABEL[k]}</TabsTrigger>))}
        </TabsList>
        {(["role", "task", "policy"] as Kind[]).map((k) => (
          <TabsContent key={k} value={k}>
            <Card><CardContent className="pt-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead><TableHead>版本</TableHead>
                    <TableHead>摘要</TableHead><TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data[k].map((r) => (
                    <TableRow key={r.name}>
                      <TableCell className="font-mono text-xs">
                        {r.name}</TableCell>
                      <TableCell><Badge variant="outline">
                        v{r.version}</Badge></TableCell>
                      <TableCell className="text-xs text-muted-foreground
                                            max-w-md truncate">
                        {String(r.definition.description ??
                                JSON.stringify(r.definition).slice(0, 80))}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => {
                          setEditing({ kind: k, row: r });
                          setDraft(JSON.stringify(r.definition, null, 2));
                          setMsg("");
                        }}>编辑</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent></Card>
          </TabsContent>
        ))}
      </Tabs>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              {editing && `${KIND_LABEL[editing.kind]} · ${editing.row.name}`}
            </DialogTitle>
          </DialogHeader>
          <Textarea rows={18} className="font-mono text-xs"
                    value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={save}>保存为新版本</Button>
            <span className="text-xs text-muted-foreground">{msg}</span>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
