/**
 * 服务列表：每个项目一张卡——各环境的运行健康、进程、任务数。
 */
import { useState } from "react";
import { LuFolder, LuListTodo, LuPlus, LuServer } from "react-icons/lu";

import { api, useEnvs, useServices } from "@/api/hooks";
import type { ServiceSummary } from "@/api/types";
import { Page, PageHeader } from "@/components/layout/shell";
import { EnvBadge, RUN_STATUS } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Field, Input, SearchInput, Textarea } from "@/components/ui/form";
import { Dialog, toast } from "@/components/ui/overlay";
import { Badge, Card, Empty, Skeleton } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { Link, navigate } from "@/lib/router";
import { ServiceAvatar } from "../overview/overview";

export function ServicesPage() {
  const { data, loading } = useServices();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const list = (data ?? []).filter((s) => !q || (s.name + s.title + s.description).toLowerCase().includes(q.toLowerCase()));
  return (
    <Page>
      <PageHeader title="服务" description="与 agent 同机部署的业务项目。agent 按 服务×环境 读代码与配置、查只读库、按需启停进程。"
        actions={<Button variant="primary" icon={<LuPlus />} onClick={() => setCreating(true)}>新建服务</Button>} />
      <div className="mb-4 flex items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="筛选服务…" className="w-64" />
        <span className="text-xs text-fg-3">{data ? `${list.length} 个服务` : ""}</span>
      </div>
      {loading ? (
        <div className="grid gap-4 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-52 rounded-lg" />)}</div>
      ) : list.length === 0 ? (
        <Card><Empty icon={<LuServer />} title={q ? "没有匹配的服务" : "还没有服务"} description="服务 = 一个和 agent 部署在同一台机器上的项目" action={!q && <Button icon={<LuPlus />} onClick={() => setCreating(true)}>新建服务</Button>} /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">{list.map((s) => <ServiceCard key={s.name} s={s} />)}</div>
      )}
      <CreateServiceDialog open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

function ServiceCard({ s }: { s: ServiceSummary }) {
  const { data: envs } = useEnvs();
  const procs = Object.keys(s.processes);
  return (
    <Card className={cn("group flex flex-col transition-shadow hover:shadow-[var(--shadow-pop)]", !s.enabled && "opacity-75")}>
      <Link to={`/services/${s.name}`} className="flex items-start gap-3 px-4 pt-4">
        <ServiceAvatar name={s.name} disabled={!s.enabled} className="size-9 text-[14px]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-fg group-hover:text-accent">{s.title}</span>
            {!s.enabled && <Badge tone="idle">已停用</Badge>}
          </div>
          <div className="mt-0.5 line-clamp-1 text-[12.5px] text-fg-3">{s.description || "—"}</div>
        </div>
      </Link>
      <div className="mt-3 flex items-center gap-4 px-4 text-[12px] text-fg-3">
        <span className="flex items-center gap-1 font-mono"><LuFolder className="size-3.5" />{s.root || "—"}</span>
        <span className="flex items-center gap-1"><LuListTodo className="size-3.5" />{s.task_count} 任务</span>
        <span>{procs.length ? `进程：${procs.join("、")}` : "无托管进程"}</span>
      </div>
      <div className="mt-3 grid grid-cols-3 border-t border-line">
        {(envs ?? []).filter((e) => e.enabled).map((e, i) => {
          const h = s.health[e.name];
          const st = h?.last_run ? RUN_STATUS[h.last_run.status] : null;
          return (
            <Link key={e.name} to={`/services/${s.name}?env=${e.name}`} className={cn("px-4 py-3 hover:bg-hover/60", i > 0 && "border-l border-line")}>
              <div className="flex items-center justify-between"><EnvBadge env={e.name} />
                {st && <span className={cn("[&_svg]:size-3.5", { ok: "text-ok", bad: "text-bad", warn: "text-warn", info: "text-info", idle: "text-idle", neutral: "", accent: "", outline: "" }[st.tone])}>{st.icon}</span>}
              </div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-[16px] font-semibold tabular-nums text-fg">{h?.runs_24h ?? 0}</span>
                <span className="text-[11.5px] text-fg-3">次/24h</span>
                {!!h?.failed_24h && <span className="ml-auto text-[11.5px] font-medium text-bad">{h.failed_24h} 失败</span>}
              </div>
              <div className="mt-1 flex items-center gap-1 text-[11.5px] text-fg-3">
                <span className={cn("size-1.5 rounded-full", h?.running_processes ? "bg-ok" : "bg-line-strong")} />
                {h?.total_processes ? `${h.running_processes}/${h.total_processes} 进程` : "—"}
              </div>
            </Link>
          );
        })}
      </div>
      <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[11.5px] text-fg-3">
        <span className="font-mono">{s.name}</span>
        <span>v{s.version} · {s.updated_by} · {ago(s.updated_at)}</span>
      </div>
    </Card>
  );
}

function CreateServiceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [root, setRoot] = useState("");
  const [description, setDescription] = useState("");
  const valid = /^[a-z][a-z0-9._-]{1,40}$/.test(name);
  const create = useMutation(async () => {
    try {
      await api.createService({ name, title: title || name, root, code_paths: root ? [root] : [], description });
      invalidate("services");
      toast("服务已创建", { description: "接着配置进程、各环境配置文件与档案" });
      onClose();
      navigate(`/services/${name}?tab=config`);
    } catch (e) {
      toast.error("创建失败", (e as Error).message);
    }
  });
  return (
    <Dialog open={open} onClose={onClose} title="新建服务" description="先填基本信息，创建后在「配置」里补全进程、配置文件和档案"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!valid} loading={create.pending} onClick={() => create.mutate(undefined)}>创建</Button></>}>
      <div className="space-y-3.5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="服务名" required help="小写字母开头，可含数字 . _ -；创建后不可改" error={name && !valid ? "格式不对" : null}>
            <Input mono autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="payments-etl" />
          </Field>
          <Field label="显示名"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="支付 ETL" /></Field>
        </div>
        <Field label="部署目录" help="agent 只读访问；读代码、配置、日志都从这里出发">
          <Input mono value={root} onChange={(e) => setRoot(e.target.value)} placeholder="/srv/payments-etl" />
        </Field>
        <Field label="说明"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明这个项目做什么" /></Field>
      </div>
    </Dialog>
  );
}
