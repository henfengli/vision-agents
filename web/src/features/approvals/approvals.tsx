/**
 * 审批收件箱：待办按等待时长排（等最久的在最上），右侧详情可直接放行/拒绝并留言。
 * 四类审批同一个收件箱：提交审批 / 危险命令 / 产物门禁 / 受保护环境的进程启停。
 */
import { useEffect, useState } from "react";
import { LuArrowUpRight, LuCircleCheck, LuCircleX, LuClock, LuInbox, LuShieldCheck } from "react-icons/lu";

import { api, useApprovals } from "@/api/hooks";
import type { Approval, ApprovalKind } from "@/api/types";
import { EnvFilter, FilterBar, ServiceFilter } from "@/components/filters";
import { Page, PageHeader } from "@/components/layout/shell";
import { APPROVAL_KIND, EnvBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { CodeBlock, Tabs } from "@/components/ui/data";
import { FilterSelect, Textarea } from "@/components/ui/form";
import { toast } from "@/components/ui/overlay";
import { Badge, Card, DescList, Empty, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, datetime, shortId, until } from "@/lib/format";
import { invalidate } from "@/lib/query";
import { Link, useSearch } from "@/lib/router";
import { useUi } from "@/lib/store";

export function ApprovalsPage() {
  const [s, setS] = useSearch<{ tab: "pending" | "decided"; id: string; service: string; env: string; kind: ApprovalKind }>();
  const { env: globalEnv } = useUi();
  const tab = s.tab ?? "pending";
  const scope = { service: s.service ?? "", env: s.env ?? globalEnv, kind: s.kind ?? "" } as const;
  const { data: pending } = useApprovals({ status: "pending", ...scope });
  const { data, loading } = useApprovals({ status: tab, ...scope });
  const selected = data?.find((a) => String(a.id) === s.id) ?? (tab === "pending" ? data?.[0] : undefined);
  useEffect(() => {
    if (!s.id && selected && tab === "pending") setS({ id: String(selected.id) });
  }, [s.id, selected, tab, setS]);

  return (
    <Page wide>
      <PageHeader title="审批" description="人工门：提交审批、危险命令、产物门禁、受保护环境的进程启停。超时视同拒绝（安全侧默认）。" />
      <div className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3 border-b border-line">
        <Tabs className="-mb-px border-b-0" value={tab} onChange={(v) => setS({ tab: v === "pending" ? undefined : v, id: undefined })} tabs={[
          { value: "pending", label: "待办", count: pending?.length ?? null }, { value: "decided", label: "已处理" },
        ]} />
        <div className="ml-auto pb-2">
          <FilterBar active={!!(s.service || s.env || s.kind)} onClear={() => setS({ service: undefined, env: undefined, kind: undefined, id: undefined })}>
            <ServiceFilter value={scope.service} onChange={(v) => setS({ service: v || undefined, id: undefined })} />
            <EnvFilter value={scope.env} onChange={(v) => setS({ env: v || undefined, id: undefined })} />
            <FilterSelect label="类型" allLabel="全部" value={scope.kind} onChange={(v) => setS({ kind: (v || undefined) as ApprovalKind, id: undefined })}
              options={(Object.keys(APPROVAL_KIND) as ApprovalKind[]).map((k) => ({ value: k, label: APPROVAL_KIND[k].label }))} />
          </FilterBar>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
        <Card className="h-fit overflow-hidden">
          {loading ? <SkeletonRows /> : !data?.length ? (
            <Empty icon={tab === "pending" ? <LuCircleCheck className="text-ok" /> : <LuInbox />} title={tab === "pending" ? "没有待办" : "还没有处理记录"}
              description={s.service || s.env || s.kind ? "当前筛选下没有，试试清除筛选" : tab === "pending" ? "所有审批都处理完了" : undefined} />
          ) : (
            <ul className="divide-y divide-line">
              {data.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => setS({ id: String(a.id) })}
                    className={cn("block w-full px-4 py-3 text-left transition-colors hover:bg-hover/70", selected?.id === a.id && "bg-accent-soft/60 hover:bg-accent-soft/60")}>
                    <div className="flex items-center gap-2 text-[11.5px] text-fg-3 [&_svg]:size-3.5">
                      {APPROVAL_KIND[a.kind].icon}<span>{APPROVAL_KIND[a.kind].label}</span>
                      {a.env && <EnvBadge env={a.env} />}
                      {a.status !== "pending" && <Badge tone={a.status === "approved" ? "ok" : "bad"}>{a.status === "approved" ? "已放行" : a.status === "rejected" ? "已拒绝" : "已超时"}</Badge>}
                      <span className="ml-auto">{a.status === "pending" ? `等待 ${ago(a.created_at).replace("前", "")}` : ago(a.decided_at)}</span>
                    </div>
                    <div className="mt-1.5 truncate text-[13px] font-medium text-fg">{a.title}</div>
                    <div className="mt-0.5 truncate font-mono text-[11.5px] text-fg-3">{a.detail.split("\n")[0]}</div>
                    <div className="mt-1 text-[11.5px] text-fg-3">{[a.service, a.task, a.requested_by].filter(Boolean).join(" · ")}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {selected ? <ApprovalDetail key={selected.id} a={selected} /> : <Card><Empty icon={<LuShieldCheck />} title="选择一条审批查看详情" /></Card>}
      </div>
    </Page>
  );
}

function ApprovalDetail({ a }: { a: Approval }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"a" | "r" | null>(null);
  const decide = async (approve: boolean) => {
    setBusy(approve ? "a" : "r");
    try {
      await (approve ? api.approve(a.id, comment) : api.reject(a.id, comment));
      toast(approve ? "已放行" : "已拒绝", { description: a.title });
      invalidate("approvals"); invalidate("runs");
    } catch (e) {
      toast.error("处理失败", (e as Error).message);
    } finally { setBusy(null); }
  };
  const kind = APPROVAL_KIND[a.kind];
  return (
    <Card className="h-fit">
      <div className="border-b border-line px-5 py-4">
        <div className="flex items-center gap-2 text-[12px] text-fg-3 [&_svg]:size-4">{kind.icon}{kind.label}{a.env && <EnvBadge env={a.env} />}</div>
        <div className="mt-1.5 text-[16px] font-semibold text-fg">{a.title}</div>
        {a.status === "pending" && a.expires_at && (
          <div className="mt-1.5 flex items-center gap-1 text-[12px] text-warn"><LuClock className="size-3.5" />{until(a.expires_at)}超时，届时视同拒绝</div>
        )}
      </div>
      <div className="space-y-4 p-5">
        <CodeBlock code={a.detail} wrap title={a.kind === "command" ? "将要执行的命令" : a.kind === "process" ? "进程操作" : "内容"} />
        <DescList items={[
          ["发起方", a.requested_by],
          ["服务", a.service ? <Link to={`/services/${a.service}${a.env ? "?env=" + a.env : ""}`} className="hover:text-accent">{a.service}</Link> : "—"],
          ...(a.kind === "submit" && a.payload.policy ? [["命中策略", <Link to="/settings/policies" className="font-mono hover:text-accent">{String(a.payload.policy)}</Link>] as [string, React.ReactNode]] : []),
          ["任务", a.task ? <Link to={`/tasks/${encodeURIComponent(a.task)}`} className="hover:text-accent">{a.task}</Link> : "—"],
          ["运行", a.run_id ? <Link to={`/runs/${a.run_id}`} className="inline-flex items-center gap-1 font-mono hover:text-accent">{shortId(a.run_id)}<LuArrowUpRight className="size-3" /></Link> : "—"],
          ["发起时间", datetime(a.created_at, true)],
          ...(a.status !== "pending" ? [["处理", <span>{a.decided_by} · {datetime(a.decided_at, true)}</span>] as [string, React.ReactNode]] : []),
          ...(a.comment ? [["留言", a.comment] as [string, React.ReactNode]] : []),
        ]} />
        {a.status === "pending" ? (
          <div className="space-y-3 border-t border-line pt-4">
            <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="留言（可选）：记录判断依据，进审计" />
            <div className="flex justify-end gap-2">
              <Button variant="danger-ghost" icon={<LuCircleX />} loading={busy === "r"} onClick={() => decide(false)}>拒绝</Button>
              <Button variant="primary" icon={<LuCircleCheck />} loading={busy === "a"} onClick={() => decide(true)}>放行</Button>
            </div>
          </div>
        ) : (
          <div className={cn("flex items-center gap-2 rounded-md px-3 py-2 text-[13px]", a.status === "approved" ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad")}>
            {a.status === "approved" ? <LuCircleCheck className="size-4" /> : <LuCircleX className="size-4" />}
            {a.status === "approved" ? "已放行" : a.status === "rejected" ? "已拒绝" : "已超时（视同拒绝）"}
          </div>
        )}
      </div>
    </Card>
  );
}
