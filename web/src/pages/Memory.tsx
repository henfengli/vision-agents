// 记忆管理：按环境分区查看知识条目，编辑保存后重新生效。

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { MemoryEntry, Meta } from "@/lib/api";
import { PageHead, StatusPill } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

export default function MemoryPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [env, setEnv] = useState("");
  const [domain, setDomain] = useState("");
  const [inactive, setInactive] = useState(false);
  const [rows, setRows] = useState<MemoryEntry[]>([]);
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [content, setContent] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => { api.meta().then(setMeta).catch(() => {}); }, []);
  const load = useCallback(() => {
    api.memoryEntries(env || undefined, domain || undefined, inactive)
      .then(setRows).catch(() => {});
  }, [env, domain, inactive]);
  useEffect(load, [load]);

  return (
    <div>
      <PageHead eyebrow="MEMORY" title="记忆管理"
                meta="按环境分区 · 反馈影响条目权重 · 编辑保存后重新生效" />
      <Card className="mb-4"><CardContent className="pt-4 flex gap-3
                                                 items-center">
        {meta && meta.target_envs.length > 0 && (
          <Select value={env || meta.env}
                  onValueChange={setEnv}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[meta.env, ...meta.target_envs].map((e) => (
                <SelectItem key={e} value={e}>{e}</SelectItem>))}
            </SelectContent>
          </Select>
        )}
        <Input className="w-48" placeholder="域过滤" value={domain}
               onChange={(e) => setDomain(e.target.value)} />
        <label className="flex items-center gap-2 text-xs
                          text-muted-foreground">
          <Checkbox checked={inactive}
                    onCheckedChange={(v) => setInactive(v === true)} />
          含失效
        </label>
        <Button size="sm" variant="outline" onClick={load}>筛选</Button>
      </CardContent></Card>

      <Card><CardContent className="pt-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>域</TableHead><TableHead>key</TableHead>
              <TableHead>内容</TableHead><TableHead>状态</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((i) => (
              <TableRow key={i.id}>
                <TableCell><Badge variant="outline">{i.domain}</Badge></TableCell>
                <TableCell className="font-mono text-xs">{i.key}</TableCell>
                <TableCell>
                  <pre className="text-xs whitespace-pre-wrap max-w-xl
                                  line-clamp-4">{i.content}</pre>
                </TableCell>
                <TableCell>
                  {i.superseded ? <StatusPill status="已取代" />
                    : i.expired ? <StatusPill status="已过期" />
                    : <span className="text-xs text-emerald-400">
                        生效中 +{i.feedback_score}</span>}
                </TableCell>
                <TableCell>
                  <Button size="sm" variant="ghost" onClick={() => {
                    setEditing(i); setContent(i.content); setMsg("");
                  }}>编辑</Button>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={5}
                className="text-center text-muted-foreground">
                暂无条目</TableCell></TableRow>)}
          </TableBody>
        </Table>
      </CardContent></Card>

      {editing && (
        <Card className="mt-4">
          <CardContent className="pt-4 space-y-2">
            <p className="text-sm">编辑条目 <span className="font-mono
              text-xs text-muted-foreground">#{editing.id} · {editing.key}
              </span></p>
            <Textarea rows={8} value={content}
                      onChange={(e) => setContent(e.target.value)} />
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={async () => {
                try {
                  await api.memoryUpdate(editing.id, content);
                  setMsg("已保存");
                  setTimeout(() => { setEditing(null); load(); }, 600);
                } catch (e) { setMsg(String(e)); }
              }}>保存（重新生效）</Button>
              <span className="text-xs text-muted-foreground">{msg}</span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
