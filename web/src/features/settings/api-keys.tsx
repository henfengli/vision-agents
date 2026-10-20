/**
 * API 密钥：每个调用方（项目、脚本、Webhook、人）一把。密钥名就是调用身份，写进运行记录。
 * 明文只在创建时显示一次；可以限定只能调用哪些服务、哪些环境；可吊销。
 */
import { useState } from "react";
import { LuKeyRound, LuPlus } from "react-icons/lu";

import { api, useApiKeys, useEnvs, useServices } from "@/api/hooks";
import type { ApiKey } from "@/api/types";
import { EnvBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { CopyButton, Table, Td, Th, Tr } from "@/components/ui/data";
import { Field, Input, Segmented, TagInput } from "@/components/ui/form";
import { Dialog, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, Empty, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, datetime } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { LinkButton } from "@/components/ui/button";
import { SettingsLayout } from "./layout";

export function ApiKeysPage() {
  const { data, loading } = useApiKeys();
  const [editing, setEditing] = useState<ApiKey | "new" | null>(null);
  const revoke = async (k: ApiKey) => {
    if (!(await confirm({ title: `吊销 ${k.name}？`, description: "吊销后用这把密钥的调用立即返回 401，无法恢复（可以新建一把同名以外的密钥）。", danger: true, confirmText: "吊销", requireText: k.name }))) return;
    try { await api.revokeApiKey(k.id); toast("已吊销"); invalidate("settings", "api-keys"); } catch (e) { toast.error("吊销失败", (e as Error).message); }
  };
  return (
    <SettingsLayout title="API 密钥" description={<>项目通过 <code className="font-mono text-[12px]">Authorization: Bearer &lt;密钥&gt;</code> 调用（GitLab Webhook 用 <code className="font-mono text-[12px]">X-Gitlab-Token</code>）。运行记录里的「发起方」就是密钥名。</>}
      actions={<Button variant="primary" icon={<LuPlus />} onClick={() => setEditing("new")}>新建密钥</Button>}>
      <Card>
        {loading ? <SkeletonRows /> : !data?.length ? <Empty icon={<LuKeyRound />} title="还没有密钥" description="除了部署时的引导密钥，每个调用方都应该有自己的一把" /> : (
          <Table>
            <thead><tr><Th>名字</Th><Th>范围</Th><Th>可调用</Th><Th>最近使用</Th><Th>过期</Th><Th /></tr></thead>
            <tbody>{data.map((k) => (
              <Tr key={k.id} className={cn(k.revoked_at && "opacity-50")} onClick={k.revoked_at ? undefined : () => setEditing(k)}>
                <Td>
                  <div className="flex items-center gap-2 font-medium text-fg">{k.name}{k.revoked_at && <Badge tone="idle">已吊销</Badge>}</div>
                  <div className="text-[11.5px] text-fg-3"><span className="font-mono">{k.prefix}…</span>{k.note && ` · ${k.note}`}</div>
                </Td>
                <Td>{k.scope === "admin" ? <Badge tone="warn">管理</Badge> : <Badge tone="outline">调用</Badge>}</Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-1 text-[12px]">
                    {k.services.length ? k.services.map((s) => <Badge key={s} tone="outline" className="font-mono">{s}</Badge>) : <span className="text-fg-3">全部服务</span>}
                    <span className="text-fg-3">·</span>
                    {k.envs.length ? k.envs.map((e) => <EnvBadge key={e} env={e} />) : <span className="text-fg-3">全部环境</span>}
                  </div>
                </Td>
                <Td className="text-[12.5px] text-fg-2">
                  {k.last_used_at ? <LinkButton variant="link" size="sm" to={`/runs?caller=${encodeURIComponent(k.name)}`}>{ago(k.last_used_at)}</LinkButton> : <span className="text-fg-3">从未</span>}
                </Td>
                <Td className="text-[12.5px] text-fg-3">{k.expires_at ? datetime(k.expires_at) : "不过期"}</Td>
                <Td className="text-right" onClick={(e) => e.stopPropagation()}>{!k.revoked_at && <Button size="sm" variant="danger-ghost" onClick={() => revoke(k)}>吊销</Button>}</Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      <KeyDialog value={editing} onClose={() => setEditing(null)} />
    </SettingsLayout>
  );
}

function KeyDialog({ value, onClose }: { value: ApiKey | "new" | null; onClose: () => void }) {
  const isNew = value === "new";
  const { data: services } = useServices();
  const { data: envs } = useEnvs();
  const [d, setD] = useState({ name: "", scope: "run" as ApiKey["scope"], services: [] as string[], envs: [] as string[], note: "", expires_at: "" });
  const [token, setToken] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const id = value === "new" ? "new" : value ? String(value.id) : null;
  if (id !== key) {
    setKey(id);
    setToken(null);
    if (value && value !== "new") setD({ name: value.name, scope: value.scope, services: value.services, envs: value.envs, note: value.note, expires_at: value.expires_at?.slice(0, 10) ?? "" });
    else setD({ name: "", scope: "run", services: [], envs: [], note: "", expires_at: "" });
  }
  const valid = /^[\w.-]{2,40}$/.test(d.name);
  const save = useMutation(async () => {
    try {
      const expires_at = d.expires_at ? new Date(d.expires_at + "T23:59:59").toISOString() : null;
      if (isNew) {
        const created = await api.createApiKey({ ...d, expires_at });
        setToken(created.token);
      } else if (value) {
        await api.patchApiKey(value.id, { services: d.services, envs: d.envs, note: d.note, expires_at });
        toast("已保存");
        onClose();
      }
      invalidate("settings", "api-keys");
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  });
  if (token) {
    return (
      <Dialog open onClose={onClose} title="密钥已创建" description="明文只显示这一次，关掉就再也看不到了。"
        footer={<Button variant="primary" onClick={onClose}>我已保存</Button>}>
        <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-3 py-2.5">
          <code className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-fg">{token}</code>
          <CopyButton text={token} />
        </div>
        <div className="mt-3 text-[12px] text-fg-3">调用示例：<code className="font-mono">curl -H "Authorization: Bearer {token.slice(0, 10)}…" …/v1/runs</code></div>
      </Dialog>
    );
  }
  return (
    <Dialog open={!!value} onClose={onClose} title={isNew ? "新建 API 密钥" : `编辑 ${d.name}`}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!valid} loading={save.pending} onClick={() => save.mutate(undefined)}>{isNew ? "创建" : "保存"}</Button></>}>
      <div className="space-y-4">
        <Field label="名字" required help="调用方的身份，运行记录里显示它；建议用项目名，如 board-backend" error={d.name && !valid ? "2–40 个字母、数字、. _ -" : null}>
          <Input mono autoFocus={isNew} disabled={!isNew} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value.trim() })} />
        </Field>
        <Field label="范围" help={d.scope === "admin" ? "能改定义、改设置、审批——只给控制台管理员" : "发起运行、对话、推事件，以及只读查询"}>
          <Segmented value={d.scope} onChange={(scope) => isNew && setD({ ...d, scope })} options={[{ value: "run", label: "调用" }, { value: "admin", label: "管理" }]} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="只能调用这些服务" help="不填 = 不限"><TagInput mono value={d.services} onChange={(s) => setD({ ...d, services: s })} suggestions={(services ?? []).map((s) => s.name).slice(0, 6)} /></Field>
          <Field label="只能调用这些环境" help="不填 = 不限"><TagInput mono value={d.envs} onChange={(e) => setD({ ...d, envs: e })} suggestions={(envs ?? []).map((e) => e.name)} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
          <Field label="备注"><Input value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} placeholder="谁在用、用来做什么" /></Field>
          <Field label="过期日期" help="不填 = 不过期"><Input type="date" value={d.expires_at} onChange={(e) => setD({ ...d, expires_at: e.target.value })} /></Field>
        </div>
      </div>
    </Dialog>
  );
}
