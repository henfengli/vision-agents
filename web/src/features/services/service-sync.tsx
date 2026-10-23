/**
 * 代码同步（服务×环境）：代码目录对齐到跟踪分支（内建任务 code-sync），之后按变更跑同步步骤（装依赖、collectstatic…）。
 * 面板看当前提交、远端最近一次检查（代码跟踪每小时一次）、各步骤是否待跑与上次结果、配置是否待更新；
 * 立即同步 = 每个环境提交一次 code-sync（POST /v1/services/{s}/sync）；强制重跑步骤 = 带 force，所有步骤不管变没变都重跑。
 */
import { useState } from "react";
import { LuCircleAlert, LuCircleCheck, LuCircleX, LuFileText, LuGitBranch, LuGitPullRequestArrow, LuRefreshCw, LuRotateCcw } from "react-icons/lu";

import { api, useSyncStatus } from "@/api/hooks";
import type { SyncAccepted } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Mono } from "@/components/ui/data";
import { Tooltip, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, DescList, ErrorState, SectionTitle, Skeleton } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, datetime, shortId } from "@/lib/format";
import { invalidate } from "@/lib/query";
import { Link } from "@/lib/router";

/** 发起同步后的提示：每个环境一行，链到它的 code-sync 运行；没发起的给原因 */
function announce(results: SyncAccepted[]) {
  const ok = results.filter((r) => r.run_id);
  const bad = results.filter((r) => !r.run_id);
  const lines = (
    <span className="flex flex-col gap-0.5">
      {ok.map((r) => (
        <Link key={r.env} to={`/runs/${r.run_id}`} className="text-accent hover:underline">{r.env} · 运行 <span className="font-mono">{shortId(r.run_id!)}</span></Link>
      ))}
      {bad.map((r) => <span key={r.env} className="text-bad">{r.env}：{r.error?.message ?? r.status}</span>)}
    </span>
  );
  if (!ok.length) toast("没能发起同步", { tone: "bad", description: lines, duration: 8000 });
  else toast(bad.length ? `已发起 ${ok.length} 个环境的同步，${bad.length} 个没发起` : "已发起代码同步", { description: lines, duration: 8000 });
}

type Mode = "env" | "all" | "force";

export function SyncPanel({ service, env, dirty, onOpenConfig }: { service: string; env: string; dirty?: boolean; onOpenConfig: () => void }) {
  const { data, error, fetching, refetch } = useSyncStatus(service, env);
  const [busy, setBusy] = useState<Mode | null>(null);

  const sync = async (mode: Mode) => {
    const branch = data?.branch || "跟踪分支";
    const ok = await confirm(mode === "all"
      ? { title: `同步 ${service} 的全部环境？`, description: "每个启用的环境各提交一次代码同步，对齐到跟踪分支的最新提交；装依赖这类共享步骤在用同一个解释器的环境之间只做一次。", confirmText: "全部同步" }
      : mode === "force"
        ? {
          title: `强制重跑 ${service} 在 ${env} 的同步步骤？`, confirmText: "强制重跑",
          description: <>不管依赖文件变没变，所有同步步骤（{data?.steps.map((s) => s.title).join("、") || "装依赖等"}）都重跑一遍，共享步骤也不跳过。{""}
            重建了 conda 环境、手工动过解释器之后用；平时的同步只跑触发文件变了的步骤。代码同样先对齐到 {branch} 的最新提交，跑完重启项目内核与在跑的进程。</>,
        }
        : { title: `同步 ${service} 在 ${env} 的代码？`, description: `把代码目录对齐到 ${branch} 的最新提交，再按变更跑同步步骤。已跟踪文件的本地改动先备份成补丁再丢弃；代码或依赖变了，项目内核和在跑的进程会重启。`, confirmText: "同步" });
    if (!ok) return;
    setBusy(mode);
    try {
      announce(await api.syncNow(service, mode === "all" ? {} : { envs: [env], force: mode === "force" }));
      invalidate("runs");
      invalidate("services", service);
    } catch (e) {
      toast.error("发起失败", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pendingConfigs = data?.configs.filter((c) => c.pending) ?? [];
  return (
    <Card>
      <CardHeader title="代码同步" icon={<LuGitPullRequestArrow />}
        description={!data ? "加载中" : data.auto ? `代码跟踪开着：定时（默认每小时）看一眼远端 ${data.branch}，有新提交自动同步` : "代码跟踪已关闭：只在这里手动同步"}
        actions={<Button size="icon-sm" variant="ghost" aria-label="刷新同步状态" title="刷新" onClick={() => refetch()}><LuRefreshCw className={cn(fetching && "animate-spin")} /></Button>} />
      <div className="p-4">
        {error ? <ErrorState error={error} onRetry={refetch} className="py-6" /> : !data ? <Skeleton className="h-40" /> : (
          <>
            <DescList items={[
              ["分支", (
                <span className="flex flex-wrap items-center gap-1.5">
                  <LuGitBranch className="size-3.5 text-fg-3" /><span className="font-mono text-[12px]">{data.branch}</span>
                  <Badge tone={data.auto ? "ok" : "idle"}>{data.auto ? "自动跟踪" : "手动"}</Badge>
                </span>
              )],
              ["当前提交", data.head ? (
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <code className="shrink-0 font-mono text-[12px] text-fg">{data.head.short}</code>
                    <span className="truncate" title={data.head.subject}>{data.head.subject}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-fg-3">
                    <span>{data.head.author} · <span title={datetime(data.head.committed_at)}>{ago(data.head.committed_at)}</span></span>
                    {dirty && <Tooltip content="已跟踪文件有本地改动：同步时先备份成补丁再丢弃"><Badge tone="warn">有本地改动</Badge></Tooltip>}
                  </div>
                </div>
              ) : <span className="text-fg-3">还没拉取：立即同步会克隆到代码目录</span>],
              ["远端", data.remote ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <code className="font-mono text-[12px] text-fg-2">{data.remote.commit.slice(0, 8)}</code>
                  <span className="text-fg-3" title={datetime(data.remote.checked_at, true)}>{ago(data.remote.checked_at)}检查</span>
                  {data.behind && <Tooltip content="远端有新提交，本环境还没同步上"><Badge tone="warn">落后远端</Badge></Tooltip>}
                </span>
              ) : <span className="text-fg-3">{data.auto ? "还没检查过" : "不自动检查"}</span>],
              ["目录", <Mono copy>{data.dir}</Mono>],
            ]} />

            {data.steps.length > 0 && (
              <div className="mt-4">
                <SectionTitle>同步步骤</SectionTitle>
                <ul className="space-y-1.5">
                  {data.steps.map((s) => (
                    <li key={s.title} className="rounded-md border border-line px-2.5 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg" title={s.title}>{s.title}</span>
                        {s.shared && <Tooltip content="用同一个解释器的环境共享，只做一次"><Badge tone="outline">共享</Badge></Tooltip>}
                        {s.pending && <Tooltip content="触发文件自上次成功以来变了：下次同步会跑"><Badge tone="warn">待运行</Badge></Tooltip>}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-fg-3" title={s.when.join("\n")}>{s.when.join("  ")}</div>
                      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px]">
                        {!s.last ? <span className="text-fg-3">还没跑过</span> : <>
                          {s.last.ok ? <LuCircleCheck className="size-3.5 shrink-0 text-ok" /> : <LuCircleX className="size-3.5 shrink-0 text-bad" />}
                          <Tooltip content={s.last.message ? <pre className="whitespace-pre-wrap font-mono text-[11px]">{s.last.message.slice(-400)}</pre> : null}>
                            <span className={s.last.ok ? "text-fg-2" : "text-bad"}>{s.last.ok ? "成功" : `失败（退出码 ${s.last.code}）`}</span>
                          </Tooltip>
                          <span className="truncate text-fg-3" title={datetime(s.last.at, true)}>· {ago(s.last.at)}{s.last.env !== env && ` · 在 ${s.last.env}`}</span>
                          {s.last.run_id && <Link to={`/runs/${s.last.run_id}`} className="ml-auto shrink-0 font-mono text-accent hover:underline">{shortId(s.last.run_id)}</Link>}
                        </>}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {pendingConfigs.length > 0 && (
              <div className="mt-4 rounded-md border border-warn/40 bg-warn-soft px-3 py-2.5 text-[12.5px] text-warn">
                <div className="flex items-center gap-1.5 font-medium"><LuCircleAlert className="size-4 shrink-0" />配置待更新</div>
                <ul className="mt-1 space-y-0.5">
                  {pendingConfigs.map((c) => <li key={c.path} className="truncate font-mono text-[11.5px]" title={c.path}>{c.path} ← {c.upstream}</li>)}
                </ul>
                <Button size="xs" className="mt-2" icon={<LuFileText />} onClick={onOpenConfig}>去核对</Button>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <Tooltip content={data.enabled ? null : `${service} 在 ${env} 已停用`}>
                <span><Button size="sm" icon={<LuGitPullRequestArrow />} loading={busy === "env"} disabled={!data.enabled || !!busy} onClick={() => sync("env")}>立即同步</Button></span>
              </Tooltip>
              <Button size="sm" variant="ghost" loading={busy === "all"} disabled={!!busy} onClick={() => sync("all")}>同步全部环境</Button>
              {data.steps.length > 0 && (
                <Tooltip content="所有同步步骤都重跑，重建了 conda 环境之后用">
                  <span><Button size="sm" variant="ghost" icon={<LuRotateCcw />} loading={busy === "force"} disabled={!data.enabled || !!busy} onClick={() => sync("force")}>强制重跑步骤</Button></span>
                </Tooltip>
              )}
              <span className="w-full text-[11.5px] text-fg-3">内建任务 code-sync，结果在运行里看</span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
