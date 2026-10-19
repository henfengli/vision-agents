/**
 * 记忆：知识（事实）/ 案例（教训）/ 方法（做法与脚本）/ 检索试用。
 * 全部按 服务×环境 分区；健康度条指出该治理的条目（零召回、负反馈、代码漂移、疑似矛盾）。
 */
import { useEffect, useState } from "react";
import {
  LuBookOpen, LuBrain, LuCircleAlert, LuFile, LuGitBranch, LuHistory, LuLightbulb, LuSearch, LuThumbsDown, LuWrench,
} from "react-icons/lu";

import { api, useServices } from "@/api/hooks";
import type { Asset, Knowledge } from "@/api/types";
import { Page, PageHeader } from "@/components/layout/shell";
import { EnvBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { CodeBlock, Markdown, Tabs, Table, Td, Th, Tr } from "@/components/ui/data";
import { FilterSelect, Input, SearchInput, Textarea } from "@/components/ui/form";
import { Drawer, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, DescList, Empty, SectionTitle, Skeleton, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, bytes, shortId } from "@/lib/format";
import { invalidate, useMutation, useQuery } from "@/lib/query";
import { Link, useSearch } from "@/lib/router";
import { useUi } from "@/lib/store";

type Tab = "knowledge" | "cases" | "assets" | "playground";

export function MemoryPage() {
  const [s, setS] = useSearch<{ tab: Tab; service: string; status: string; q: string; id: string; kind: string }>();
  const { env } = useUi();
  const { data: services } = useServices();
  const tab = s.tab ?? "knowledge";
  return (
    <Page wide>
      <PageHeader title="记忆" description="知识记事实、案例记教训、方法记做法。按 服务×环境 分区，prod 沉淀的口径不会污染 test。" />
      <Tabs className="mb-4" value={tab} onChange={(v) => setS({ tab: v === "knowledge" ? undefined : v, id: undefined })} tabs={[
        { value: "knowledge", label: "知识", icon: <LuBookOpen /> }, { value: "cases", label: "案例", icon: <LuLightbulb /> },
        { value: "assets", label: "方法", icon: <LuWrench /> }, { value: "playground", label: "检索试用", icon: <LuSearch /> },
      ]} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FilterSelect label="服务" allLabel="全部" value={s.service ?? ""} onChange={(v) => setS({ service: v })} options={(services ?? []).map((x) => ({ value: x.name, label: x.title }))} />
        {tab === "knowledge" && <FilterSelect label="状态" allLabel="生效中" value={s.status ?? ""} onChange={(v) => setS({ status: v })} options={[{ value: "expired", label: "已过期" }, { value: "superseded", label: "被取代" }]} />}
        {tab === "assets" && <FilterSelect label="类型" allLabel="全部" value={s.kind ?? ""} onChange={(v) => setS({ kind: v })} options={["procedure", "script", "query", "baseline"].map((k) => ({ value: k, label: ASSET_KIND[k] }))} />}
        {tab !== "playground" && <SearchInput value={s.q ?? ""} onChange={(v) => setS({ q: v })} placeholder="关键词…" className="w-56" />}
        <span className="ml-auto text-xs text-fg-3">环境：{env ? <EnvBadge env={env} /> : "全部"}（跟随顶栏）</span>
      </div>
      {tab === "knowledge" && <Card><KnowledgeList service={s.service} env={env} status={s.status} q={s.q} selectedId={s.id} onSelect={(id) => setS({ id: id ? String(id) : undefined })} showHealth /></Card>}
      {tab === "cases" && <Cases service={s.service} env={env} />}
      {tab === "assets" && <Assets service={s.service} env={env} kind={s.kind} q={s.q} />}
      {tab === "playground" && <Playground service={s.service} env={env} />}
    </Page>
  );
}

const STATUS_BADGE: Record<Knowledge["status"], React.ReactNode> = {
  active: null, expired: <Badge tone="warn">代码已漂移</Badge>, superseded: <Badge tone="idle">被取代</Badge>,
};

export function KnowledgeList({ service, env, status, q, selectedId, onSelect, showHealth }: {
  service?: string; env?: string; status?: string; q?: string; selectedId?: string; onSelect?: (id: number | null) => void; showHealth?: boolean;
}) {
  const { data, loading } = useQuery(["knowledge", service, env, status, q], () => api.knowledge({ service, env, status, q }));
  const { data: health } = useQuery(["knowledge", "health", service, env], () => api.knowledgeHealth({ service, env }), { enabled: !!showHealth });
  const [localSel, setLocalSel] = useState<number | null>(null);
  const sel = selectedId ? Number(selectedId) : localSel;
  const select = onSelect ?? setLocalSel;
  const entry = data?.find((k) => k.id === sel) ?? null;
  return (
    <>
      {showHealth && health && (
        <div className="grid grid-cols-5 divide-x divide-line border-b border-line text-center">
          {[["生效", health.active, ""], ["零召回 30 天", health.zero_recall, "warn"], ["负反馈", health.negative, "bad"], ["代码漂移", health.drifted, "warn"], ["疑似矛盾", health.conflicts, "warn"]].map(([label, n, tone]) => (
            <div key={label as string} className="px-3 py-2.5">
              <div className={cn("text-[17px] font-semibold tabular-nums", Number(n) > 0 && tone === "bad" ? "text-bad" : Number(n) > 0 && tone === "warn" ? "text-warn" : "text-fg")}>{n}</div>
              <div className="text-[11.5px] text-fg-3">{label}</div>
            </div>
          ))}
        </div>
      )}
      {loading ? <SkeletonRows /> : !data?.length ? <Empty icon={<LuBrain />} title="没有知识条目" description="运行成功后会自动沉淀可复用的结论" /> : (
        <Table>
          <thead><tr><Th>条目</Th><Th>服务 / 环境</Th><Th>来源任务</Th><Th className="text-right">30 天命中</Th><Th className="text-right">反馈</Th><Th className="text-right">更新</Th></tr></thead>
          <tbody>
            {data.map((k) => (
              <Tr key={k.id} onClick={() => select(k.id)} className={cn(k.status !== "active" && "opacity-70")}>
                <Td className="max-w-[520px]">
                  <div className="flex items-center gap-2"><code className="truncate font-mono text-[12.5px] font-medium text-fg">{k.key}</code>{STATUS_BADGE[k.status]}</div>
                  <div className="mt-0.5 truncate text-[12px] text-fg-3">{k.content}</div>
                </Td>
                <Td><span className="flex items-center gap-1.5 text-[12.5px] text-fg-2">{k.service}<EnvBadge env={k.env} /></span></Td>
                <Td className="font-mono text-[11.5px] text-fg-3">{k.task || "—"}</Td>
                <Td className={cn("text-right tabular-nums", k.hits_30d === 0 ? "text-warn" : "text-fg-2")}>{k.hits_30d}</Td>
                <Td className={cn("text-right tabular-nums", k.feedback_score < 0 ? "text-bad" : "text-fg-3")}>{k.feedback_score > 0 ? "+" : ""}{k.feedback_score}</Td>
                <Td className="text-right text-[12px] text-fg-3">{ago(k.updated_at)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <KnowledgeDrawer entry={entry} onClose={() => select(null)} />
    </>
  );
}

function KnowledgeDrawer({ entry, onClose }: { entry: Knowledge | null; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  useEffect(() => { setEditing(false); setText(entry?.content ?? ""); }, [entry?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: history } = useQuery(["knowledge", "history", entry?.id], () => api.knowledgeHistory(entry!.id), { enabled: !!entry });
  const save = useMutation(async () => {
    if (!entry) return;
    await api.putKnowledge(entry.id, { content: text, status: "active" });
    toast("已保存", { description: "视为人工纠正：重新生效，旧内容进历史" });
    invalidate("knowledge");
    setEditing(false);
  });
  return (
    <Drawer open={!!entry} onClose={onClose} title={<code className="font-mono">{entry?.key}</code>} subtitle={entry && `${entry.service} · ${entry.env} · ${entry.task || "无来源任务"}`}
      actions={entry && !editing && <Button size="sm" onClick={() => setEditing(true)}>编辑</Button>}>
      {entry && (
        <div className="space-y-5 p-5">
          {entry.status === "expired" && (
            <div className="flex gap-2 rounded-md bg-warn-soft px-3 py-2 text-[12.5px] text-warn"><LuCircleAlert className="mt-0.5 size-4 shrink-0" />引用的代码在沉淀之后改过（commit 漂移），召回时已跳过。确认仍然成立就编辑保存，它会重新生效。</div>
          )}
          {entry.feedback_score < 0 && (
            <div className="flex gap-2 rounded-md bg-bad-soft px-3 py-2 text-[12.5px] text-bad"><LuThumbsDown className="mt-0.5 size-4 shrink-0" />收到负反馈，召回排序已降权。建议改正内容或让它过期。</div>
          )}
          {editing ? (
            <div className="space-y-2">
              <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} />
              <div className="flex justify-end gap-2"><Button onClick={() => setEditing(false)}>取消</Button><Button variant="primary" loading={save.pending} onClick={() => save.mutate(undefined)}>保存</Button></div>
            </div>
          ) : <div className="rounded-md border border-line bg-sunken/50 p-3.5"><Markdown text={entry.content} /></div>}
          <DescList items={[
            ["状态", { active: "生效中", expired: "已过期（代码漂移）", superseded: "被取代" }[entry.status]],
            ["30 天命中", `${entry.hits_30d} 次${entry.last_hit_at ? `，最近 ${ago(entry.last_hit_at)}` : ""}`],
            ["反馈分", String(entry.feedback_score)],
            ["代码引用", entry.code_ref ? <span className="flex items-center gap-1 font-mono text-[12px]"><LuGitBranch className="size-3.5 text-fg-3" />{entry.code_ref.path} @{entry.code_ref.commit}</span> : "无"],
            ["来源运行", entry.source_run ? <Link to={`/runs/${entry.source_run}`} className="font-mono hover:text-accent">{shortId(entry.source_run)}</Link> : "人工录入"],
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

function Cases({ service, env }: { service?: string; env?: string }) {
  const { data, loading } = useQuery(["cases", service, env], () => api.cases({ service, env }));
  return (
    <Card>
      <CardHeader title="案例库" description="报错指纹（抹掉数字/路径/引号后哈希）→ 结论；同类报错再出现时召回" />
      {loading ? <SkeletonRows /> : !data?.length ? <Empty icon={<LuLightbulb />} title="还没有案例" /> : (
        <Table>
          <thead><tr><Th>结论</Th><Th>类别</Th><Th>服务 / 环境</Th><Th>指纹</Th><Th className="text-right">👍 / 👎</Th><Th className="text-right">更新</Th></tr></thead>
          <tbody>{data.map((c) => (
            <Tr key={c.id} className={cn(c.status !== "active" && "opacity-60")}>
              <Td className="max-w-[460px]"><div className="truncate text-[13px] text-fg">{c.conclusion}</div>{c.source_run && <Link to={`/runs/${c.source_run}`} className="font-mono text-[11px] text-fg-3 hover:text-accent">{shortId(c.source_run)}</Link>}</Td>
              <Td><Badge>{c.category}</Badge></Td>
              <Td><span className="flex items-center gap-1.5 text-[12.5px] text-fg-2">{c.service ?? "—"}<EnvBadge env={c.env} /></span></Td>
              <Td className="font-mono text-[11.5px] text-fg-3">{c.fingerprint}</Td>
              <Td className="text-right tabular-nums text-fg-2">{c.thumbs_up} / {c.thumbs_down}</Td>
              <Td className="text-right text-[12px] text-fg-3">{ago(c.updated_at)}</Td>
            </Tr>
          ))}</tbody>
        </Table>
      )}
    </Card>
  );
}

const ASSET_KIND: Record<string, string> = { procedure: "方法", script: "脚本", query: "查询", baseline: "基线" };

function Assets({ service, env, kind, q }: { service?: string; env?: string; kind?: string; q?: string }) {
  const { data, loading } = useQuery(["assets", service, env, kind], () => api.assets({ service, env, kind }));
  const [sel, setSel] = useState<Asset | null>(null);
  const list = (data ?? []).filter((a) => !q || (a.name + a.summary).includes(q));
  return (
    <>
      {loading ? <SkeletonRows /> : !list.length ? <Card><Empty icon={<LuWrench />} title="还没有方法沉淀" description="agent 用 save_asset 把可复用的做法、脚本、查询、基线存下来，后续运行自动召回复用" /></Card> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((a) => (
            <button key={a.id} type="button" onClick={() => setSel(a)} className={cn("rounded-lg border border-line bg-panel p-4 text-left shadow-[var(--shadow-card)] transition-shadow hover:shadow-[var(--shadow-pop)]", a.status !== "active" && "opacity-60")}>
              <div className="flex items-center gap-2"><Badge tone="accent">{ASSET_KIND[a.kind]}</Badge><span className="truncate text-[13px] font-semibold text-fg">{a.name}</span>{a.status !== "active" && <Badge tone="idle">被取代</Badge>}</div>
              <div className="mt-1.5 line-clamp-2 text-[12.5px] text-fg-2">{a.summary}</div>
              <div className="mt-3 flex items-center gap-3 text-[11.5px] text-fg-3">
                <span>{a.service}</span><EnvBadge env={a.env} /><span>{a.task || "服务通用"}</span>
                <span className="ml-auto">复用 {a.use_count} 次</span>
                {a.files.length > 0 && <span className="flex items-center gap-0.5"><LuFile className="size-3" />{a.files.length}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
      <Drawer open={!!sel} onClose={() => setSel(null)} title={sel?.name ?? ""} subtitle={sel && `${ASSET_KIND[sel.kind]} · ${sel.service} · ${sel.env} · ${sel.task || "服务通用"}`}>
        {sel && (
          <div className="space-y-4 p-5">
            <div className="text-[13px] text-fg-2">{sel.summary}</div>
            {sel.content && <CodeBlock code={sel.content} wrap title="说明 / 内容" />}
            {sel.files.length > 0 && (
              <div>
                <SectionTitle>文件</SectionTitle>
                <ul className="divide-y divide-line rounded-md border border-line">{sel.files.map((f) => (
                  <li key={f.name} className="flex items-center gap-2 px-3 py-2 text-[12.5px]"><LuFile className="size-3.5 text-fg-3" /><span className="font-mono text-fg">{f.name}</span><span className="ml-auto text-fg-3">{bytes(f.size)}</span></li>
                ))}</ul>
              </div>
            )}
            <DescList items={[["复用", `${sel.use_count} 次${sel.last_used_at ? `，最近 ${ago(sel.last_used_at)}` : ""}`], ["反馈分", String(sel.feedback_score)], ["来源运行", sel.source_run ? <Link to={`/runs/${sel.source_run}`} className="font-mono hover:text-accent">{shortId(sel.source_run)}</Link> : "人工登记"], ["更新", ago(sel.updated_at)]]} />
          </div>
        )}
      </Drawer>
    </>
  );
}

function Playground({ service, env }: { service?: string; env?: string }) {
  const [query, setQuery] = useState("");
  const [task, setTask] = useState("");
  const run = useMutation(() => api.searchKnowledge({ query, service, env, task }));
  const [res, setRes] = useState<Awaited<ReturnType<typeof api.searchKnowledge>> | null>(null);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
      <Card>
        <CardHeader title="检索试用" description="直接跑召回本身：混合检索 + 新鲜度校验 + 反馈加权 + 任务谱系排序。不计入命中统计。" />
        <div className="space-y-3 p-4">
          <Textarea rows={3} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输入一个问题，看 agent 会被喂什么" />
          <div className="flex items-center gap-2">
            <Input mono value={task} onChange={(e) => setTask(e.target.value)} placeholder="以某任务身份（可选），如 data-qa" className="flex-1" />
            <Button variant="primary" icon={<LuSearch />} disabled={!query.trim()} loading={run.pending} onClick={async () => setRes(await run.mutate(undefined))}>检索</Button>
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
