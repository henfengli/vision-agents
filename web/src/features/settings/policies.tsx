/**
 * 提交策略：闸门链的最后一环（开关之后）。按 order 升序，正则作用于 任务名 + 输入 + 问题，
 * 命中即 拒绝 / 需审批。编辑器带即时正则测试。
 */
import { useMemo, useState } from "react";
import { LuPlus, LuShieldCheck, LuSlidersHorizontal } from "react-icons/lu";

import { api, useEnvs, usePolicies, useServices, useTasks } from "@/api/hooks";
import type { Policy } from "@/api/types";
import { EnvBadge } from "@/components/status";
import { VersionHistory } from "@/components/versions";
import { Button } from "@/components/ui/button";
import { Table, Td, Th, Tr } from "@/components/ui/data";
import { Field, Input, Segmented, Switch, TagInput, Textarea } from "@/components/ui/form";
import { Drawer, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, Empty, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { SettingsLayout } from "./layout";

const GATES = [
  ["service_disabled", "服务停用"], ["service_env_disabled", "服务在该环境停用"], ["task_disabled", "任务停用"],
  ["env_not_allowed", "任务不允许该环境"], ["trigger_not_allowed", "任务没声明这种触发"],
];

export function PoliciesPage() {
  const { data, loading } = usePolicies();
  const [editing, setEditing] = useState<Policy | "new" | null>(null);
  return (
    <SettingsLayout title="提交策略" description="新提交依次通过闸门链；拒绝时返回原因码（error.code），「为什么没跑」只在一处判断。"
      actions={<Button variant="primary" icon={<LuPlus />} onClick={() => setEditing("new")}>新建策略</Button>}>
      <Card className="mb-4">
        <CardHeader title="闸门链" icon={<LuShieldCheck />} description="前四环是开关（重跑、续跑、定时也过），第五环查任务声明的触发方式，最后是下面这些输入策略（只对新提交）" />
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-3">
          {GATES.map(([code, label], i) => (
            <span key={code} className="flex items-center gap-1.5">
              <span className="rounded-md border border-line bg-sunken px-2 py-1 text-[12px] text-fg-2">{label}<code className="ml-1.5 font-mono text-[10.5px] text-fg-3">{code}</code></span>
              {i < GATES.length && <span className="text-fg-3">→</span>}
            </span>
          ))}
          <span className="rounded-md border border-accent/40 bg-accent-soft px-2 py-1 text-[12px] text-accent">输入策略 ×{data?.filter((p) => p.enabled).length ?? 0}<code className="ml-1.5 font-mono text-[10.5px]">policy</code></span>
        </div>
      </Card>
      <Card>
        {loading ? <SkeletonRows /> : !data?.length ? <Empty icon={<LuSlidersHorizontal />} title="没有策略" /> : (
          <Table>
            <thead><tr><Th className="w-14">顺序</Th><Th>策略</Th><Th>作用范围</Th><Th>匹配</Th><Th>动作</Th><Th className="text-right">版本</Th></tr></thead>
            <tbody>{data.map((p) => (
              <Tr key={p.name} onClick={() => setEditing(p)} className={cn(!p.enabled && "opacity-55")}>
                <Td className="font-mono text-fg-3">{p.order}</Td>
                <Td className="max-w-[320px]"><div className="flex items-center gap-2 font-medium text-fg">{p.name}{!p.enabled && <Badge tone="idle">已停用</Badge>}</div><div className="truncate text-[12px] text-fg-3">{p.description}</div></Td>
                <Td><Scope p={p} /></Td>
                <Td className="max-w-[240px] truncate font-mono text-[11.5px] text-fg-2">/{p.match_regex}/i</Td>
                <Td>{p.action === "deny" ? <Badge tone="bad">拒绝</Badge> : <Badge tone="warn">需审批</Badge>}</Td>
                <Td className="text-right text-[12px] text-fg-3">v{p.version} · {ago(p.updated_at)}</Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      <PolicyDrawer policy={editing} onClose={() => setEditing(null)} />
    </SettingsLayout>
  );
}

function Scope({ p }: { p: Policy }) {
  const a = p.applies_to;
  if (!a.tasks.length && !a.services.length && !a.envs.length) return <span className="text-[12.5px] text-fg-3">所有提交</span>;
  return (
    <div className="flex flex-wrap items-center gap-1 text-[12px] text-fg-2">
      {a.envs.map((e) => <EnvBadge key={e} env={e} />)}
      {a.services.map((s) => <Badge key={s} tone="outline">{s}</Badge>)}
      {a.tasks.map((t) => <Badge key={t} tone="outline" className="font-mono">{t}</Badge>)}
    </div>
  );
}

const blank: Policy = { name: "", description: "", order: 100, applies_to: { tasks: [], services: [], envs: [] }, match_regex: "", action: "require_approval", message: "", enabled: true, version: 0, updated_by: "", updated_at: "" };

function PolicyDrawer({ policy, onClose }: { policy: Policy | "new" | null; onClose: () => void }) {
  const isNew = policy === "new";
  const base = policy === "new" ? blank : policy;
  const [d, setD] = useState<Policy>(blank);
  const [sample, setSample] = useState("把 10 月测试订单从 ads_gmv_daily 删除后重算");
  const [showHistory, setShowHistory] = useState(false);
  const { data: envs } = useEnvs();
  const { data: services } = useServices();
  const { data: tasks } = useTasks();
  const [key, setKey] = useState<string | null>(null);
  if (base && (base.name || "new") !== key) { setKey(base.name || "new"); setD(structuredClone(base)); setShowHistory(false); }
  const regexError = useMemo(() => { try { new RegExp(d.match_regex, "i"); return null; } catch (e) { return (e as Error).message; } }, [d.match_regex]);
  const hit = !regexError && d.match_regex && new RegExp(d.match_regex, "i").test(sample);
  const save = useMutation(async () => {
    try {
      const { version: _v, updated_by: _u, updated_at: _a, ...body } = d;
      void _v; void _u; void _a;
      if (isNew) await api.create("policies", body); else await api.update("policies", d.name, body);
      toast(isNew ? "策略已创建" : "已保存", { description: "立即对新提交生效" });
      invalidate("policies");
      onClose();
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  });
  return (
    <Drawer open={!!policy} onClose={onClose} width="w-[620px]" title={isNew ? "新建策略" : d.name} subtitle={!isNew && `v${d.version}`}
      actions={!isNew && <Button size="sm" variant="ghost" onClick={() => setShowHistory(!showHistory)}>{showHistory ? "编辑" : "版本"}</Button>}>
      {showHistory && !isNew ? <div className="p-4"><VersionHistory kind="policies" name={d.name} /></div> : (
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-[1fr_100px] gap-3">
            <Field label="名称" required><Input mono value={d.name} disabled={!isNew} onChange={(e) => setD({ ...d, name: e.target.value.trim() })} placeholder="prod-destructive" /></Field>
            <Field label="顺序" help="小的先判"><Input inputMode="numeric" value={d.order} onChange={(e) => setD({ ...d, order: Number(e.target.value) || 0 })} /></Field>
          </div>
          <Field label="说明"><Input value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
          <Field label="动作"><Segmented value={d.action} onChange={(v) => setD({ ...d, action: v })} options={[{ value: "require_approval", label: "需审批" }, { value: "deny", label: "直接拒绝" }]} /></Field>
          <Field label="匹配正则" required error={regexError} help="作用于输入的 JSON 文本，不区分大小写">
            <Input mono value={d.match_regex} onChange={(e) => setD({ ...d, match_regex: e.target.value })} aria-invalid={!!regexError} />
          </Field>
          <Field label="试一下" help={d.match_regex && !regexError ? (hit ? <span className="text-warn">命中 → {d.action === "deny" ? "拒绝" : "挂起等审批"}</span> : <span className="text-ok">未命中 → 放行</span>) : undefined}>
            <Textarea rows={2} value={sample} onChange={(e) => setSample(e.target.value)} />
          </Field>
          <Field label="给调用方 / 审批人看的理由"><Input value={d.message} onChange={(e) => setD({ ...d, message: e.target.value })} placeholder="生产环境的破坏性操作需要人工确认" /></Field>
          <div className="rounded-lg border border-line p-3.5">
            <div className="mb-3 text-[12.5px] font-medium text-fg">作用范围 <span className="font-normal text-fg-3">（都不填 = 所有提交）</span></div>
            <div className="space-y-3">
              <Field label="环境"><TagInput value={d.applies_to.envs} onChange={(v) => setD({ ...d, applies_to: { ...d.applies_to, envs: v } })} suggestions={(envs ?? []).map((e) => e.name)} mono /></Field>
              <Field label="服务"><TagInput value={d.applies_to.services} onChange={(v) => setD({ ...d, applies_to: { ...d.applies_to, services: v } })} suggestions={(services ?? []).map((s) => s.name)} mono /></Field>
              <Field label="任务"><TagInput value={d.applies_to.tasks} onChange={(v) => setD({ ...d, applies_to: { ...d.applies_to, tasks: v } })} suggestions={(tasks ?? []).filter((t) => !t.extends).map((t) => t.name).slice(0, 8)} mono /></Field>
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-line pt-4">
            <Switch checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label="启用" />
            <div className="flex gap-2"><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!d.name || !d.match_regex || !!regexError} loading={save.pending} onClick={() => save.mutate(undefined)}>{isNew ? "创建" : `保存为 v${d.version + 1}`}</Button></div>
          </div>
        </div>
      )}
    </Drawer>
  );
}
