/**
 * API 密钥：每个调用方（项目、脚本、Webhook、人）一把。密钥名就是调用身份，写进运行记录。
 * 密钥只标识身份、不分权限；明文只在创建时显示一次（那个对话框只能点「我已保存」关掉）；可改备注与过期时间、可吊销。
 * 已吊销 / 已过期的默认收起。
 */
import { Dialog as HDialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { useState } from "react";
import { LuKeyRound, LuPlus } from "react-icons/lu";

import { api, useApiKeys } from "@/api/hooks";
import type { ApiKey } from "@/api/types";
import { Button, LinkButton } from "@/components/ui/button";
import { TimeAgo } from "@/components/time";
import { CopyButton, RowButton, Table, Td, Th, Tr } from "@/components/ui/data";
import { Field, Input, Switch } from "@/components/ui/form";
import { Dialog, Tooltip, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, Empty, ErrorState, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { datetime, dayjs } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { SettingsLayout } from "./layout";

const expired = (k: ApiKey) => !!k.expires_at && new Date(k.expires_at).getTime() < Date.now();
const inactive = (k: ApiKey) => !!k.revoked_at || expired(k);

export function ApiKeysPage() {
  const { data, loading, error, refetch } = useApiKeys();
  const [editing, setEditing] = useState<ApiKey | "new" | null>(null);
  const [revoking, setRevoking] = useState<number | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const hidden = (data ?? []).filter(inactive).length;
  const list = (data ?? []).filter((k) => showInactive || !inactive(k));
  const revoke = async (k: ApiKey) => {
    if (!(await confirm({ title: `吊销 ${k.name}？`, description: "吊销后用这把密钥的调用马上被拒绝，不能恢复；同名的密钥也不能再建。", danger: true, confirmText: "吊销", requireText: k.name }))) return;
    setRevoking(k.id);
    try { await api.revokeApiKey(k.id); toast(`已吊销 ${k.name}`); invalidate("settings", "api-keys"); } catch (e) { toast.error("吊销失败", (e as Error).message); } finally { setRevoking(null); }
  };
  return (
    <SettingsLayout title="API 密钥" description="每个调用方（项目、脚本、Webhook）一把，密钥名会记在运行记录的「发起方」里。"
      actions={<>
        {/* 一直在：没有可显示的时禁用（不是有了才冒出来，页头不跟着位移） */}
        <Tooltip content={!hidden ? "没有已吊销或已过期的密钥" : undefined}>
          <span><Switch size="sm" checked={showInactive && hidden > 0} disabled={!hidden} onChange={setShowInactive}
            label={<span className="text-[12.5px] text-fg-2">显示已吊销 / 已过期的{hidden ? `（${hidden}）` : ""}</span>} /></span>
        </Tooltip>
        <Button variant="primary" icon={<LuPlus />} onClick={() => setEditing("new")}>新建密钥</Button>
      </>}>
      <Card>
        {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows /> : !data?.length ? (
          <Empty icon={<LuKeyRound />} title="还没有密钥" description="除了部署时的引导密钥（root_token），每个调用方都应该有自己的一把"
            action={<Button icon={<LuPlus />} onClick={() => setEditing("new")}>新建密钥</Button>} />
        ) : !list.length ? (
          <Empty icon={<LuKeyRound />} title="没有在用的密钥" description={`${hidden} 把已吊销或已过期的收起来了`}
            action={<Button size="sm" onClick={() => setShowInactive(true)}>显示它们</Button>} />
        ) : (
          <Table>
            <thead><tr><Th>名字</Th><Th>备注</Th><Th>创建</Th><Th>最近使用</Th><Th>过期</Th><Th /></tr></thead>
            <tbody>{list.map((k) => (
              <Tr key={k.id} className={cn(k.revoked_at && "opacity-50")} onClick={k.revoked_at ? undefined : () => setEditing(k)}>
                <Td>
                  <div className="flex items-center gap-2 font-medium text-fg">
                    {/* 首格是按钮：键盘也能打开编辑；已吊销的是终态，不能编辑 */}
                    {k.revoked_at ? <span className="font-mono text-[12.5px]">{k.name}</span>
                      : <RowButton onClick={() => setEditing(k)} label={`编辑 ${k.name}`} className="font-mono text-[12.5px]">{k.name}</RowButton>}
                    {k.revoked_at && <Tooltip content={`吊销于 ${datetime(k.revoked_at)}`}><span><Badge tone="idle">已吊销</Badge></span></Tooltip>}
                    {!k.revoked_at && expired(k) && <Badge tone="warn">已过期</Badge>}
                  </div>
                  <div className="font-mono text-[11.5px] text-fg-3">{k.prefix}…</div>
                </Td>
                <Td className="max-w-[320px]"><span className="block truncate text-[12.5px] text-fg-2" title={k.note || undefined}>{k.note || <span className="text-fg-3">—</span>}</span></Td>
                <Td className="whitespace-nowrap text-[12.5px] text-fg-3">{k.created_by} · <TimeAgo at={k.created_at} /></Td>
                <Td className="whitespace-nowrap text-[12.5px] text-fg-2">
                  {k.last_used_at
                    ? <span onClick={(e) => e.stopPropagation()}><LinkButton variant="link" size="sm" to={`/runs?caller=${encodeURIComponent(k.name)}`}><TimeAgo at={k.last_used_at} /></LinkButton></span>
                    : <span className="text-fg-3">从未</span>}
                </Td>
                <Td className={cn("whitespace-nowrap text-[12.5px]", expired(k) ? "text-warn" : "text-fg-3")}>{k.expires_at ? datetime(k.expires_at) : "不过期"}</Td>
                {/* 行尾槽位固定：已吊销是终态，放文字占位而不是空着 */}
                <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                  {k.revoked_at ? <span className="px-2.5 text-[12.5px] text-fg-3">已吊销</span>
                    : <Button size="sm" variant="danger-ghost" loading={revoking === k.id} onClick={() => revoke(k)}>吊销</Button>}
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
  const today = dayjs().format("YYYY-MM-DD");
  const original = value && value !== "new" ? value.expires_at?.slice(0, 10) ?? "" : "";
  // 已经过期的密钥原样保存可以；改成别的日期就不能早于今天
  const dateError = d.expires_at && d.expires_at < today && d.expires_at !== original ? "不能早于今天" : null;
  const valid = NAME_RE.test(d.name) && !dateError;
  const save = useMutation(async () => {
    try {
      const expires_at = d.expires_at ? new Date(d.expires_at + "T23:59:59").toISOString() : null;
      if (isNew) {
        const created = await api.createApiKey({ name: d.name, note: d.note.trim(), expires_at });
        setToken(created.token);
        toast(`已创建密钥 ${created.name}`, { description: "明文只显示这一次，先复制保存" });
      } else if (value) {
        await api.patchApiKey(value.id, { note: d.note.trim(), expires_at });
        toast(`已保存密钥 ${value.name}`);
        onClose();
      }
      invalidate("settings", "api-keys");
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  });
  const submit = () => { if (valid && !save.pending) void save.mutate(undefined); };
  if (token) return <TokenDialog token={token} onDone={onClose} />;
  return (
    <Dialog open={!!value} onClose={onClose} title={isNew ? "新建 API 密钥" : `编辑 ${d.name}`}
      description={isNew ? "密钥只标识调用方是谁：有效的密钥都能调用全部接口。" : "名字创建后不能改；能改备注和过期时间。"}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!valid} loading={save.pending} onClick={submit}>{isNew ? "创建" : "保存"}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="名字" required help="调用方的名字，运行记录里显示它；建议用项目名，如 vision-board-backend" error={d.name && !NAME_RE.test(d.name) ? "2–40 个字母、数字、. _ -" : null}>
          <Input mono autoFocus={isNew} disabled={!isNew} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value.trim() })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
          <Field label="备注"><Input value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} placeholder="谁在用、用来做什么" /></Field>
          <Field label="过期日期" help="不填 = 不过期" error={dateError}>
            <Input type="date" min={today} value={d.expires_at} aria-invalid={!!dateError} onChange={(e) => setD({ ...d, expires_at: e.target.value })} />
          </Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/**
 * 新密钥的明文：只在这里出现一次。点外面、按 Esc 都不关（误关就再也看不到了），只能点「我已保存」。
 * 共用的 Dialog 没有"禁止外点关闭"的开关，这里直接用 Headless UI 写一个没有关闭按钮的版本。
 */
function TokenDialog({ token, onDone }: { token: string; onDone: () => void }) {
  return (
    <HDialog open onClose={() => { /* 只能点「我已保存」关掉 */ }} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/30 backdrop-blur-[1px] dark:bg-black/60" />
      <div className="fixed inset-0 flex items-start justify-center p-4 pt-[8vh]">
        <DialogPanel className="flex w-full max-w-lg flex-col rounded-xl border border-line bg-raised shadow-[var(--shadow-pop)]">
          <div className="px-5 pt-4">
            <DialogTitle className="text-[15px] font-semibold text-fg">密钥已创建</DialogTitle>
            <div className="mt-1 text-[12.5px] text-fg-3">明文只显示这一次，关掉就再也看不到了。先复制保存好。</div>
          </div>
          <div className="px-5 py-4">
            <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-3 py-2.5">
              <code className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-fg">{token}</code>
              <CopyButton text={token} label="复制密钥" />
            </div>
            <div className="mt-3 text-[12px] text-fg-3">调用时放在请求头里：<code className="break-all font-mono">Authorization: Bearer {token.slice(0, 10)}…</code>（GitLab Webhook 填在 Secret token 里）</div>
          </div>
          <div className="flex items-center justify-end gap-2 rounded-b-xl border-t border-line bg-sunken/60 px-5 py-3">
            <Button variant="primary" onClick={onDone}>我已保存</Button>
          </div>
        </DialogPanel>
      </div>
    </HDialog>
  );
}
