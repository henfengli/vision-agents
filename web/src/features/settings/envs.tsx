/**
 * 环境：平台可操作的业务环境列表。停用 = 拒收一切新运行（env_disabled）；
 * 受保护 = 命中策略、危险命令、进程启停都要审批。
 */
import { LuLayers, LuShieldCheck } from "react-icons/lu";

import { api, useEnvs, useMeta, useStats } from "@/api/hooks";
import type { Env } from "@/api/types";
import { Page, PageHeader } from "@/components/layout/shell";
import { EnvBadge } from "@/components/status";
import { Switch } from "@/components/ui/form";
import { confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, Empty, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { invalidate } from "@/lib/query";

export function EnvsPage() {
  const { data, loading } = useEnvs();
  const { data: meta } = useMeta();
  const { data: stats } = useStats({ hours: 24 });
  const update = async (e: Env, patch: Partial<Env>, text: string) => {
    const danger = patch.enabled === false || patch.protected === false;
    const ok = await confirm({ title: text, description: patch.enabled === false ? "停用后该环境的一切新提交、事件与定时都会被拒（env_disabled）；运行中的不受影响。" : patch.protected === false ? "取消保护后，该环境的危险命令与进程启停不再强制审批。" : undefined, danger, confirmText: "确定", requireText: patch.enabled === false && e.protected ? e.name : undefined });
    if (!ok) return;
    try { await api.putEnv(e.name, patch); toast("已更新"); invalidate("envs"); } catch (err) { toast.error("更新失败", (err as Error).message); }
  };
  return (
    <Page>
      <PageHeader title="环境" description={`一套 agent 部署操作多套业务环境：每个运行请求都带 env（缺省 = ${meta?.default_env ?? "test"}）。运行、记忆、产物复用、闸门都按它分区。`} />
      <Card>
        <CardHeader icon={<LuLayers />} title="业务环境" description="环境清单来自平台配置（target_envs）；这里控制启停与保护" />
        {loading ? <SkeletonRows rows={3} /> : !data?.length ? <Empty title="没有环境" /> : (
          <ul className="divide-y divide-line">
            {data.map((e) => {
              const s = stats?.by_env[e.name];
              return (
                <li key={e.name} className={cn("flex items-center gap-4 px-4 py-4", !e.enabled && "opacity-60")}>
                  <EnvBadge env={e.name} className="h-6 px-2 text-[12px]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13.5px] font-medium text-fg">{e.title}{e.name === meta?.default_env && <Badge tone="accent">默认</Badge>}{!e.enabled && <Badge tone="idle">已停用</Badge>}</div>
                    <div className="mt-0.5 text-[12.5px] text-fg-3">{e.description}</div>
                    <div className="mt-1 text-[11.5px] text-fg-3">近 24h {s?.runs ?? 0} 次运行 · 失败 {s?.failed ?? 0} · v{e.version}</div>
                  </div>
                  <div className="flex items-center gap-6">
                    <div className="text-right">
                      <Switch checked={e.protected} onChange={(v) => update(e, { protected: v }, v ? `把 ${e.name} 设为受保护？` : `取消 ${e.name} 的保护？`)} label={<span className="flex items-center gap-1 text-[12.5px]"><LuShieldCheck className="size-3.5" />受保护</span>} />
                    </div>
                    <Switch checked={e.enabled} onChange={(v) => update(e, { enabled: v }, v ? `启用 ${e.name}？` : `停用 ${e.name}？`)} label={<span className="text-[12.5px]">{e.enabled ? "启用中" : "已停用"}</span>} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <div className="mt-3 text-xs text-fg-3">新增环境：在平台配置 <code className="font-mono">target_envs</code> 里加上名字并重启；随后为各服务补环境覆盖（主机、只读库）与配置文件。</div>
    </Page>
  );
}
