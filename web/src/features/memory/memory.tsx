/**
 * 记忆页。三样东西分开放：
 *   档案 = 人写的：服务 / 任务定义里的 profile，逐字置顶注入（在服务、任务页编辑）
 *   记忆 = agent 记下的：事实 / 报错教训（交接摘要是会话内部用的，不在列表里）
 *   方法 = 可执行的做法与脚本
 * 标签：记忆 · 方法 · 可升格（被反复召回、没挨过 👎 的事实，值得写进档案）· 检索试用。
 * 记忆按服务分区：env 为空的条目对该服务所有环境成立；选某个环境 = 该环境的 + 通用的。
 * 记忆列表与方法列表也被服务 / 任务详情页的「记忆」标签复用。
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  LuArrowUpFromLine, LuBookOpen, LuBrain, LuCircleAlert, LuFile, LuGitBranch, LuHistory, LuLightbulb, LuPlus, LuScrollText, LuSearch,
  LuThumbsDown, LuWrench,
} from "react-icons/lu";

import { api, useAssets, useEnvs, useKnowledge, usePromotable, useServices, useTasks } from "@/api/hooks";
import type { Asset, AssetKind, Knowledge, KnowledgeKind, KnowledgePromote, LessonCategory, MemoryFilters, MemoryHealth } from "@/api/types";
import { EnvFilter, FilterBar, ServiceFilter, envOf, envParam } from "@/components/filters";
import { Page, PageHeader } from "@/components/layout/shell";
import { EnvBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { CodeBlock, Markdown, Tabs, Table, Td, Th, Tr } from "@/components/ui/data";
import { CreatableSelect, Field, FilterSelect, Input, SearchInput, Segmented, Select, Textarea } from "@/components/ui/form";
import { Dialog, Drawer, Tooltip, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, DescList, Empty, SectionTitle, Skeleton, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, bytes, shortId } from "@/lib/format";
import { invalidate, useMutation, useQuery } from "@/lib/query";
import { Link, useSearch } from "@/lib/router";
import { useUi } from "@/lib/store";

type Tab = "knowledge" | "assets" | "promotable" | "playground";
/** 列表的类型筛选：全部（事实 + 教训）/ 事实 / 教训 */
export type KindFilter = "" | "fact" | "lesson";

/** 新建条目时预填的归属；给定的项在表单里锁定（任务页固定 service/task） */
export interface MemoryScope { service?: string; env?: string; task?: string }

export function MemoryPage() {
  const ui = useUi();
  const [s, setS] = useSearch<{ tab: Tab; service: string; env: string; task: string; status: string; q: string; kind: string; id: string; knowledge: string }>();
  const tab = s.tab ?? "knowledge";
  const env = envOf(s.env, ui.env);
  const filters: MemoryFilters = { service: s.service, env: env || undefined, task: s.task, status: s.status, q: s.q };
  const { data: promotable } = usePromotable({ service: s.service, env: env || undefined });
  const active = !!(s.service || s.env || s.task || s.status || s.q || s.kind);
  const clear = () => setS({ service: undefined, env: undefined, task: undefined, status: undefined, q: undefined, kind: undefined });
  const openId = Number(s.id ?? s.knowledge) || undefined;
  const memoryTab = tab === "knowledge" || tab === "promotable";
  return (
    <Page wide>
      <PageHeader title="记忆" description={<>
        档案是人写的（在 <Link to="/services" className="text-accent hover:underline">服务</Link> / <Link to="/tasks" className="text-accent hover:underline">任务</Link> 页编辑，逐字置顶注入）；
        记忆是 agent 记下的事实与报错教训；方法是可执行的做法与脚本。记忆按服务分区，可以只对某个环境成立，也可以对所有环境成立。
      </>} />
      {/* 状态筛选只在「记忆」标签上有：换标签时清掉，免得方法列表被看不见的筛选过滤 */}
      <Tabs className="mb-4" value={tab} onChange={(v) => setS({ tab: v === "knowledge" ? undefined : v, kind: undefined, status: undefined, id: undefined, knowledge: undefined })} tabs={[
        { value: "knowledge", label: "记忆", icon: <LuBrain /> },
        { value: "assets", label: "方法", icon: <LuWrench /> },
        { value: "promotable", label: "可升格", icon: <LuArrowUpFromLine />, count: promotable?.length || null },
        { value: "playground", label: "检索试用", icon: <LuSearch /> },
      ]} />
      <div className="mb-3">
        <FilterBar active={active} onClear={clear}>
          <ServiceFilter value={s.service ?? ""} onChange={(v) => setS({ service: v, task: undefined })} />
          <EnvFilter value={env} onChange={(v) => setS({ env: envParam(v, ui.env) })} includeShared={memoryTab} />
          {(tab === "knowledge" || tab === "assets" || tab === "playground") && <TaskFilter value={s.task ?? ""} service={s.service} onChange={(v) => setS({ task: v })} />}
          {tab === "knowledge" && <FilterSelect label="状态" allLabel="生效中" value={s.status ?? ""} onChange={(v) => setS({ status: v })}
            options={[{ value: "expired", label: "已过期" }, { value: "superseded", label: "被取代" }, { value: "all", label: "全部" }]} />}
          {tab === "assets" && <FilterSelect label="类型" allLabel="全部" value={s.kind ?? ""} onChange={(v) => setS({ kind: v })}
            options={ASSET_KINDS.map((k) => ({ value: k, label: ASSET_KIND[k] }))} />}
          {(tab === "knowledge" || tab === "assets") && <SearchInput value={s.q ?? ""} onChange={(v) => setS({ q: v })} placeholder="关键词…" className="w-56" />}
        </FilterBar>
      </div>
      {tab === "knowledge" && (
        <KnowledgeList filters={filters} scope={{}} openId={openId} showHealth
          kind={(s.kind === "fact" || s.kind === "lesson" ? s.kind : "") as KindFilter} onKindChange={(v) => setS({ kind: v })}
          onShowPromotable={() => setS({ tab: "promotable", kind: undefined })} />
      )}
      {tab === "assets" && <AssetList filters={{ ...filters, kind: s.kind }} scope={{}} openId={openId} />}
      {tab === "promotable" && <PromotableList service={s.service} env={env || undefined} />}
      {tab === "playground" && <Playground service={s.service} env={env} task={s.task} />}
    </Page>
  );
}

function TaskFilter({ value, service, onChange }: { value: string; service?: string; onChange: (v: string) => void }) {
  const { data } = useTasks(service);
  const options = (data ?? []).filter((t) => !t.extends).map((t) => ({ value: t.name, label: t.name, hint: t.title }));
  return <FilterSelect label="任务" allLabel="全部" value={value} onChange={onChange} options={options} />;
}

// ———————— 小件 ————————

const STATUS_BADGE: Record<Knowledge["status"], ReactNode> = {
  active: null, expired: <Badge tone="warn">已过期</Badge>, superseded: <Badge tone="idle">被取代</Badge>,
};

export const KNOWLEDGE_KIND: Record<KnowledgeKind, { label: string; tone: "neutral" | "accent" | "idle"; icon: ReactNode }> = {
  fact: { label: "事实", tone: "neutral", icon: <LuBookOpen /> },
  lesson: { label: "教训", tone: "accent", icon: <LuLightbulb /> },
  handoff: { label: "交接摘要", tone: "idle", icon: <LuHistory /> },
};

export function KindBadge({ kind, className }: { kind: KnowledgeKind; className?: string }) {
  const k = KNOWLEDGE_KIND[kind] ?? KNOWLEDGE_KIND.fact;
  return <Badge tone={k.tone} icon={k.icon} className={className}>{k.label}</Badge>;
}

const LESSON_CATEGORIES: LessonCategory[] = ["code", "data", "infra", "upstream"];
const CATEGORY_LABEL: Record<string, string> = { code: "代码", data: "数据", infra: "基础设施", upstream: "上游" };

/** 记忆的环境：空 = 对该服务所有环境成立 */
export function ScopeEnv({ env }: { env: string }) {
  return env ? <EnvBadge env={env} /> : <Badge tone="outline">所有环境</Badge>;
}

/** 教训：类别 + 指纹前 8 位 */
function LessonMeta({ k }: { k: Knowledge }) {
  return (
    <>
      {k.category && <Badge tone="outline">{CATEGORY_LABEL[k.category] ?? k.category}</Badge>}
      {k.fingerprint && <Tooltip content={`报错指纹 ${k.fingerprint}：同类报错再出现时按它精确命中`}><code className="font-mono text-[11px] text-fg-3">#{k.fingerprint.slice(0, 8)}</code></Tooltip>}
    </>
  );
}

/** 只罚不奖：0 不显示 */
function Penalty({ score }: { score: number }) {
  return score < 0 ? <span className="tabular-nums text-bad">{score}</span> : null;
}

/** superseded_by = "profile:service:vision-board:conventions" / "profile:service:vision-board@prod:pitfalls" / "profile:task:failure-analysis:dws_account_pnl_daily:pitfalls" */
function promotedTo(by: string | null): { label: string; href: string; key: string } | null {
  if (!by?.startsWith("profile:")) return null;
  const rest = by.slice("profile:".length);
  const cut = rest.lastIndexOf(":");
  const target = rest.slice(0, cut), key = rest.slice(cut + 1);
  const [type, ...nameParts] = target.split(":");
  const name = nameParts.join(":");
  if (type === "service") {
    const [svc, env] = name.split("@");
    return { label: `服务 ${svc}${env ? `（${env}）` : ""}`, href: `/services/${svc}?tab=config&part=definition${env ? `&env=${env}` : ""}`, key };
  }
  return { label: `任务 ${name}`, href: `/tasks/${encodeURIComponent(name)}?tab=profile`, key };
}

/** 升格回执里的 target（service:vision-board / service:vision-board@prod / task:data-qa）→ 人话 */
function targetLabel(target: string): string {
  const [type, ...rest] = target.split(":");
  const name = rest.join(":");
  if (type === "service") { const [svc, env] = name.split("@"); return `服务 ${svc}${env ? `（${env}）` : ""}`; }
  return `任务 ${name}`;
}

// ———————— 记忆列表 ————————

/**
 * openId：从别处（运行详情的召回列表、全局搜索）链接过来时直接打开该条（不在当前筛选里也能打开）。
 * kind / onKindChange：给了就受控（记忆页放在 URL 里），否则组件自己记。
 */
export function KnowledgeList({ filters, scope, openId, showHealth, kind, onKindChange, onShowPromotable }: {
  filters: MemoryFilters; scope: MemoryScope; openId?: number; showHealth?: boolean;
  kind?: KindFilter; onKindChange?: (v: KindFilter) => void; onShowPromotable?: () => void;
}) {
  const [localKind, setLocalKind] = useState<KindFilter>("");
  const k = onKindChange ? kind ?? "" : localKind;
  const setKind = onKindChange ?? setLocalKind;
  const { data, loading } = useKnowledge({ ...filters, kind: k || undefined });
  const { data: health } = useQuery(["memory", "health", filters.service, filters.env],
    () => api.knowledgeHealth({ service: filters.service, env: filters.env }), { enabled: !!showHealth });
  const [selected, setSelected] = useState<number | null>(openId ?? null);
  /** 已在记忆页时再从全局搜索 / 链接点进另一条：跟着打开 */
  useEffect(() => { if (openId) setSelected(openId); }, [openId]);
  const [creating, setCreating] = useState(false);
  const [promoting, setPromoting] = useState<Knowledge | null>(null);
  const listed = data?.find((x) => x.id === selected);
  const { data: fetched } = useQuery(["memory", "one", selected], () => api.knowledgeEntry(selected!), { enabled: !!selected && !!data && !listed });
  const entry = listed ?? (fetched?.id === selected ? fetched : null) ?? null;
  return (
    <Card>
      <CardHeader title="记忆" icon={<LuBrain />}
        description="agent 记下的：事实（口径、表的含义、环境差异）与报错教训（同类报错按指纹命中）。召回时按相关度注入，与代码矛盾时以代码为准；只罚不奖——被 👎 的运行沉淀或召回过的条目会扣分、排序靠后。"
        actions={<>
          <Segmented size="sm" value={k} onChange={setKind} options={[{ value: "", label: "全部" }, { value: "fact", label: "事实" }, { value: "lesson", label: "教训" }]} />
          <Button size="sm" icon={<LuPlus />} onClick={() => setCreating(true)}>新建记忆</Button>
        </>} />
      {showHealth && health && <HealthBar health={health} onShowPromotable={onShowPromotable} />}
      {loading ? <SkeletonRows /> : !data?.length ? (
        <Empty icon={<LuBrain />} title={k === "lesson" ? "没有教训" : k === "fact" ? "没有事实" : "没有记忆条目"}
          description="运行结束后会自动记下可复用的结论与报错教训；也可以手动录入" />
      ) : (
        <Table>
          <thead><tr><Th>条目</Th><Th>服务 / 环境</Th><Th>任务</Th><Th className="text-right">30 天命中</Th><Th className="text-right">👎 扣分</Th><Th className="text-right">更新</Th></tr></thead>
          <tbody>
            {data.map((x) => (
              <Tr key={x.id} onClick={() => setSelected(x.id)} className={cn(x.status !== "active" && "opacity-70")}>
                <Td className="max-w-[520px]">
                  <div className="flex items-center gap-2">
                    <KindBadge kind={x.kind} />
                    {x.kind === "lesson" ? <LessonMeta k={x} /> : <code className="truncate font-mono text-[12.5px] font-medium text-fg">{x.key}</code>}
                    {STATUS_BADGE[x.status]}
                    {promotedTo(x.superseded_by) && <Badge tone="ok" icon={<LuScrollText />}>已升格</Badge>}
                    {!x.source_run && <Badge tone="outline">人工</Badge>}
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-fg-3">{x.content.split("\n")[0]}</div>
                </Td>
                <Td><span className="flex items-center gap-1.5 text-[12.5px] text-fg-2">{x.service}<ScopeEnv env={x.env} /></span></Td>
                <Td className="font-mono text-[11.5px] text-fg-3">{x.task || "服务通用"}</Td>
                <Td className={cn("text-right tabular-nums", x.hits_30d === 0 ? "text-warn" : "text-fg-2")}>{x.hits_30d}</Td>
                <Td className="text-right"><Penalty score={x.feedback_score} /></Td>
                <Td className="text-right text-[12px] text-fg-3">{ago(x.updated_at)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <KnowledgeDrawer entry={entry} onClose={() => setSelected(null)} onPromote={setPromoting} />
      <KnowledgeDialog open={creating} scope={scope} defaultKind={k === "lesson" ? "lesson" : "fact"} onClose={() => setCreating(false)} />
      <PromoteDialog entry={promoting} onClose={() => setPromoting(null)} />
    </Card>
  );
}

function HealthBar({ health, onShowPromotable }: { health: MemoryHealth; onShowPromotable?: () => void }) {
  const cells: [string, number, "" | "warn" | "bad" | "ok", (() => void)?][] = [
    ["生效", health.active, ""], ["其中教训", health.lessons, ""], ["可升格", health.promotable, "ok", onShowPromotable],
    ["零召回 30 天", health.zero_recall, "warn"], ["挨过 👎", health.negative, "bad"],
    ["代码漂移", health.drifted, "warn"], ["疑似矛盾", health.conflicts, "warn"],
  ];
  return (
    <div className="grid grid-cols-4 divide-x divide-line border-b border-line text-center sm:grid-cols-7">
      {cells.map(([label, n, tone, onClick]) => {
        const body = <>
          <div className={cn("text-[17px] font-semibold tabular-nums", n > 0 && tone === "bad" ? "text-bad" : n > 0 && tone === "warn" ? "text-warn" : n > 0 && tone === "ok" ? "text-ok" : "text-fg")}>{n}</div>
          <div className="text-[11.5px] text-fg-3">{label}</div>
        </>;
        return onClick && n > 0
          ? <button key={label} type="button" onClick={onClick} className="px-3 py-2.5 hover:bg-hover/70">{body}</button>
          : <div key={label} className="px-3 py-2.5">{body}</div>;
      })}
    </div>
  );
}

/** 归属三件套：服务、环境、任务 */
type Where = { service: string; env: string; task: string };

/** sharedEnv：环境下拉多一项"所有环境"（值为空串，记忆用）；方法按环境存，没有这一项 */
function WhereFields({ value, onChange, locked, sharedEnv }: { value: Where; onChange: (v: Where) => void; locked: MemoryScope; sharedEnv?: boolean }) {
  const { data: services } = useServices();
  const { data: envs } = useEnvs();
  const { data: tasks } = useTasks(value.service || undefined);
  const envOptions = (envs ?? []).map((e) => ({ value: e.name, label: <span className="font-mono uppercase">{e.name}</span>, hint: e.title }));
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="服务" required>
        <Select value={value.service} disabled={!!locked.service} onChange={(service) => onChange({ ...value, service, task: "" })}
          options={(services ?? []).map((s) => ({ value: s.name, label: s.name, hint: s.title }))} />
      </Field>
      <Field label="环境" required={!sharedEnv} help={sharedEnv ? "只在某个环境成立才选环境" : undefined}>
        <Select value={value.env} disabled={!!locked.env} onChange={(env) => onChange({ ...value, env })}
          options={sharedEnv ? [{ value: "", label: "所有环境", hint: "对该服务的每个环境都成立" }, ...envOptions] : envOptions} />
      </Field>
      <Field label="任务" help="不选 = 服务内所有任务都能召回">
        <Select value={value.task} disabled={!!locked.task} onChange={(task) => onChange({ ...value, task })}
          options={[{ value: "", label: "服务通用" }, ...(tasks ?? []).map((t) => ({ value: t.name, label: t.name, hint: t.title }))]} />
      </Field>
    </div>
  );
}

/** 对话框每次打开时重新预填归属：scope → （方法）顶栏环境 / （记忆）所有环境 → 第一个服务 */
function useWhere(open: boolean, scope: MemoryScope, sharedEnv = false) {
  const ui = useUi();
  const { data: services } = useServices();
  const initial = (): Where => ({ service: scope.service ?? services?.[0]?.name ?? "", env: scope.env ?? (sharedEnv ? "" : ui.env || "prod"), task: scope.task ?? "" });
  const [where, setWhere] = useState(initial);
  useEffect(() => { if (open) setWhere(initial()); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return [where, setWhere] as const;
}

function KnowledgeDialog({ open, scope, defaultKind, onClose }: { open: boolean; scope: MemoryScope; defaultKind: "fact" | "lesson"; onClose: () => void }) {
  const [where, setWhere] = useWhere(open, scope, true);
  const [kind, setKind] = useState<"fact" | "lesson">(defaultKind);
  const [key, setKey] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [category, setCategory] = useState<LessonCategory>("code");
  useEffect(() => { if (open) { setKind(defaultKind); setKey(""); setContent(""); setError(""); setCategory("code"); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = !!where.service && !!content.trim() && (kind === "fact" ? /^[\w.:-]{2,120}$/.test(key) : !!error.trim());
  const save = useMutation(async () => {
    try {
      await api.createKnowledge(kind === "fact"
        ? { ...where, kind, key, content }
        : { ...where, kind, content, error, category });
      toast("已记下", { description: kind === "lesson" ? "同类报错再出现时按指纹命中" : "人工录入的条目召回时优先" });
      invalidate("memory");
      onClose();
    } catch (e) { toast.error("录入失败", (e as Error).message); }
  });
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="新建记忆"
      description={kind === "fact" ? "写一个能独立成立的事实；agent 召回时只看到这一条。" : "贴上报错原文、写下结论：按报错算指纹，同类报错再出现时直接命中这条教训。"}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!valid} loading={save.pending} onClick={() => save.mutate(undefined)}>录入</Button></>}>
      <div className="space-y-4">
        <Field label="类型">
          <Segmented value={kind} onChange={setKind} options={[{ value: "fact", label: "事实", icon: <LuBookOpen /> }, { value: "lesson", label: "报错教训", icon: <LuLightbulb /> }]} />
        </Field>
        <WhereFields value={where} onChange={setWhere} locked={scope} sharedEnv />
        {kind === "fact" ? <>
          <Field label="键" required help="同一服务、同一环境范围内唯一，用点或冒号分层：metric:account_pnl、table.dws_account_pnl_daily.grain">
            <Input mono autoFocus value={key} onChange={(e) => setKey(e.target.value.trim())} placeholder="metric:account_pnl" />
          </Field>
          <Field label="内容" required>
            <Textarea rows={6} value={content} onChange={(e) => setContent(e.target.value)} placeholder="账户收益口径：按交易日汇总已实现 + 浮动盈亏，单位元；数据在 ClickHouse 的 dws_account_pnl_daily。" />
          </Field>
        </> : <>
          <Field label="报错原文" required help="按它算指纹（抹掉数字、路径、引号里的内容后取末两行），不用自己删敏感的可变部分">
            <Textarea mono rows={4} autoFocus value={error} onChange={(e) => setError(e.target.value)} placeholder={"KeyError: 'account_id'\n  File \"/home/vision-service/deploy/vision-dagster/vision_dagster/assets/pnl.py\", line 88, in account_pnl_daily"} />
          </Field>
          <Field label="类别">
            <Segmented value={category} onChange={setCategory} options={LESSON_CATEGORIES.map((c) => ({ value: c, label: `${CATEGORY_LABEL[c]} ${c}` }))} />
          </Field>
          <Field label="结论" required help="下次遇到同类报错时 agent 看到的话：根因 + 怎么处理">
            <Textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} placeholder="上游成交表新加的子账户没有 account_id：account_pnl_daily() 里先按 sub_account 映射再汇总。" />
          </Field>
        </>}
      </div>
    </Dialog>
  );
}

function KnowledgeDrawer({ entry, onClose, onPromote }: { entry: Knowledge | null; onClose: () => void; onPromote: (k: Knowledge) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  useEffect(() => { setEditing(false); setText(entry?.content ?? ""); }, [entry?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: history } = useQuery(["memory", "history", entry?.id], () => api.knowledgeHistory(entry!.id), { enabled: !!entry });
  const promoted = promotedTo(entry?.superseded_by ?? null);
  const [busy, setBusy] = useState(false);

  const update = async (body: { content?: string; status?: "active" | "expired" }, message: string) => {
    if (!entry) return;
    setBusy(true);
    try {
      await api.patchKnowledge(entry.id, body);
      toast(message);
      invalidate("memory");
      setEditing(false);
    } catch (e) { toast.error("保存失败", (e as Error).message); } finally { setBusy(false); }
  };
  const save = useMutation(() => update({ content: text, status: "active" }, "已保存，旧内容进历史"));
  const expire = async () => {
    const ok = await confirm({ title: `让这条${entry ? KNOWLEDGE_KIND[entry.kind].label : "记忆"}过期？`, description: "过期后不再被召回，仍可在「已过期」里找到并恢复。", danger: true, confirmText: "过期" });
    if (ok) await update({ status: "expired" }, "已过期");
  };
  const title = !entry ? "" : entry.kind === "lesson"
    ? <span className="flex items-center gap-2">教训{entry.fingerprint && <code className="font-mono text-[12.5px] font-normal text-fg-3">#{entry.fingerprint.slice(0, 8)}</code>}</span>
    : <code className="font-mono">{entry.key}</code>;

  return (
    <Drawer open={!!entry} onClose={onClose} title={title} subtitle={entry && `${entry.service} · ${entry.env || "所有环境"} · ${entry.task || "服务通用"}`}
      actions={entry && !editing && <>
        <Button size="sm" disabled={busy} onClick={() => setEditing(true)}>编辑</Button>
        {entry.status === "active" && entry.kind !== "handoff" && (
          <Tooltip content="写进服务或任务的档案：逐字置顶注入、不会过期">
            <span><Button size="sm" icon={<LuArrowUpFromLine />} disabled={busy} onClick={() => onPromote(entry)}>升格进档案</Button></span>
          </Tooltip>
        )}
        {entry.status === "active"
          ? <Button size="sm" variant="danger-ghost" loading={busy} onClick={expire}>过期</Button>
          : <Button size="sm" loading={busy} onClick={() => update({ status: "active" }, "已恢复生效")}>恢复生效</Button>}
      </>}>
      {entry && (
        <div className="space-y-5 p-5">
          {promoted && (
            <Notice tone="ok" icon={<LuScrollText />}>
              已升格进 <Link to={promoted.href} className="font-medium underline-offset-2 hover:underline">{promoted.label}</Link> 的档案（<code className="font-mono">{promoted.key}</code>），召回时不再重复注入。
            </Notice>
          )}
          {entry.status === "expired" && entry.code_ref && (
            <Notice tone="warn" icon={<LuCircleAlert />}>引用的代码在记下之后改过（commit 漂移），召回时已跳过。确认仍然成立就编辑保存，它会重新生效。</Notice>
          )}
          {entry.feedback_score < 0 && <Notice tone="bad" icon={<LuThumbsDown />}>被 👎 的运行记下或召回过它，召回排序已扣分（{entry.feedback_score}）。建议改正内容或让它过期。</Notice>}
          {editing ? (
            <div className="space-y-2">
              <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} />
              <div className="flex justify-end gap-2"><Button onClick={() => { setEditing(false); setText(entry.content); }}>取消</Button><Button variant="primary" loading={save.pending} onClick={() => save.mutate(undefined)}>保存</Button></div>
            </div>
          ) : <div className="rounded-md border border-line bg-sunken/50 p-3.5"><Markdown text={entry.content} /></div>}
          <DescList items={[
            ["类型", <span className="flex items-center gap-1.5"><KindBadge kind={entry.kind} />{entry.kind === "lesson" && entry.category && <Badge tone="outline">{CATEGORY_LABEL[entry.category] ?? entry.category}</Badge>}</span>],
            ...(entry.kind === "lesson" ? [["报错指纹", <span className="font-mono text-[12px]">{entry.fingerprint ?? "—"}</span>] as [ReactNode, ReactNode]] : []),
            ["状态", { active: "生效中", expired: "已过期", superseded: "被取代" }[entry.status]],
            ...(entry.superseded_by && !promoted ? [["被谁取代", <code className="font-mono text-[12px]">{entry.superseded_by}</code>] as [ReactNode, ReactNode]] : []),
            ["环境", entry.env ? <EnvBadge env={entry.env} /> : "所有环境（对该服务每个环境都成立）"],
            ["30 天命中", `${entry.hits_30d} 次${entry.last_hit_at ? `，最近 ${ago(entry.last_hit_at)}` : ""}`],
            ["👎 扣分", entry.feedback_score < 0 ? <span className="text-bad">{entry.feedback_score}</span> : <span className="text-fg-3">无</span>],
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

function Notice({ tone, icon, children }: { tone: "warn" | "bad" | "ok" | "info"; icon: ReactNode; children: ReactNode }) {
  return (
    <div className={cn("flex gap-2 rounded-md px-3 py-2 text-[12.5px] [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
      { warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad", ok: "bg-ok-soft text-ok", info: "bg-info-soft text-info" }[tone])}>
      {icon}<span>{children}</span>
    </div>
  );
}

// ———————— 升格进档案 ————————

/** 档案的常用键（与服务 / 任务档案编辑器一致）；也可以自定义 */
const PROFILE_KEYS: { key: string; label: string }[] = [
  { key: "conventions", label: "口径与术语" }, { key: "no_go", label: "禁区" }, { key: "env_notes", label: "环境差异" },
  { key: "pitfalls", label: "常见坑" }, { key: "code_refs", label: "代码位置" }, { key: "upstream", label: "上游依赖" },
  { key: "runbook", label: "运维备注" },
];

/**
 * 记忆 → 档案：写进服务档案（条目只在某环境成立时写进该环境的档案覆盖）或任务档案；同一个键已有内容就接在后面。
 * 原条目变成"被取代"，召回时不再重复注入。
 */
export function PromoteDialog({ entry, onClose }: { entry: Knowledge | null; onClose: () => void }) {
  const open = !!entry;
  const [target, setTarget] = useState<"service" | "task">("service");
  const [key, setKey] = useState("conventions");
  const [task, setTask] = useState("");
  const [text, setText] = useState("");
  const { data: tasks } = useTasks(entry?.service);
  const { data: svc } = useQuery(["services", entry?.service], () => api.service(entry!.service), { enabled: !!entry });
  useEffect(() => {
    if (!entry) return;
    setTarget("service");
    setKey(entry.kind === "lesson" ? "pitfalls" : "conventions");
    setTask(entry.task);
    // 教训的正文末尾带着"（报错：…）"，写进档案时只留结论
    setText(entry.kind === "lesson" ? entry.content.replace(/\n（报错：[^\n]*）\s*$/, "").trim() : entry.content);
  }, [entry?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const taskOptions = (tasks ?? []).filter((t) => t.service === entry?.service || t.service === "*")
    .map((t) => ({ value: t.name, label: t.name, hint: t.service === "*" ? `${t.title || t.name} · 通用任务：档案对所有服务生效` : t.title || (t.extends ? `${t.extends} 的子任务` : undefined) }));
  const existing = target === "service"
    ? (entry?.env ? svc?.envs[entry.env]?.profile?.[key] : svc?.profile[key])
    : tasks?.find((t) => t.name === task)?.profile[key];
  const keyError = !key.trim() ? "档案的键不能为空" : key.length > 60 ? "不超过 60 个字符" : null;
  const valid = !!entry && !keyError && !!text.trim() && (target === "service" || !!task);

  const submit = useMutation(async () => {
    if (!entry) return;
    const body: KnowledgePromote = { target, key: key.trim() };
    if (target === "task") body.task = task;
    if (text.trim() !== entry.content.trim()) body.content = text.trim();
    try {
      const res = await api.promoteKnowledge(entry.id, body);
      toast(`已写进 ${targetLabel(res.profile.target)} 的档案`, { description: `${res.profile.key} · 原记忆已标为被取代，召回时不再重复注入` });
      invalidate("memory");
      invalidate("services");
      invalidate("tasks");
      onClose();
    } catch (e) { toast.error("升格失败", (e as Error).message); }
  });

  return (
    <Dialog open={open} onClose={onClose} size="lg" title="升格进档案"
      description="被反复用到、确认无误的记忆写进档案：逐字置顶注入、不会过期、不走召回。原条目会标为被取代。"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" icon={<LuArrowUpFromLine />} disabled={!valid} loading={submit.pending} onClick={() => submit.mutate(undefined)}>写进档案</Button></>}>
      {entry && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-sunken/50 px-3 py-2 text-[12.5px] text-fg-2">
            <KindBadge kind={entry.kind} />
            {entry.kind === "lesson" ? <LessonMeta k={entry} /> : <code className="font-mono text-fg">{entry.key}</code>}
            <span className="text-fg-3">·</span>{entry.service}<ScopeEnv env={entry.env} />
            <span className="ml-auto text-[11.5px] text-fg-3">30 天命中 {entry.hits_30d} 次</span>
          </div>
          <Field label="写进">
            <Segmented value={target} onChange={setTarget} options={[
              { value: "service", label: `服务档案 · ${entry.service}` },
              { value: "task", label: "任务档案" },
            ]} />
          </Field>
          {target === "service" && entry.env && (
            <Notice tone="info" icon={<LuCircleAlert />}>
              这条记忆只在 {entry.env} 成立：会写进该环境的档案覆盖（服务 → 配置 → 环境 → 档案补充），其他环境看不到。
            </Notice>
          )}
          {target === "task" && (
            <Field label="任务" required help={entry.task ? `默认是这条记忆的来源任务 ${entry.task}` : "这条记忆没有来源任务，选一个写进去"}>
              <Select value={task || null} onChange={setTask} placeholder="选择任务" options={taskOptions} />
            </Field>
          )}
          <Field label="档案的键" required error={keyError} help="常用键可直接选，也可以输入自定义的键">
            <CreatableSelect value={key} onChange={setKey} createLabel="自定义" placeholder="conventions"
              options={PROFILE_KEYS.map((p) => ({ value: p.key, label: p.key, hint: p.label }))}
              validate={(v) => (v.length > 60 ? "不超过 60 个字符" : null)} />
          </Field>
          {existing && (
            <div className="rounded-md border border-dashed border-line px-3 py-2 text-[12px] text-fg-3">
              <div className="mb-0.5 font-medium text-fg-2">该键已有内容，新文字会接在后面（已包含就不重复）</div>
              <div className="line-clamp-3 whitespace-pre-wrap">{existing}</div>
            </div>
          )}
          <Field label="写进档案的文字" required help="可以改写得更像约定；默认是条目原文">
            <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

// ———————— 可升格 ————————

function PromotableList({ service, env }: { service?: string; env?: string }) {
  const { data, loading } = usePromotable({ service, env });
  const [selected, setSelected] = useState<number | null>(null);
  const [promoting, setPromoting] = useState<Knowledge | null>(null);
  const entry = data?.find((k) => k.id === selected) ?? null;
  return (
    <Card>
      <CardHeader title="可升格" icon={<LuArrowUpFromLine />}
        description="近 30 天被 ≥5 次运行召回、没挨过 👎 的事实：已经被反复用到、确认无误。写进档案后逐字置顶注入、不会过期，原条目不再参与召回。" />
      {loading ? <SkeletonRows /> : !data?.length ? (
        <Empty icon={<LuArrowUpFromLine />} title="暂时没有可升格的记忆" description="被 ≥5 次运行召回、没挨过 👎 的事实会出现在这里" />
      ) : (
        <Table>
          <thead><tr><Th>条目</Th><Th>服务 / 环境</Th><Th>任务</Th><Th className="text-right">30 天命中</Th><Th className="text-right">最近</Th><Th /></tr></thead>
          <tbody>
            {data.map((k) => (
              <Tr key={k.id} onClick={() => setSelected(k.id)}>
                <Td className="max-w-[520px]">
                  <code className="truncate font-mono text-[12.5px] font-medium text-fg">{k.key}</code>
                  <div className="mt-0.5 truncate text-[12px] text-fg-3">{k.content}</div>
                </Td>
                <Td><span className="flex items-center gap-1.5 text-[12.5px] text-fg-2">{k.service}<ScopeEnv env={k.env} /></span></Td>
                <Td className="font-mono text-[11.5px] text-fg-3">{k.task || "服务通用"}</Td>
                <Td className="text-right tabular-nums text-fg-2">{k.hits_30d}</Td>
                <Td className="text-right text-[12px] text-fg-3">{k.last_hit_at ? ago(k.last_hit_at) : "—"}</Td>
                <Td className="w-[1%] text-right" onClick={(e) => e.stopPropagation()}>
                  <Button size="xs" icon={<LuArrowUpFromLine />} onClick={() => setPromoting(k)}>升格进档案</Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <KnowledgeDrawer entry={entry} onClose={() => setSelected(null)} onPromote={setPromoting} />
      <PromoteDialog entry={promoting} onClose={() => setPromoting(null)} />
    </Card>
  );
}

// ———————— 方法 ————————

const ASSET_KINDS: AssetKind[] = ["procedure", "script", "query", "baseline"];
/** procedure 叫「做法」：「方法」是这一类东西的总称（做法 / 脚本 / 查询 / 基线） */
const ASSET_KIND: Record<AssetKind, string> = { procedure: "做法", script: "脚本", query: "查询", baseline: "基线" };
const isCode = (kind: AssetKind) => kind === "script" || kind === "query";

export function AssetList({ filters, scope, openId }: { filters: MemoryFilters & { kind?: string }; scope: MemoryScope; openId?: number }) {
  // 方法按环境存，没有"所有环境"一说：记忆那边的 env="*" 在这里当作不限环境
  const { data, loading } = useAssets(filters.env === "*" ? { ...filters, env: undefined } : filters);
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
                {a.feedback_score < 0 && <Tooltip content="👎 扣分"><span className="flex items-center gap-0.5 text-bad"><LuThumbsDown className="size-3" />{a.feedback_score}</span></Tooltip>}
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
  const [where, setWhere] = useWhere(open, { ...scope, env: scope.env === "*" ? undefined : scope.env });
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
          <Field label="名字" required><Input autoFocus value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="成交表行数突降排查" /></Field>
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
              <div className="flex justify-end gap-2"><Button onClick={() => { setEditing(false); setD({ summary: asset.summary, content: asset.content }); }}>取消</Button><Button variant="primary" loading={save.pending} onClick={() => save.mutate(undefined)}>保存</Button></div>
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
            ["👎 扣分", asset.feedback_score < 0 ? <span className="text-bad">{asset.feedback_score}</span> : <span className="text-fg-3">无</span>],
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
  const ready = !!service && !!env && env !== "*";
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="检索试用" description="直接跑召回本身：混合检索 + 新鲜度校验 + 👎 扣分 + 任务谱系排序。不计入命中统计。" />
        <div className="space-y-3 p-4">
          {!ready && <div className="rounded-md bg-sunken px-3 py-2 text-[12.5px] text-fg-3">召回按 服务×环境 进行（该环境的 + 所有环境通用的）：先在上方选定服务和一个具体环境；选了任务则按该任务的谱系排序。</div>}
          <Textarea rows={3} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输入一个问题，看 agent 会被喂什么" />
          <div className="flex justify-end">
            <Button variant="primary" icon={<LuSearch />} disabled={!query.trim() || !ready} loading={run.pending}
              onClick={async () => { try { setRes(await run.mutate(undefined)); } catch (e) { toast.error("检索失败", (e as Error).message); } }}>检索</Button>
          </div>
          {res && (
            <ol className="space-y-2 pt-2">
              {res.hits.length === 0 && <div className="text-[12.5px] text-fg-3">没有命中</div>}
              {res.hits.map((h) => (
                <li key={h.id} className="rounded-md border border-line p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-fg-3">#{h.rank}</span><KindBadge kind={h.kind} />
                    {h.kind === "lesson" ? <LessonMeta k={h} /> : <code className="font-mono text-[12.5px] text-fg">{h.key}</code>}
                    <ScopeEnv env={h.env} />
                  </div>
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
