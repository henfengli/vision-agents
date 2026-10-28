/**
 * 服务列表：每个项目一张卡——各环境的运行健康、任务数。
 */
import { useEffect, useState } from "react";
import { LuDatabase, LuFolder, LuListTodo, LuPlus, LuScrollText, LuServer } from "react-icons/lu";

import { api, useEnvs, useServices } from "@/api/hooks";
import type { ServiceSummary } from "@/api/types";
import { Page, PageHeader } from "@/components/layout/shell";
import { MetaVersion } from "@/components/meta";
import { EmptyFiltered } from "@/components/states";
import { DisabledBadge, EnvBadge, FailCount, RUN_STATUS, RunStatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, SearchInput, Textarea } from "@/components/ui/form";
import { Dialog, Tooltip, toast } from "@/components/ui/overlay";
import { Card, Empty, ErrorState, Skeleton } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { Link, navigate } from "@/lib/router";
import { ServiceAvatar } from "../overview/overview";

/** 与后端 domain/services.NAME_RE 一致 */
const SERVICE_NAME_RE = /^[a-z][a-z0-9._-]{1,40}$/;

export function ServicesPage() {
  const { data, loading, error, refetch } = useServices();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const list = (data ?? []).filter((s) => !q || (s.name + s.title + s.description).toLowerCase().includes(q.toLowerCase()));
  return (
    <Page>
      <PageHeader title="服务" description="agent 能查看和排查的业务项目，每个项目按环境分别配置。"
        actions={<Button variant="primary" icon={<LuPlus />} onClick={() => setCreating(true)}>新建服务</Button>} />
      <div className="mb-4 flex items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="筛选服务…" className="w-64" />
        <span className="text-xs text-fg-3">{data ? `${list.length} 个服务` : ""}</span>
      </div>
      {error && !data ? <Card><ErrorState error={error} onRetry={refetch} /></Card> : loading ? (
        <div className="grid gap-4 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-52 rounded-lg" />)}</div>
      ) : list.length === 0 ? (
        <Card>{q ? <EmptyFiltered what="服务" icon={<LuServer />} onClear={() => setQ("")} />
          : <Empty icon={<LuServer />} title="还没有服务" description="一个服务就是一个线上部署的业务项目" action={<Button icon={<LuPlus />} onClick={() => setCreating(true)}>新建服务</Button>} />}</Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">{list.map((s) => <ServiceCard key={s.name} s={s} />)}</div>
      )}
      <CreateServiceDialog open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

/** "1 个专属任务 · 3 个通用"：通用任务每个服务都能用（调用时指定服务），服务页「任务」标签两组一起列 */
export function TaskCounts({ s }: { s: ServiceSummary }) {
  return (
    <Tooltip content="专属任务只属于这个服务；通用任务每个服务都能用，调用时指定服务">
      <span>{s.task_count} 个专属任务{s.generic_task_count ? ` · ${s.generic_task_count} 个通用` : ""}</span>
    </Tooltip>
  );
}

function ServiceCard({ s }: { s: ServiceSummary }) {
  const { data: envs } = useEnvs();
  const logs = Object.keys(s.logs ?? {});
  const dbs = Object.keys(s.databases ?? {});
  return (
    <Card className={cn("group flex flex-col transition-shadow hover:shadow-[var(--shadow-pop)]", !s.enabled && "opacity-75")}>
      <Link to={`/services/${s.name}`} className="flex items-start gap-3 px-4 pt-4">
        <ServiceAvatar name={s.name} disabled={!s.enabled} className="size-9 text-[14px]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-fg group-hover:text-accent">{s.title || s.name}</span>
            {!s.enabled && <DisabledBadge scope="service" />}
          </div>
          <div className="mt-0.5 line-clamp-1 text-[12.5px] text-fg-3" title={s.description || undefined}>{s.description || "—"}</div>
        </div>
      </Link>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 text-[12px] text-fg-3">
        <span className="flex min-w-0 max-w-full items-center gap-1 font-mono" title={s.root || undefined}><LuFolder className="size-3.5 shrink-0" /><span className="truncate">{s.root || "未配置代码目录"}</span></span>
        <span className="flex shrink-0 items-center gap-1"><LuListTodo className="size-3.5" /><TaskCounts s={s} /></span>
        <span className="flex shrink-0 items-center gap-1"><LuDatabase className="size-3.5" />{dbs.length ? dbs.join("、") : "无只读库"}</span>
        <span className="flex shrink-0 items-center gap-1" title={logs.join("、") || undefined}><LuScrollText className="size-3.5" />{logs.length ? `${logs.length} 个日志` : "无日志"}</span>
      </div>
      <div className="mt-3 grid border-t border-line" style={{ gridTemplateColumns: `repeat(${envs?.length || 3}, minmax(0, 1fr))` }}>
        {(envs ?? []).map((e, i) => {
          const h = s.health[e.name];
          const last = h?.last_run;
          // 只看该环境自己的开关：服务整体停用在卡片标题上说一次，不把每个环境都标成已停用
          if (h && !h.env_enabled) {
            return (
              <Link key={e.name} to={`/services/${s.name}?tab=envs`} className={cn("bg-sunken/50 px-4 py-3 hover:bg-hover/60", i > 0 && "border-l border-line")}>
                <EnvBadge env={e.name} />
                <div className="mt-2"><DisabledBadge scope="env" /></div>
              </Link>
            );
          }
          return (
            <Link key={e.name} to={`/services/${s.name}?env=${e.name}`} className={cn("px-4 py-3 hover:bg-hover/60", i > 0 && "border-l border-line")}>
              <div className="flex items-center justify-between"><EnvBadge env={e.name} />
                {last && <RunStatusDot status={last.status} hint={`最近一次：${RUN_STATUS[last.status].label} · ${ago(last.created_at)}`} />}
              </div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-[16px] font-semibold tabular-nums text-fg">{h?.runs_24h ?? 0}</span>
                <span className="text-[11.5px] text-fg-3">次 · 近 24 小时</span>
                <FailCount n={h?.failed_24h} className="ml-auto self-center" />
              </div>
            </Link>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2 text-[11.5px] text-fg-3">
        <span className="truncate font-mono">{s.name}</span>
        <MetaVersion className="shrink-0" version={s.version} by={s.updated_by} at={s.updated_at} />
      </div>
    </Card>
  );
}

function CreateServiceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: envs } = useEnvs();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  /** 没动过代码目录时跟着服务名给 ~/deploy/<服务名> */
  const [root, setRoot] = useState<string | null>(null);
  const [python, setPython] = useState("");
  /** 不勾的环境：envs[env].enabled = false */
  const [off, setOff] = useState<string[]>([]);
  // 每次打开都是空表单（上次取消时填的不留着）
  useEffect(() => { if (open) { setName(""); setTitle(""); setDescription(""); setRoot(null); setPython(""); setOff([]); } }, [open]);
  const rootValue = root ?? (name ? `~/deploy/${name}` : "");
  const valid = SERVICE_NAME_RE.test(name);
  const allEnvs = envs ?? [];
  const noEnv = allEnvs.length > 0 && allEnvs.every((e) => off.includes(e.name));
  const ok = valid && !noEnv;
  const create = useMutation(async () => {
    try {
      // code_paths 不写：默认跟随代码目录，以后改代码目录不会留下一条旧路径
      await api.create("services", {
        name, title: title.trim() || name, description: description.trim(), root: rootValue.trim(), code_paths: [], python: python.trim(),
        envs: Object.fromEntries(off.map((e) => [e, { enabled: false }])),
      });
      invalidate("services");
      toast(`已创建服务 ${name}`, { description: "概览页列出了还要补的配置" });
      onClose();
      navigate(`/services/${name}`);
    } catch (e) {
      toast.error("创建失败", (e as Error).message);
    }
  });
  const submit = () => { if (ok && !create.pending) void create.mutate(undefined); };
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="新建服务" description="填好基本信息就能用；只读库、日志、档案创建后再补。"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!ok} loading={create.pending} onClick={submit}>创建</Button></>}>
      <form className="space-y-3.5" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="服务名" required help="小写字母开头，可含数字 . _ -；创建后不能改" error={name && !valid ? "格式不对：小写字母开头，2~41 个字符，可含数字 . _ -" : null}>
            <Input mono autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="vision-report" aria-invalid={!!name && !valid} />
          </Field>
          <Field label="显示名" help="不填就用服务名"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Vision Report" /></Field>
        </div>
        <Field label="说明"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明这个项目做什么" /></Field>
        <Field label="代码目录" help="线上部署的那份代码（agent 只读）；~ 是部署用户的 home，各环境目录不同可写 {env}">
          <Input mono value={rootValue} onChange={(e) => setRoot(e.target.value)} placeholder="~/deploy/vision-report" />
        </Field>
        <Field label="项目 Python" help="线上跑这个项目用的解释器；不填 = python3">
          <Input mono value={python} onChange={(e) => setPython(e.target.value)} placeholder={`~/miniconda3/envs/${name || "vision-report"}/bin/python`} />
        </Field>
        <Field label="在哪些环境启用" error={noEnv ? "至少在一个环境启用" : null} help="没勾的环境不接收运行，之后可以在服务页「环境」里打开">
          <div className="flex flex-wrap gap-x-5">
            {allEnvs.map((e) => (
              <Checkbox key={e.name} checked={!off.includes(e.name)} onChange={(on) => setOff(on ? off.filter((x) => x !== e.name) : [...off, e.name])}
                label={<span className="flex items-center gap-1.5"><EnvBadge env={e.name} />{e.title}</span>} />
            ))}
          </div>
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
