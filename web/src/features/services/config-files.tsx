/**
 * 给 agent 的只读版配置（服务×环境）：服务定义里声明的每个配置路径，在这个环境给 agent 填一份内容。
 * 项目内核启动时平台把它盖在那个路径上——agent 的项目代码照常 import、照常连库，连上去的是只读账号；
 * 线上那份真实配置平台不读、不显示。内容存库、每次保存一个新版本（内容没变不加版本）。
 * 历史里每一版都能看、和当前版对比、载入编辑器再保存（= 恢复）。
 */
import { useEffect, useState } from "react";
import { LuCircleAlert, LuFileText, LuGitCompare, LuHistory, LuInfo, LuRefreshCw, LuTriangleAlert } from "react-icons/lu";

import { api, useConfigHistory, useConfigRaw, useServiceEnv } from "@/api/hooks";
import type { ConfigFileStatus, ConfigRaw, ServiceSummary } from "@/api/types";
import { Button } from "@/components/ui/button";
import { CodeBlock, DiffView } from "@/components/ui/data";
import { Segmented, Textarea } from "@/components/ui/form";
import { Drawer, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, Empty, ErrorState, Skeleton, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, bytes, datetime } from "@/lib/format";
import { invalidate, setQueryData, useQuery } from "@/lib/query";
import { useLeaveGuard } from "@/lib/router";

/** 一个配置路径的状态徽标：给 agent 填到第几版 / 未填 */
export function ConfigStatusBadges({ file }: { file: ConfigFileStatus }) {
  return file.version != null
    ? <Badge tone="ok" title={`${file.updated_by ?? ""} 更新于 ${datetime(file.updated_at)}`}>已填第 {file.version} 版</Badge>
    : <Badge tone="warn" title="还没有填给 agent 的只读版：py 工具在这个环境起不来">未填</Badge>;
}

export function ConfigFilesView({ svc, env, onOpenDefinition }: { svc: ServiceSummary; env: string; onOpenDefinition: () => void }) {
  const { data: view, error, refetch } = useServiceEnv(svc.name, env);
  const files = view?.config_files;
  const [picked, setPicked] = useState<string | null>(null);
  // 默认选中第一个还没填的（最需要处理）；挑定之后不再跳
  useEffect(() => {
    if (!files || (picked && files.some((f) => f.key === picked))) return;
    setPicked(files.find((f) => f.version == null)?.key ?? files[0]?.key ?? null);
  }, [files, picked]);
  /** 切环境后旧的选择不在新列表里：等上面重新挑 */
  const active = picked && files?.some((f) => f.key === picked) ? files.find((f) => f.key === picked)! : null;
  const dagster = (files ?? []).some((f) => f.path.endsWith("dagster.yaml"));

  if (error) return <Card><ErrorState error={error} onRetry={refetch} /></Card>;
  return (
    <div className="space-y-4">
      <div className="flex gap-2.5 rounded-lg border border-info/30 bg-info-soft/40 px-4 py-3 text-[12.5px] leading-relaxed text-fg-2">
        <LuInfo className="mt-0.5 size-4 shrink-0 text-info" />
        <div className="space-y-1">
          <div>这里填的是 agent 的项目内核在这个路径上读到的内容：py 里项目代码照常 import 配置、照常连库。<b className="font-medium text-fg">线上那份真实配置平台不读、不显示</b>，agent 在 bash 里也看不到。</div>
          <div>照抄线上的配置，把库口令换成只读账号。{dagster && <>dagster.yaml 里不要写运行存储（run / event_log / schedule storage）的连接：项目内核不该连 Dagster 自己的库。</>}还没填的路径，py 工具在 {env} 起不来。</div>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Card className="h-fit">
          <CardHeader title="配置文件" icon={<LuFileText />} description={`${env} 给 agent 的只读版`} />
          {!files ? <SkeletonRows rows={2} /> : !files.length ? (
            <Empty title="没有声明配置文件" description="在服务定义的「配置文件」里写项目读配置的路径（可写 ~、{env}）" action={<Button size="sm" onClick={onOpenDefinition}>去声明</Button>} />
          ) : (
            <ul className="p-1.5">
              {files.map((f) => (
                <li key={f.key}>
                  <button type="button" onClick={() => setPicked(f.key)}
                    className={cn("w-full rounded-md px-2.5 py-2 text-left transition-colors", active?.key === f.key ? "bg-accent-soft" : "hover:bg-hover")}>
                    <div className="flex items-center gap-1.5">
                      <span className={cn("min-w-0 flex-1 truncate font-mono text-[12.5px]", active?.key === f.key ? "text-accent" : "text-fg")} title={f.path}>{f.path.split("/").pop()}</span>
                      <ConfigStatusBadges file={f} />
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-fg-3" title={f.path}>{f.path}</div>
                    {f.version != null && <div className="text-[11px] text-fg-3">{f.updated_by} · {ago(f.updated_at)}</div>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {active && <ConfigEditor key={`${env}|${active.key}`} svc={svc} env={env} file={active} />}
      </div>
    </div>
  );
}

function ConfigEditor({ svc, env, file }: { svc: ServiceSummary; env: string; file: ConfigFileStatus }) {
  const path = file.key;
  const key = ["services", svc.name, "config", env, path];
  const { data, error, refetch } = useConfigRaw(svc.name, env, path);
  /** 打开（或重新载入、保存）时的内容：和它比较判断有没有未保存的修改 */
  const [base, setBase] = useState<{ content: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const dirty = !!base && draft !== base.content;
  /** 有未保存的修改时，换标签、切环境、换页面、关窗口前先确认（这些都会卸载编辑器） */
  useLeaveGuard(dirty, ["tab", "part", "env"]);
  // 服务端内容变了：没改过就跟着换；改过就留着
  useEffect(() => {
    if (data && (!base || (!dirty && data.content !== base.content))) {
      setBase({ content: data.content });
      setDraft(data.content);
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = async () => {
    const d = await refetch();
    if (d) { setBase({ content: d.content }); setDraft(d.content); }
  };
  const save = async () => {
    if (!base) return;
    setSaving(true);
    try {
      const res = await api.saveConfig(svc.name, env, { path, content: draft });
      setBase({ content: draft });
      setQueryData<ConfigRaw>(key, (old) => ({ ...old!, content: draft, exists: true, version: res.version }));
      if (res.changed) toast(`已保存为第 ${res.version} 版`, { description: `${env} 的项目内核下次调用时自动重启，读到新内容` });
      else toast.info("内容没变", "没有加新版本");
      invalidate("services", svc.name);
    } catch (e) {
      toast.error("保存失败", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="min-w-0">
      <CardHeader icon={<LuFileText />} title={<span className="font-mono">{file.path}</span>}
        description={data && (data.exists
          ? <>第 {data.version} 版 · {data.updated_by ?? "—"} 更新于 {ago(data.updated_at)}{file.key !== file.path && <> · 定义里写作 <span className="font-mono">{file.key}</span></>}</>
          : <>还没有填{file.key !== file.path && <> · 定义里写作 <span className="font-mono">{file.key}</span></>}</>)}
        actions={<>
          <Button size="sm" variant="ghost" icon={<LuHistory />} onClick={() => setHistoryOpen(true)} disabled={!data?.exists}>历史</Button>
          <Button size="icon-sm" variant="ghost" aria-label="重新载入" title={dirty ? "重新载入会丢掉未保存的修改" : "重新载入"} onClick={() => void reload()}><LuRefreshCw /></Button>
        </>} />
      {error ? <ErrorState error={error} onRetry={refetch} /> : !data || !base ? <div className="p-4"><Skeleton className="h-80" /></div> : (
        <div className="space-y-3 p-4">
          {!data.exists && (
            <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft/60 px-3 py-2 text-[12.5px] text-warn">
              <LuCircleAlert className="mt-0.5 size-4 shrink-0" />
              <span>还没有填：py 工具在 {env} 起不来（config_missing）。把线上那份复制过来、口令换成只读账号，保存即第 1 版。</span>
            </div>
          )}
          <Textarea mono value={draft} spellCheck={false} aria-label={`编辑 ${file.path}`} placeholder={"# 照抄线上的配置，库口令换成只读账号"}
            rows={Math.min(36, Math.max(14, draft.split("\n").length + 2))} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1 text-[11.5px] text-warn"><LuTriangleAlert className="size-3.5" />按原文显示，密钥没有打码</span>
            <span className="ml-auto text-[11.5px] text-fg-3">{dirty ? "有未保存的修改" : ""}</span>
            <Button size="sm" disabled={!dirty || saving} onClick={() => setDraft(base.content)}>还原</Button>
            <Button size="sm" variant="primary" loading={saving} disabled={!dirty || (!data.exists && !draft.trim())} onClick={save}>{data.exists ? "保存为新版本" : "保存为第 1 版"}</Button>
          </div>
        </div>
      )}
      <HistoryDrawer svc={svc} env={env} file={file} current={data?.exists ? { version: data.version, content: data.content } : null}
        open={historyOpen} onClose={() => setHistoryOpen(false)}
        onLoad={(content, version) => { setDraft(content); setHistoryOpen(false); toast.info(`已把第 ${version} 版载入编辑器`, "检查无误后点保存（= 恢复成新版本）"); }} />
    </Card>
  );
}

/** 版本历史：每次保存一版，新的在前；看内容 / 和当前版对比 / 载入编辑器（再保存 = 恢复） */
function HistoryDrawer({ svc, env, file, current, open, onClose, onLoad }: {
  svc: ServiceSummary; env: string; file: ConfigFileStatus; current: { version: number | null; content: string } | null;
  open: boolean; onClose: () => void; onLoad: (content: string, version: number) => void;
}) {
  const path = file.key;
  const { data, loading, error, refetch } = useConfigHistory(svc.name, env, path, open);
  const [sel, setSel] = useState<number | null>(null);
  const [mode, setMode] = useState<"content" | "diff">("content");
  const selected = sel ?? data?.[0]?.version ?? null;
  const { data: version } = useQuery(["services", svc.name, "config-version", env, path, selected],
    () => api.configVersion(svc.name, env, path, selected!), { enabled: open && selected != null });
  const isCurrent = selected != null && selected === current?.version;
  return (
    <Drawer open={open} onClose={onClose} width="w-[820px]" title={`${file.path.split("/").pop()} 的历史`} subtitle={`${svc.name} · ${env} · 给 agent 的只读版，每次保存一版`}>
      <div className="space-y-3 p-4">
        {error ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows rows={3} className="p-0" /> : !data?.length ? (
          <Empty icon={<LuHistory />} title="还没有版本" description="保存过之后，每一版都留在这里" />
        ) : (
          <>
            <ul className="divide-y divide-line rounded-md border border-line">
              {data.map((v) => (
                <li key={v.version}>
                  <button type="button" onClick={() => setSel(v.version)}
                    className={cn("flex w-full items-center gap-3 px-3 py-2 text-left text-[12.5px] transition-colors", selected === v.version ? "bg-accent-soft" : "hover:bg-hover")}>
                    <span className="w-12 shrink-0 font-medium tabular-nums text-fg">v{v.version}</span>
                    {v.version === current?.version && <Badge tone="ok">当前</Badge>}
                    <span className="text-fg-2">{v.updated_by}</span>
                    <span className="text-fg-3" title={datetime(v.updated_at, true)}>{ago(v.updated_at)}</span>
                    <span className="ml-auto text-[11.5px] text-fg-3">{bytes(v.size)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {!version || version.version !== selected ? <Skeleton className="h-64" /> : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented size="sm" value={isCurrent ? "content" : mode} onChange={setMode}
                    options={[{ value: "content", label: "内容", icon: <LuFileText /> }, ...(isCurrent || !current ? [] : [{ value: "diff" as const, label: `与当前 v${current.version} 对比`, icon: <LuGitCompare /> }])]} />
                  <span className="text-[11.5px] text-fg-3">v{version.version} · {version.updated_by} · {datetime(version.updated_at, true)}</span>
                </div>
                {mode === "diff" && !isCurrent && current
                  ? <DiffView before={version.content} after={current.content} className="max-h-[520px]" />
                  : <CodeBlock code={version.content} maxHeight={520} />}
                <div className="flex items-center gap-2">
                  <span className="text-[11.5px] text-warn">按原文显示，密钥没有打码</span>
                  <Button size="sm" variant="primary" className="ml-auto" disabled={isCurrent} title={isCurrent ? "这就是当前版" : undefined}
                    onClick={() => onLoad(version.content, version.version)}>载入编辑器</Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
