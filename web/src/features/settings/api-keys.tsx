/**
 * API 密钥：每个调用方（项目、脚本、Webhook、人）一把。密钥名就是调用身份，写进运行记录。
 * 密钥只标识身份、不分权限；明文只在创建时显示一次；可改备注与过期时间、可吊销。
 */
import { useState } from "react";
import { LuKeyRound, LuPlus } from "react-icons/lu";

import { api, useApiKeys } from "@/api/hooks";
import type { ApiKey } from "@/api/types";
import { Button, LinkButton } from "@/components/ui/button";
import { CopyButton, Table, Td, Th, Tr } from "@/components/ui/data";
import { Field, Input } from "@/components/ui/form";
import { Dialog, Tooltip, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, Empty, ErrorState, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, datetime } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { SettingsLayout } from "./layout";

const expired = (k: ApiKey) => !!k.expires_at && new Date(k.expires_at).getTime() < Date.now();

export function ApiKeysPage() {
  const { data, loading, error, refetch } = useApiKeys();
  const [editing, setEditing] = useState<ApiKey | "new" | null>(null);
  const [revoking, setRevoking] = useState<number | null>(null);
  const revoke = async (k: ApiKey) => {
    if (!(await confirm({ title: `吊销 ${k.name}？`, description: "吊销后用这把密钥的调用立即返回 401，不能恢复；同名的密钥也不能再建。", danger: true, confirmText: "吊销", requireText: k.name }))) return;
    setRevoking(k.id);
    try { await api.revokeApiKey(k.id); toast(`已吊销 ${k.name}`); invalidate("settings", "api-keys"); } catch (e) { toast.error("吊销失败", (e as Error).message); } finally { setRevoking(null); }
  };
  return (
    <SettingsLayout title="API 密钥" description={<>项目通过 <code className="font-mono text-[12px]">Authorization: Bearer &lt;密钥&gt;</code> 调用（GitLab Webhook 用 <code className="font-mono text-[12px]">X-Gitlab-Token</code>）。密钥只标识身份、不分权限：运行记录里的「发起方」就是密钥名。</>}
      actions={<Button variant="primary" icon={<LuPlus />} onClick={() => setEditing("new")}>新建密钥</Button>}>
      <Card>
        {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows /> : !data?.length ? (
          <Empty icon={<LuKeyRound />} title="还没有密钥" description="除了部署时的引导密钥（root_token），每个调用方都应该有自己的一把"
            action={<Button icon={<LuPlus />} onClick={() => setEditing("new")}>新建密钥</Button>} />
        ) : (
          <Table>
            <thead><tr><Th>名字</Th><Th>备注</Th><Th>创建</Th><Th>最近使用</Th><Th>过期</Th><Th /></tr></thead>
            <tbody>{data.map((k) => (
              <Tr key={k.id} className={cn(k.revoked_at && "opacity-50")} onClick={k.revoked_at ? undefined : () => setEditing(k)}>
                <Td>
                  <div className="flex items-center gap-2 font-medium text-fg">
                    <span className="font-mono text-[12.5px]">{k.name}</span>
                    {k.revoked_at && <Tooltip content={`吊销于 ${datetime(k.revoked_at)}`}><span><Badge tone="idle">已吊销</Badge></span></Tooltip>}
                    {!k.revoked_at && expired(k) && <Badge tone="warn">已过期</Badge>}
                  </div>
                  <div className="font-mono text-[11.5px] text-fg-3">{k.prefix}…</div>
                </Td>
                <Td className="max-w-[320px]"><span className="block truncate text-[12.5px] text-fg-2" title={k.note || undefined}>{k.note || <span className="text-fg-3">—</span>}</span></Td>
                <Td className="whitespace-nowrap text-[12.5px] text-fg-3" title={datetime(k.created_at, true)}>{k.created_by} · {ago(k.created_at)}</Td>
                <Td className="whitespace-nowrap text-[12.5px] text-fg-2">
                  {k.last_used_at
                    ? <span onClick={(e) => e.stopPropagation()}><LinkButton variant="link" size="sm" to={`/runs?caller=${encodeURIComponent(k.name)}`}>{ago(k.last_used_at)}</LinkButton></span>
                    : <span className="text-fg-3">从未</span>}
                </Td>
                <Td className={cn("whitespace-nowrap text-[12.5px]", expired(k) ? "text-warn" : "text-fg-3")}>{k.expires_at ? datetime(k.expires_at) : "不过期"}</Td>
                <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                  {!k.revoked_at && <Button size="sm" variant="danger-ghost" loading={revoking === k.id} onClick={() => revoke(k)}>吊销</Button>}
                </Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      <KeyDialog value={editing} onClose={() => setEditing(null)} />
    </SettingsLayout>
  );
}

const NAME_RE = /^[\w.-]{2,40}$/;

function KeyDialog({ value, onClose }: { value: ApiKey | "new" | null; onClose: () => void }) {
  const isNew = value === "new";
  const [d, setD] = useState({ name: "", note: "", expires_at: "" });
  const [token, setToken] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const id = value === "new" ? "new" : value ? String(value.id) : null;
  if (id !== key) {
    setKey(id);
    setToken(null);
    if (value && value !== "new") setD({ name: value.name, note: value.note, expires_at: value.expires_at?.slice(0, 10) ?? "" });
    else setD({ name: "", note: "", expires_at: "" });
  }
  const valid = NAME_RE.test(d.name);
  const save = useMutation(async () => {
    try {
      const expires_at = d.expires_at ? new Date(d.expires_at + "T23:59:59").toISOString() : null;
      if (isNew) {
        const created = await api.createApiKey({ name: d.name, note: d.note.trim(), expires_at });
        setToken(created.token);
        toast(`已创建 ${created.name}`, { description: "明文只显示这一次，先复制保存" });
      } else if (value) {
        await api.patchApiKey(value.id, { note: d.note.trim(), expires_at });
        toast("已保存");
        onClose();
      }
      invalidate("settings", "api-keys");
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  });
  const submit = () => { if (valid && !save.pending) void save.mutate(undefined); };
  if (token) {
    return (
      <Dialog open onClose={onClose} title="密钥已创建" description="明文只显示这一次，关掉就再也看不到了。"
        footer={<Button variant="primary" onClick={onClose}>我已保存</Button>}>
        <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-3 py-2.5">
          <code className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-fg">{token}</code>
          <CopyButton text={token} label="复制密钥" />
        </div>
        <div className="mt-3 text-[12px] text-fg-3">调用示例：<code className="break-all font-mono">curl -H "Authorization: Bearer {token.slice(0, 10)}…" …/v1/runs</code></div>
      </Dialog>
    );
  }
  return (
    <Dialog open={!!value} onClose={onClose} title={isNew ? "新建 API 密钥" : `编辑 ${d.name}`}
      description={isNew ? "密钥只标识调用方身份：有效的密钥都能调用全部接口。" : "名字是调用身份，创建后不能改；能改备注与过期时间。"}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!valid} loading={save.pending} onClick={submit}>{isNew ? "创建" : "保存"}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="名字" required help="调用方的身份，运行记录里显示它；建议用项目名，如 vision-board-backend" error={d.name && !valid ? "2–40 个字母、数字、. _ -" : null}>
          <Input mono autoFocus={isNew} disabled={!isNew} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value.trim() })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
          <Field label="备注"><Input value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} placeholder="谁在用、用来做什么" /></Field>
          <Field label="过期日期" help="不填 = 不过期"><Input type="date" value={d.expires_at} onChange={(e) => setD({ ...d, expires_at: e.target.value })} /></Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
