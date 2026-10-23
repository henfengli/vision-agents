/**
 * 配置文件（服务×环境）：按原文编辑本环境声明过的配置文件——代码目录外、每环境一份的真实文件。
 * 打开时记下 sha，保存带回：期间被别人改过返回 409，不互相覆盖。旧内容自动备份，可回看、载入编辑器再保存。
 * 上游（仓库里的 .env.template、settings.py…）自上次核对以来变了：给出 diff，改完保存或点「已核对」才算处理。
 */
import { useEffect, useState } from "react";
import { LuCircleAlert, LuFileText, LuHistory, LuInfo, LuRefreshCw, LuServer, LuTriangleAlert } from "react-icons/lu";

import { ApiError } from "@/api/client";
import { api, useConfigHistory, useConfigRaw, useServiceEnv, useSyncStatus } from "@/api/hooks";
import type { ConfigRaw, ServiceSummary } from "@/api/types";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/data";
import { Textarea } from "@/components/ui/form";
import { Drawer, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, Empty, ErrorState, Skeleton, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, bytes, datetime } from "@/lib/format";
import { invalidate, setQueryData, useQuery } from "@/lib/query";
import { useLeaveGuard } from "@/lib/router";

export function ConfigFilesView({ svc, env, onOpenProcesses, onOpenDefinition }: {
  svc: ServiceSummary; env: string; onOpenProcesses: () => void; onOpenDefinition: () => void;
}) {
  const { data: view, error, refetch } = useServiceEnv(svc.name, env);
  const { data: sync, error: syncError } = useSyncStatus(svc.name, env);
  const files = view?.config_files;
  const pending = (path: string) => !!sync?.configs.some((c) => c.path === path && c.pending);
  const [picked, setPicked] = useState<string | null>(null);
  // 默认选中第一个待更新的（通知链接进来就是为了它）；等同步状态到了再挑，挑定之后不再跳
  useEffect(() => {
    if (!files || (picked && files.some((f) => f.path === picked))) return;
    if (view?.repo && !sync && !syncError) return;
    setPicked(files.find((f) => pending(f.path))?.path ?? files[0]?.path ?? null);
  }, [files, sync, syncError, picked]); // eslint-disable-line react-hooks/exhaustive-deps
  /** 切环境后旧的选择不在新列表里：等上面重新挑 */
  const active = picked && files?.some((f) => f.path === picked) ? picked : null;

  if (error) return <Card><ErrorState error={error} onRetry={refetch} /></Card>;
  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <Card className="h-fit">
        <CardHeader title="配置文件" icon={<LuFileText />} description={`${env} 的真实文件；进程、项目内核、同步步骤启动时 bind 到固定路径`} />
        {!files ? <SkeletonRows rows={2} /> : !files.length ? (
          <Empty title="没有声明配置文件" description="在服务定义里声明 固定路径 ← 各环境模板（含 {env}）" action={<Button size="sm" onClick={onOpenDefinition}>去声明</Button>} />
        ) : (
          <ul className="p-1.5">
            {files.map((f) => (
              <li key={f.path}>
                <button type="button" onClick={() => setPicked(f.path)}
                  className={cn("w-full rounded-md px-2.5 py-2 text-left transition-colors", active === f.path ? "bg-accent-soft" : "hover:bg-hover")}>
                  <div className="flex items-center gap-1.5">
                    <span className={cn("min-w-0 flex-1 truncate font-mono text-[12.5px]", active === f.path ? "text-accent" : "text-fg")} title={f.path}>{f.path.split("/").pop()}</span>
                    {pending(f.path) && <Badge tone="warn">待更新</Badge>}
                    {!f.exists && <Badge tone="bad">不存在</Badge>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-fg-3" title={f.path}>{f.path}</div>
                  {f.upstream && <div className="truncate text-[11px] text-fg-3">上游 <span className="font-mono">{f.upstream}</span></div>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {active && <ConfigEditor key={`${env}|${active}`} svc={svc} env={env} path={active} onOpenProcesses={onOpenProcesses} />}
    </div>
  );
}

function ConfigEditor({ svc, env, path, onOpenProcesses }: { svc: ServiceSummary; env: string; path: string; onOpenProcesses: () => void }) {
  const key = ["services", svc.name, "config", env, path];
  const { data, error, refetch } = useConfigRaw(svc.name, env, path);
  /** 打开（或重新载入）时的内容与 sha：保存带回 sha */
  const [base, setBase] = useState<{ content: string; sha: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [acking, setAcking] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const dirty = !!base && draft !== base.content;
  /** 有未保存的修改时，换标签、切环境、换页面、关窗口前先确认（这些都会卸载编辑器） */
  useLeaveGuard(dirty, ["tab", "part", "env"]);
  // 服务端内容变了：没改过就跟着换；改过就留着，下面提示（保存会被拒绝）
  useEffect(() => {
    if (data && (!base || (!dirty && data.sha !== base.sha))) {
      setBase({ content: data.content, sha: data.sha });
      setDraft(data.content);
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const stale = !!data && !!base && data.sha !== base.sha;
  const up = data?.upstream_state;

  const reload = async () => {
    const d = await refetch();
    if (d) { setBase({ content: d.content, sha: d.sha }); setDraft(d.content); }
  };
  const save = async () => {
    if (!base) return;
    setSaving(true);
    try {
      const res = await api.saveConfig(svc.name, env, { path, content: draft, sha: base.sha });
      setBase({ content: draft, sha: res.sha });
      setQueryData<ConfigRaw>(key, (old) => ({ ...old!, content: draft, sha: res.sha, exists: true, upstream_state: old?.upstream_state ? { ...old.upstream_state, pending: false } : null }));
      setRunning(res.running);
      toast("已保存", { description: `${res.backup ? "旧内容已备份，可在「历史」里找回" : "已新建文件"}；项目内核已重启` });
      invalidate("services", svc.name);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast("保存冲突", {
          tone: "bad", duration: 10_000, action: { label: "重新载入", onClick: () => void reload() },
          description: `${e.message}。重新载入会用最新内容替换编辑器，先把你的修改复制出来`,
        });
      } else toast.error("保存失败", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const ack = async () => {
    setAcking(true);
    try {
      await api.ackConfig(svc.name, env, path);
      toast("已标记为已核对", { description: "以当前上游为准，不再提示待更新" });
      invalidate("services", svc.name);
    } catch (e) {
      toast.error("操作失败", (e as Error).message);
    } finally {
      setAcking(false);
    }
  };

  return (
    <Card className="min-w-0">
      <CardHeader icon={<LuFileText />} title={<span className="font-mono">{path}</span>}
        description={data && <>→ <span className="font-mono">{data.canonical}</span>{data.upstream && <> · 上游 <span className="font-mono">{data.upstream}</span></>}</>}
        actions={<>
          <Button size="sm" variant="ghost" icon={<LuHistory />} onClick={() => setHistoryOpen(true)}>历史</Button>
          <Button size="icon-sm" variant="ghost" aria-label="重新载入" title={dirty ? "重新载入会丢掉未保存的修改" : "重新载入"} onClick={() => void reload()}><LuRefreshCw /></Button>
        </>} />
      {error ? <ErrorState error={error} onRetry={refetch} /> : !data || !base ? <div className="p-4"><Skeleton className="h-80" /></div> : (
        <div className="space-y-3 p-4">
          {up?.pending && (
            <div className="rounded-md border border-warn/40 bg-warn-soft/60 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-warn">
                <LuCircleAlert className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">仓库里的 <span className="font-mono">{up.upstream}</span>{up.since ? ` 自 ${ago(up.since)}核对以来` : ""}变了，本环境的这个文件可能要跟着改。改完保存，或确认不用改：</span>
                <Button size="xs" loading={acking} onClick={ack}>已核对，无需修改</Button>
              </div>
              {up.diff && <CodeBlock title="上游 diff" code={up.diff} maxHeight={280} className="mt-2" />}
            </div>
          )}
          {stale && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-bad/30 bg-bad-soft/50 px-3 py-2 text-[12.5px] text-bad">
              <LuTriangleAlert className="size-4 shrink-0" /><span className="min-w-0 flex-1">文件在你打开之后被改过：现在保存会被拒绝。先复制你的修改，再重新载入。</span>
              <Button size="xs" onClick={() => void reload()}>重新载入</Button>
            </div>
          )}
          {!data.exists && <div className="flex items-center gap-2 text-[12.5px] text-fg-3"><LuInfo className="size-4 shrink-0" />文件还不存在：保存即创建。</div>}
          {running.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-info/30 bg-info-soft/50 px-3 py-2 text-[12.5px] text-info">
              <LuServer className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">进程 <span className="font-mono">{running.join("、")}</span> 在 {env} 跑着，重启后才读到新配置。</span>
              <Button size="xs" onClick={onOpenProcesses}>去重启</Button>
            </div>
          )}
          <Textarea mono value={draft} spellCheck={false} aria-label={`编辑 ${path}`}
            rows={Math.min(36, Math.max(14, draft.split("\n").length + 2))} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1 text-[11.5px] text-warn"><LuTriangleAlert className="size-3.5" />按原文显示，密钥没有打码</span>
            <span className="ml-auto text-[11.5px] text-fg-3">{dirty ? "有未保存的修改" : data.exists ? `sha ${base.sha}` : ""}</span>
            <Button size="sm" disabled={!dirty || saving} onClick={() => setDraft(base.content)}>还原</Button>
            <Button size="sm" variant="primary" loading={saving} disabled={!dirty && data.exists} onClick={save}>保存</Button>
          </div>
        </div>
      )}
      <HistoryDrawer svc={svc} env={env} path={path} open={historyOpen} onClose={() => setHistoryOpen(false)}
        onLoad={(content) => { setDraft(content); setHistoryOpen(false); toast.info("已载入编辑器", "检查无误后点保存"); }} />
    </Card>
  );
}

/** 备份：每份是 replaced_by 在 at 保存之前的内容；载入编辑器后再保存 = 恢复 */
function HistoryDrawer({ svc, env, path, open, onClose, onLoad }: {
  svc: ServiceSummary; env: string; path: string; open: boolean; onClose: () => void; onLoad: (content: string) => void;
}) {
  const { data, loading, error, refetch } = useConfigHistory(svc.name, env, path, open);
  const [sel, setSel] = useState<string | null>(null);
  const current = sel ?? data?.[0]?.id ?? null;
  const { data: version } = useQuery(["services", svc.name, "config-version", env, path, current], () => api.configVersion(svc.name, env, path, current!), { enabled: open && !!current });
  return (
    <Drawer open={open} onClose={onClose} width="w-[760px]" title={`${path} 的历史`} subtitle={`${svc.name} · ${env} · 每次保存前的内容，保留最近 30 份`}>
      <div className="space-y-3 p-4">
        {error ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={3} className="p-0" /> : !data?.length ? (
          <Empty icon={<LuHistory />} title="还没有备份" description="在这里保存过之后，每次保存前的内容都会留一份" />
        ) : (
          <>
            <ul className="divide-y divide-line rounded-md border border-line">
              {data.map((v) => (
                <li key={v.id}>
                  <button type="button" onClick={() => setSel(v.id)}
                    className={cn("flex w-full items-center gap-3 px-3 py-2 text-left text-[12.5px] transition-colors", current === v.id ? "bg-accent-soft" : "hover:bg-hover")}>
                    <span className="text-fg" title={datetime(v.at, true)}>{datetime(v.at)}</span>
                    <span className="text-fg-3">{v.replaced_by} 保存前的内容</span>
                    <span className="ml-auto text-[11.5px] text-fg-3">{bytes(v.size)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {!version || version.id !== current ? <Skeleton className="h-64" /> : (
              <>
                <CodeBlock code={version.content} maxHeight={520} />
                <div className="flex items-center gap-2">
                  <span className="text-[11.5px] text-warn">按原文显示，密钥没有打码</span>
                  <Button size="sm" variant="primary" className="ml-auto" onClick={() => onLoad(version.content)}>载入编辑器</Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
