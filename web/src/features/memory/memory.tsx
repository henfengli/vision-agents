/**
 * 记忆：知识（事实）/ 案例（教训）/ 方法（做法与脚本）/ 检索试用。
 * 全部按 服务×环境 分区，可再按任务收窄；人可以直接新建、改正、让条目过期。
 * 知识列表与方法列表也被任务详情页的「记忆」标签复用（固定 task 筛选）。
 */
import { useEffect, useState } from "react";
import {
  LuBookOpen, LuBrain, LuCircleAlert, LuFile, LuGitBranch, LuHistory, LuLightbulb, LuPlus, LuSearch, LuThumbsDown, LuTrash2, LuWrench,
} from "react-icons/lu";

import { api, useAssets, useCases, useEnvs, useKnowledge, useServices, useTasks } from "@/api/hooks";
import type { Asset, AssetKind, Knowledge, MemoryFilters, MemoryHealth } from "@/api/types";
import { EnvFilter, FilterBar, ServiceFilter } from "@/components/filters";
import { Page, PageHeader } from "@/components/layout/shell";
import { EnvBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { CodeBlock, Markdown, Tabs, Table, Td, Th, Tr } from "@/components/ui/data";
import { Field, FilterSelect, Input, SearchInput, Segmented, Select, Textarea } from "@/components/ui/form";
import { Dialog, Drawer, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, DescList, Empty, SectionTitle, Skeleton, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, bytes, shortId } from "@/lib/format";
import { invalidate, useMutation, useQuery } from "@/lib/query";
import { Link, useSearch } from "@/lib/router";
import { useUi } from "@/lib/store";

type Tab = "knowledge" | "cases" | "assets" | "playground";

/** 新建条目时预填的归属；给定的项在表单里锁定（任务页固定 service/task） */
export interface MemoryScope { service?: string; env?: string; task?: string }

export function MemoryPage() {
  const ui = useUi();
  const [s, setS] = useSearch<{ tab: Tab; service: string; env: string; task: string; status: string; q: string; kind: string; id: string }>();
  const tab = s.tab ?? "knowledge";
  const env = s.env ?? ui.env;
  const filters: MemoryFilters = { service: s.service, env: env || undefined, task: s.task, status: s.status, q: s.q };
  const active = !!(s.service || s.env || s.task || s.status || s.q || s.kind);
  const clear = () => setS({ service: undefined, env: undefined, task: undefined, status: undefined, q: undefined, kind: undefined });
  return (
    <Page wide>
      <PageHeader title="记忆" description="知识记事实、案例记教训、方法记做法。按 服务×环境 分区，prod 沉淀的口径不会污染 test。" />
      <Tabs className="mb-4" value={tab} onChange={(v) => setS({ tab: v === "knowledge" ? undefined : v })} tabs={[
        { value: "knowledge", label: "知识", icon: <LuBookOpen /> }, { value: "cases", label: "案例", icon: <LuLightbulb /> },
        { value: "assets", label: "方法", icon: <LuWrench /> }, { value: "playground", label: "检索试用", icon: <LuSearch /> },
      ]} />
      <div className="mb-3">
        <FilterBar active={active} onClear={clear}>
          <ServiceFilter value={s.service ?? ""} onChange={(v) => setS({ service: v, task: undefined })} />
          <EnvFilter value={env} onChange={(v) => setS({ env: v })} />
          {tab !== "cases" && <TaskFilter value={s.task ?? ""} service={s.service} onChange={(v) => setS({ task: v })} />}
          {tab === "knowledge" && <FilterSelect label="状态" allLabel="生效中" value={s.status ?? ""} onChange={(v) => setS({ status: v })}
            options={[{ value: "expired", label: "已过期" }, { value: "superseded", label: "被取代" }, { value: "all", label: "全部" }]} />}
          {tab === "assets" && <FilterSelect label="类型" allLabel="全部" value={s.kind ?? ""} onChange={(v) => setS({ kind: v })}
            options={ASSET_KINDS.map((k) => ({ value: k, label: ASSET_KIND[k] }))} />}
          {(tab === "knowledge" || tab === "assets") && <SearchInput value={s.q ?? ""} onChange={(v) => setS({ q: v })} placeholder="关键词…" className="w-56" />}
        </FilterBar>
      </div>
      {tab === "knowledge" && <KnowledgeList filters={filters} scope={{}} openId={Number(s.id) || undefined} showHealth />}
      {tab === "cases" && <Cases service={s.service} env={env} />}
      {tab === "assets" && <AssetList filters={{ ...filters, kind: s.kind }} scope={{}} openId={Number(s.id) || undefined} />}
      {tab === "playground" && <Playground service={s.service} env={env} task={s.task} />}
    </Page>
  );
}

function TaskFilter({ value, service, onChange }: { value: string; service?: string; onChange: (v: string) => void }) {
  const { data } = useTasks(service);
  const options = (data ?? []).filter((t) => !t.extends).map((t) => ({ value: t.name, label: t.name, hint: t.title }));
  return <FilterSelect label="任务" allLabel="全部" value={value} onChange={onChange} options={options} />;
}

// ———————— 知识 ————————

const STATUS_BADGE: Record<Knowledge["status"], React.ReactNode> = {
  active: null, expired: <Badge tone="warn">已过期</Badge>, superseded: <Badge tone="idle">被取代</Badge>,
};

/** openId：从别处（运行详情的召回列表）链接过来时直接打开该条 */
export function KnowledgeList({ filters, scope, openId, showHealth }: { filters: MemoryFilters; scope: MemoryScope; openId?: number; showHealth?: boolean }) {
  const { data, loading } = useKnowledge(filters);
  const { data: health } = useQuery(["memory", "health", filters.service, filters.env],
    () => api.knowledgeHealth({ service: filters.service, env: filters.env }), { enabled: !!showHealth });
  const [selected, setSelected] = useState<number | null>(openId ?? null);
  const [creating, setCreating] = useState(false);
  const entry = data?.find((k) => k.id === selected) ?? null;
  return (
    <Card>
      <CardHeader title="知识" icon={<LuBookOpen />} description="一条一个事实：口径、表的含义、某个坑。召回时按相关度注入，与代码矛盾时以代码为准。"
        actions={<Button size="sm" icon={<LuPlus />} onClick={() => setCreating(true)}>新建知识</Button>} />
      {showHealth && health && <HealthBar health={health} />}
      {loading ? <SkeletonRows /> : !data?.length ? <Empty icon={<LuBrain />} title="没有知识条目" description="运行成功后会自动沉淀可复用的结论；也可以手动录入" /> : (
        <Table>
          <thead><tr><Th>条目</Th><Th>服务 / 环境</Th><Th>任务</Th><Th className="text-right">30 天命中</Th><Th className="text-right">反馈</Th><Th className="text-right">更新</Th></tr></thead>
          <tbody>
            {data.map((k) => (
              <Tr key={k.id} onClick={() => setSelected(k.id)} className={cn(k.status !== "active" && "opacity-70")}>
                <Td className="max-w-[520px]">
                  <div className="flex items-center gap-2">
                    <code className="truncate font-mono text-[12.5px] font-medium text-fg">{k.key}</code>
                    {STATUS_BADGE[k.status]}
                    {!k.source_run && <Badge tone="outline">人工</Badge>}
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-fg-3">{k.content}</div>
                </Td>
                <Td><span className="flex items-center gap-1.5 text-[12.5px] text-fg-2">{k.service}<EnvBadge env={k.env} /></span></Td>
                <Td className="font-mono text-[11.5px] text-fg-3">{k.task || "服务通用"}</Td>
                <Td className={cn("text-right tabular-nums", k.hits_30d === 0 ? "text-warn" : "text-fg-2")}>{k.hits_30d}</Td>
                <Td className={cn("text-right tabular-nums", k.feedback_score < 0 ? "text-bad" : "text-fg-3")}>{k.feedback_score > 0 ? "+" : ""}{k.feedback_score}</Td>
                <Td className="text-right text-[12px] text-fg-3">{ago(k.updated_at)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <KnowledgeDrawer entry={entry} onClose={() => setSelected(null)} />
      <KnowledgeDialog open={creating} scope={scope} onClose={() => setCreating(false)} />
    </Card>
  );
}

function HealthBar({ health }: { health: MemoryHealth }) {
  const cells: [string, number, "" | "warn" | "bad"][] = [
    ["生效", health.active, ""], ["零召回 30 天", health.zero_recall, "warn"], ["负反馈", health.negative, "bad"],
    ["代码漂移", health.drifted, "warn"], ["疑似矛盾", health.conflicts, "warn"],
  ];
  return (
    <div className="grid grid-cols-5 divide-x divide-line border-b border-line text-center">
      {cells.map(([label, n, tone]) => (
        <div key={label} className="px-3 py-2.5">
          <div className={cn("text-[17px] font-semibold tabular-nums", n > 0 && tone === "bad" ? "text-bad" : n > 0 && tone === "warn" ? "text-warn" : "text-fg")}>{n}</div>
          <div className="text-[11.5px] text-fg-3">{label}</div>
        </div>
      ))}
    </div>
  );
}

/** 归属三件套：服务、环境、任务 */
type Where = { service: string; env: string; task: string };

function WhereFields({ value, onChange, locked }: { value: Where; onChange: (v: Where) => void; locked: MemoryScope }) {
  const { data: services } = useServices();
  const { data: envs } = useEnvs();
  const { data: tasks } = useTasks(value.service || undefined);
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="服务" required>
        <Select value={value.service} disabled={!!locked.service} onChange={(service) => onChange({ ...value, service, task: "" })}
          options={(services ?? []).map((s) => ({ value: s.name, label: s.name, hint: s.title }))} />
      </Field>
      <Field label="环境" required>
        <Select value={value.env} disabled={!!locked.env} onChange={(env) => onChange({ ...value, env })}
          options={(envs ?? []).map((e) => ({ value: e.name, label: <span className="font-mono uppercase">{e.name}</span>, hint: e.title }))} />
      </Field>
      <Field label="任务" help="不选 = 服务内所有任务都能召回">
        <Select value={value.task} disabled={!!locked.task} onChange={(task) => onChange({ ...value, task })}
          options={[{ value: "", label: "服务通用" }, ...(tasks ?? []).map((t) => ({ value: t.name, label: t.name, hint: t.title }))]} />
      </Field>
    </div>
  );
}

/** 对话框每次打开时，按 scope → 顶栏环境 → 第一个服务 重新预填归属 */
function useWhere(open: boolean, scope: MemoryScope) {
  const ui = useUi();
  const { data: services } = useServices();
  const initial = (): Where => ({ service: scope.service ?? services?.[0]?.name ?? "", env: scope.env || ui.env || "prod", task: scope.task ?? "" });
  const [where, setWhere] = useState(initial);
  useEffect(() => { if (open) setWhere(initial()); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return [where, setWhere] as const;
}

function KnowledgeDialog({ open, scope, onClose }: { open: boolean; scope: MemoryScope; onClose: () => void }) {
  const [where, setWhere] = useWhere(open, scope);
  const [key, setKey] = useState("");
  const [content, setContent] = useState("");
  useEffect(() => { if (open) { setKey(""); setContent(""); } }, [open]);
  const valid = !!where.service && !!where.env && /^[\w.:-]{2,120}$/.test(key) && !!content.trim();
  const save = useMutation(async () => {
    try {
      await api.createKnowledge({ ...where, key, content });
      toast("已录入", { description: "人工录入的条目召回时优先"});
      invalidate("memory");
      onClose();
    } catch (e) { toast.error("录入失败", (e as Error).message); }
  });
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="新建知识" description="写一个能独立成立的事实；agent 召回时只看到这一条。"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!valid} loading={save.pending} onClick={() => save.mutate(undefined)}>录入</Button></>}>
      <div className="space-y-4">
        <WhereFields value={where} onChange={setWhere} locked={scope} />
        <Field label="键" required help="同一 服务×环境 内唯一，用点分层：metric.gmv、table.dwd_trade_order.grain">
          <Input mono autoFocus value={key} onChange={(e) => setKey(e.target.value.trim())} placeholder="metric.gmv" />
        </Field>
        <Field label="内容" required>
          <Textarea rows={6} value={content} onChange={(e) => setContent(e.target.value)} placeholder="GMV 口径：已支付订单金额，不扣退款；退款单独看 refund_amount。" />
        </Field>
      </div>
    </Dialog>
  );
}

function KnowledgeDrawer({ entry, onClose }: { entry: Knowledge | null; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  useEffect(() => { setEditing(false); setText(entry?.content ?? ""); }, [entry?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: history } = useQuery(["memory", "history", entry?.id], () => api.knowledgeHistory(entry!.id), { enabled: !!entry });

  const update = async (body: { content?: string; status?: "active" | "expired" }, message: string) => {
    if (!entry) return;
    try {
      await api.patchKnowledge(entry.id, body);
      toast(message);
      invalidate("memory");
      setEditing(false);
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  };
  const save = useMutation(() => update({ content: text, status: "active" }, "已保存，旧内容进历史"));
  const expire = async () => {
    const ok = await confirm({ title: `让 ${entry?.key} 过期？`, description: "过期后不再被召回，仍可在「已过期」里找到并恢复。", danger: true, confirmText: "过期" });
    if (ok) await update({ status: "expired" }, "已过期");
  };

  return (
    <Drawer open={!!entry} onClose={onClose} title={<code className="font-mono">{entry?.key}</code>} subtitle={entry && `${entry.service} · ${entry.env} · ${entry.task || "服务通用"}`}
      actions={entry && !editing && <>
        <Button size="sm" onClick={() => setEditing(true)}>编辑</Button>
        {entry.status === "active"
          ? <Button size="sm" variant="danger-ghost" onClick={expire}>过期</Button>
          : <Button size="sm" onClick={() => update({ status: "active" }, "已恢复生效")}>恢复生效</Button>}
      </>}>
      {entry && (
        <div className="space-y-5 p-5">
          {entry.status === "expired" && entry.code_ref && (
            <Notice tone="warn" icon={<LuCircleAlert />}>引用的代码在沉淀之后改过（commit 漂移），召回时已跳过。确认仍然成立就编辑保存，它会重新生效。</Notice>
          )}
          {entry.feedback_score < 0 && <Notice tone="bad" icon={<LuThumbsDown />}>收到负反馈，召回排序已降权。建议改正内容或让它过期。</Notice>}
          {editing ? (
            <div className="space-y-2">
              <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} />
              <div className="flex justify-end gap-2"><Button onClick={() => setEditing(false)}>取消</Button><Button variant="primary" loading={save.pending} onClick={() => save.mutate(undefined)}>保存</Button></div>
            </div>
          ) : <div className="rounded-md border border-line bg-sunken/50 p-3.5"><Markdown text={entry.content} /></div>}
          <DescList items={[
            ["状态", { active: "生效中", expired: "已过期", superseded: "被取代" }[entry.status]],
            ["30 天命中", `${entry.hits_30d} 次${entry.last_hit_at ? `，最近 ${ago(entry.last_hit_at)}` : ""}`],
            ["反馈分", String(entry.feedback_score)],
            ["代码引用", entry.code_ref ? <span className="flex items-center gap-1 font-mono text-[12px]"><LuGitBranch className="size-3.5 text-fg-3" />{entry.code_ref.path} @{entry.code_ref.commit}</span> : "无"],
            ["来源", entry.source_run ? <Link to={`/runs/${entry.source_run}`} className="font-mono hover:text-accent">运行 {shortId(entry.source_run)}</Link> : "人工录入"],
          ]} />
          <div>
            <SectionTitle><span className="flex items-center gap-1.5"><LuHistory className="size-3.5" />内容历史</span></SectionTitle>
            {!history ? <Skeleton className="h-16" /> : history.length === 0 ? <div className="text-[12.5px] text-fg-3">没有历史版本</div> : (
              <ol className="space-y-2">
                {history.map((h) => (
                  <li key={h.version} className="rounded-md border border-line p-2.5">
                    <div className="flex items-center gap-2 text-[11.5px] text-fg-3"><span className="font-mono font-semibold text-fg-2">v{h.version}</span>{h.source}<span className="ml-auto">{ago(h.created_at)}</span></div>
                    <div className="mt-1 text-[12.5px] text-fg-2">{h.content}</div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function Notice({ tone, icon, children }: { tone: "warn" | "bad"; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={cn("flex gap-2 rounded-md px-3 py-2 text-[12.5px] [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0", tone === "warn" ? "bg-warn-soft text-warn" : "bg-bad-soft text-bad")}>
      {icon}<span>{children}</span>
    </div>
  );
}

// ———————— 案例 ————————

function Cases({ service, env }: { service?: string; env?: string }) {
  const { data, loading } = useCases({ service, env });
  const remove = async (id: number) => {
    if (!(await confirm({ title: "作废这条案例？", description: "同类报错再出现时不再召回它。", danger: true, confirmText: "作废" }))) return;
    await api.removeCase(id);
    toast("已作废");
    invalidate("memory");
  };
  return (
    <Card>
      <CardHeader title="案例库" icon={<LuLightbulb />} description="报错指纹（抹掉数字/路径/引号后哈希）→ 结论；同类报错再出现时召回。由运行沉淀，不手动新建。" />
      {loading ? <SkeletonRows /> : !data?.length ? <Empty icon={<LuLightbulb />} title="还没有案例" /> : (
        <Table>
          <thead><tr><Th>结论</Th><Th>类别</Th><Th>服务 / 环境</Th><Th>指纹</Th><Th className="text-right">👍 / 👎</Th><Th className="text-right">更新</Th><Th /></tr></thead>
          <tbody>{data.map((c) => (
            <Tr key={c.id} className={cn(c.status !== "active" && "opacity-60")}>
              <Td className="max-w-[460px]">
                <div className="truncate text-[13px] text-fg">{c.conclusion}</div>
                {c.source_run && <Link to={`/runs/${c.source_run}`} className="font-mono text-[11px] text-fg-3 hover:text-accent">{shortId(c.source_run)}</Link>}
              </Td>
              <Td><Badge>{c.category}</Badge></Td>
              <Td><span className="flex items-center gap-1.5 text-[12.5px] text-fg-2">{c.service ?? "—"}<EnvBadge env={c.env} /></span></Td>
              <Td className="font-mono text-[11.5px] text-fg-3">{c.fingerprint}</Td>
              <Td className="text-right tabular-nums text-fg-2">{c.thumbs_up} / {c.thumbs_down}</Td>
              <Td className="text-right text-[12px] text-fg-3">{ago(c.updated_at)}</Td>
              <Td className="w-10 text-right">{c.status === "active" && <Button size="icon" variant="ghost" aria-label="作废" onClick={() => remove(c.id)}><LuTrash2 /></Button>}</Td>
            </Tr>
          ))}</tbody>
        </Table>
      )}
    </Card>
  );
}

// ———————— 方法 ————————

const ASSET_KINDS: AssetKind[] = ["procedure", "script", "query", "baseline"];
const ASSET_KIND: Record<AssetKind, string> = { procedure: "方法", script: "脚本", query: "查询", baseline: "基线" };
const isCode = (kind: AssetKind) => kind === "script" || kind === "query";

export function AssetList({ filters, scope, openId }: { filters: MemoryFilters & { kind?: string }; scope: MemoryScope; openId?: number }) {
  const { data, loading } = useAssets(filters);
  const [selected, setSelected] = useState<number | null>(openId ?? null);
  const [creating, setCreating] = useState(false);
  const list = (data ?? []).filter((a) => !filters.q || (a.name + a.summary).includes(filters.q));
  const asset = data?.find((a) => a.id === selected) ?? null;
  return (
    <Card>
      <CardHeader title="方法" icon={<LuWrench />} description="可复用的做法、脚本、查询、基线。agent 用 save_asset 沉淀，后续运行先召回再复用。"
        actions={<Button size="sm" icon={<LuPlus />} onClick={() => setCreating(true)}>登记方法</Button>} />
      {loading ? <SkeletonRows /> : !list.length ? <Empty icon={<LuWrench />} title="还没有方法沉淀" description="排查套路、核对 SQL、基线数字都适合登记在这里" /> : (
        <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((a) => (
            <button key={a.id} type="button" onClick={() => setSelected(a.id)}
              className={cn("rounded-lg border border-line bg-panel p-4 text-left transition-shadow hover:shadow-[var(--shadow-pop)]", a.status !== "active" && "opacity-60")}>
              <div className="flex items-center gap-2">
                <Badge tone="accent">{ASSET_KIND[a.kind]}</Badge>
                <span className="truncate text-[13px] font-semibold text-fg">{a.name}</span>
                {a.status !== "active" && <Badge tone="idle">已停用</Badge>}
              </div>
              <div className="mt-1.5 line-clamp-2 text-[12.5px] text-fg-2">{a.summary}</div>
              <div className="mt-3 flex items-center gap-3 text-[11.5px] text-fg-3">
                <span>{a.service}</span><EnvBadge env={a.env} /><span className="truncate">{a.task || "服务通用"}</span>
                <span className="ml-auto shrink-0">复用 {a.use_count} 次</span>
                {a.files.length > 0 && <span className="flex items-center gap-0.5"><LuFile className="size-3" />{a.files.length}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
      <AssetDrawer asset={asset} onClose={() => setSelected(null)} />
      <AssetDialog open={creating} scope={scope} onClose={() => setCreating(false)} />
    </Card>
  );
}

const BLANK_ASSET = { kind: "procedure" as AssetKind, name: "", summary: "", content: "" };

function AssetDialog({ open, scope, onClose }: { open: boolean; scope: MemoryScope; onClose: () => void }) {
  const [where, setWhere] = useWhere(open, scope);
  const [d, setD] = useState(BLANK_ASSET);
  useEffect(() => { if (open) setD(BLANK_ASSET); }, [open]);
  const valid = !!where.service && !!where.env && !!d.name.trim() && !!d.summary.trim() && !!d.content.trim();
  const save = useMutation(async () => {
    try {
      await api.createAsset({ ...where, ...d });
      toast("已登记");
      invalidate("memory");
      onClose();
    } catch (e) { toast.error("登记失败", (e as Error).message); }
  });
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="登记方法" description="摘要用于召回排序；内容是 agent 复用时读到的全文。"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!valid} loading={save.pending} onClick={() => save.mutate(undefined)}>登记</Button></>}>
      <div className="space-y-4">
        <WhereFields value={where} onChange={setWhere} locked={scope} />
        <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
          <Field label="类型"><Segmented value={d.kind} onChange={(kind) => setD({ ...d, kind })} options={ASSET_KINDS.map((k) => ({ value: k, label: ASSET_KIND[k] }))} /></Field>
          <Field label="名字" required><Input autoFocus value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="订单表数据量突降排查" /></Field>
        </div>
        <Field label="摘要" required help="一句话：什么时候用它"><Input value={d.summary} onChange={(e) => setD({ ...d, summary: e.target.value })} /></Field>
        <Field label="内容" required help={{ procedure: "步骤清单", baseline: "数字与口径", script: "脚本原文", query: "SQL 原文" }[d.kind]}>
          <Textarea rows={8} mono={isCode(d.kind)} value={d.content} onChange={(e) => setD({ ...d, content: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

function AssetDrawer({ asset, onClose }: { asset: Asset | null; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  const [d, setD] = useState({ summary: "", content: "" });
  useEffect(() => { setEditing(false); setD({ summary: asset?.summary ?? "", content: asset?.content ?? "" }); }, [asset?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = async (body: Parameters<typeof api.patchAsset>[1], message: string) => {
    if (!asset) return;
    try {
      await api.patchAsset(asset.id, body);
      toast(message);
      invalidate("memory");
      setEditing(false);
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  };
  const save = useMutation(() => update(d, "已保存"));
  const retire = async () => {
    const ok = await confirm({ title: `停用 ${asset?.name}？`, description: "停用后不再召回，可随时恢复。", danger: true, confirmText: "停用" });
    if (ok) await update({ status: "superseded" }, "已停用");
  };

  return (
    <Drawer open={!!asset} onClose={onClose} title={asset?.name ?? ""} subtitle={asset && `${ASSET_KIND[asset.kind]} · ${asset.service} · ${asset.env} · ${asset.task || "服务通用"}`}
      actions={asset && !editing && <>
        <Button size="sm" onClick={() => setEditing(true)}>编辑</Button>
        {asset.status === "active"
          ? <Button size="sm" variant="danger-ghost" onClick={retire}>停用</Button>
          : <Button size="sm" onClick={() => update({ status: "active" }, "已恢复")}>恢复</Button>}
      </>}>
      {asset && (
        <div className="space-y-4 p-5">
          {editing ? (
            <div className="space-y-3">
              <Field label="摘要"><Input value={d.summary} onChange={(e) => setD({ ...d, summary: e.target.value })} /></Field>
              <Field label="内容"><Textarea rows={12} mono={isCode(asset.kind)} value={d.content} onChange={(e) => setD({ ...d, content: e.target.value })} /></Field>
              <div className="flex justify-end gap-2"><Button onClick={() => setEditing(false)}>取消</Button><Button variant="primary" loading={save.pending} onClick={() => save.mutate(undefined)}>保存</Button></div>
            </div>
          ) : <>
            <div className="text-[13px] text-fg-2">{asset.summary}</div>
            {asset.content && <CodeBlock code={asset.content} wrap title="内容" />}
          </>}
          {asset.files.length > 0 && (
            <div>
              <SectionTitle>文件</SectionTitle>
              <ul className="divide-y divide-line rounded-md border border-line">{asset.files.map((f) => (
                <li key={f.name} className="flex items-center gap-2 px-3 py-2 text-[12.5px]"><LuFile className="size-3.5 text-fg-3" /><span className="font-mono text-fg">{f.name}</span><span className="ml-auto text-fg-3">{bytes(f.size)}</span></li>
              ))}</ul>
            </div>
          )}
          <DescList items={[
            ["复用", `${asset.use_count} 次${asset.last_used_at ? `，最近 ${ago(asset.last_used_at)}` : ""}`],
            ["反馈分", String(asset.feedback_score)],
            ["来源", asset.source_run ? <Link to={`/runs/${asset.source_run}`} className="font-mono hover:text-accent">运行 {shortId(asset.source_run)}</Link> : "人工登记"],
            ["更新", ago(asset.updated_at)],
          ]} />
        </div>
      )}
    </Drawer>
  );
}

// ———————— 检索试用 ————————

function Playground({ service, env, task }: { service?: string; env?: string; task?: string }) {
  const [query, setQuery] = useState("");
  const [res, setRes] = useState<Awaited<ReturnType<typeof api.searchKnowledge>> | null>(null);
  const run = useMutation(() => api.searchKnowledge({ query, service: service ?? "", env: env ?? "", task }));
  const ready = !!service && !!env;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="检索试用" description="直接跑召回本身：混合检索 + 新鲜度校验 + 反馈加权 + 任务谱系排序。不计入命中统计。" />
        <div className="space-y-3 p-4">
          {!ready && <div className="rounded-md bg-sunken px-3 py-2 text-[12.5px] text-fg-3">召回按 服务×环境 分区：先在上方选定服务和环境；选了任务则按该任务的谱系排序。</div>}
          <Textarea rows={3} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输入一个问题，看 agent 会被喂什么" />
          <div className="flex justify-end">
            <Button variant="primary" icon={<LuSearch />} disabled={!query.trim() || !ready} loading={run.pending} onClick={async () => setRes(await run.mutate(undefined))}>检索</Button>
          </div>
          {res && (
            <ol className="space-y-2 pt-2">
              {res.hits.length === 0 && <div className="text-[12.5px] text-fg-3">没有命中</div>}
              {res.hits.map((h) => (
                <li key={h.id} className="rounded-md border border-line p-2.5">
                  <div className="flex items-center gap-2"><span className="font-mono text-[11px] text-fg-3">#{h.rank}</span><code className="font-mono text-[12.5px] text-fg">{h.key}</code><EnvBadge env={h.env} /></div>
                  <div className="mt-1 text-[12.5px] text-fg-2">{h.content}</div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="注入的提示词块" description="角色实际看到的文本" />
        <div className="p-4">{res ? (res.block ? <CodeBlock code={res.block} wrap maxHeight={520} /> : <div className="text-[12.5px] text-fg-3">无命中，不注入</div>) : <div className="text-[12.5px] text-fg-3">检索后在这里显示</div>}</div>
      </Card>
    </div>
  );
}
