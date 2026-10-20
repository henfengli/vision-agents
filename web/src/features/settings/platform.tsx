/**
 * 平台配置五节：环境、审批、通知、记忆、进程。对所有人生效，每次保存是一个新版本，可对比、可恢复。
 * 每页同一个套路：读当前配置 → 本地草稿 → 底部保存条 → PUT 整节。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LuHistory, LuPlus, LuSend, LuTrash2 } from "react-icons/lu";

import { api, useMeta, useServices, useSettings, useTasks } from "@/api/hooks";
import type {
  Channel, ConfigSection, ConfigSections, EnvColor, NotifyEvent, NotifyRule,
} from "@/api/types";
import { SaveBar } from "@/components/save-bar";
import { EnvBadge } from "@/components/status";
import { VersionHistory } from "@/components/versions";
import { Button } from "@/components/ui/button";
import { Table, Td, Th, Tr } from "@/components/ui/data";
import { Checkbox, Field, Input, Segmented, Select, Switch, TagInput, Textarea } from "@/components/ui/form";
import { confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, Empty, Skeleton } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { Link } from "@/lib/router";
import { SettingRow, SettingsLayout } from "./layout";

// ———————— 共用：一节配置的草稿与保存 ————————

const LEDGER = ["section", "version", "updated_by", "updated_at"];

function useSection<S extends ConfigSection>(section: S) {
  const { data } = useSettings();
  const entry = data?.[section];
  const [draft, setDraft] = useState<ConfigSections[S] | null>(null);
  const pristine = useMemo(() => (entry ? Object.fromEntries(Object.entries(entry).filter(([k]) => !LEDGER.includes(k))) as ConfigSections[S] : null), [entry]);
  useEffect(() => { if (pristine) setDraft(structuredClone(pristine)); }, [pristine]);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(pristine);
  const save = useMutation(async () => {
    if (!draft) return;
    try {
      const saved = await api.putSettings(section, draft);
      toast(`已保存为 v${saved.version}`, { description: "立即对所有人生效" });
      invalidate("settings");
      if (section === "envs" || section === "notifications") invalidate("meta");
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  });
  return { entry, draft, setDraft, dirty, save, reset: () => pristine && setDraft(structuredClone(pristine)) };
}

function SectionPage<S extends ConfigSection>({ section, title, description, children }: {
  section: S; title: string; description: ReactNode;
  children: (draft: ConfigSections[S], set: (d: ConfigSections[S]) => void) => ReactNode;
}) {
  const s = useSection(section);
  const [history, setHistory] = useState(false);
  return (
    <SettingsLayout title={title} description={description}
      actions={<>
        {s.entry && <span className="text-[12px] text-fg-3">v{s.entry.version} · {s.entry.updated_by || "默认"} · {ago(s.entry.updated_at)}</span>}
        <Button icon={<LuHistory />} variant={history ? "secondary" : "ghost"} onClick={() => setHistory(!history)}>{history ? "返回编辑" : "版本"}</Button>
      </>}>
      {history ? <VersionHistory kind={`settings/${section}`} /> : !s.draft ? <Skeleton className="h-80" /> : (
        <div className="space-y-4 pb-20">{children(s.draft, s.setDraft)}</div>
      )}
      <SaveBar visible={s.dirty && !history} saving={s.save.pending} onDiscard={s.reset} onSave={() => s.save.mutate(undefined)} label={`保存为 v${(s.entry?.version ?? 0) + 1}`} />
    </SettingsLayout>
  );
}

// ———————— 环境 ————————

const COLORS: EnvColor[] = ["red", "amber", "blue", "green", "violet", "gray"];
const COLOR_DOT: Record<EnvColor, string> = { red: "bg-[#ef4444]", amber: "bg-[#f59e0b]", blue: "bg-[#3b82f6]", green: "bg-[#22c55e]", violet: "bg-[#8b5cf6]", gray: "bg-fg-3" };

export function EnvsSettingsPage() {
  const { data: services } = useServices();
  return (
    <SectionPage section="envs" title="环境" description={<>平台可操作的业务环境。每个运行请求都带环境（不带就用默认环境）；运行、记忆、产物复用都按它分区。<b className="font-medium text-fg-2">某个服务在某个环境是否启用</b>，在服务页的「环境」里设置。</>}>
      {(d, set) => (
        <>
          <Card>
            <CardHeader title="环境列表" actions={<Button size="sm" icon={<LuPlus />} onClick={() => set({ ...d, items: [...d.items, { name: "", title: "", description: "", protected: false, color: "gray" }] })}>添加环境</Button>} />
            <div className="divide-y divide-line">
              {d.items.map((e, i) => {
                const patch = (p: Partial<typeof e>) => set({ ...d, items: d.items.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                return (
                  <div key={i} className="grid gap-3 px-4 py-3.5 md:grid-cols-[110px_1fr_auto]">
                    <Field label="名字"><Input mono value={e.name} placeholder="staging" onChange={(ev) => patch({ name: ev.target.value.trim().toLowerCase() })} /></Field>
                    <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
                      <Field label="显示名"><Input value={e.title} onChange={(ev) => patch({ title: ev.target.value })} /></Field>
                      <Field label="说明"><Input value={e.description} onChange={(ev) => patch({ description: ev.target.value })} /></Field>
                    </div>
                    <div className="flex items-end gap-4 pb-1">
                      <div className="flex items-center gap-1">
                        {COLORS.map((c) => (
                          <button key={c} type="button" title={c} onClick={() => patch({ color: c })}
                            className={cn("size-5 rounded-full ring-offset-2 ring-offset-panel", COLOR_DOT[c], e.color === c && "ring-2 ring-accent")} />
                        ))}
                      </div>
                      <Switch checked={e.protected} onChange={(v) => patch({ protected: v })} label={<span className="text-[12.5px]">受保护</span>} />
                      <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-fg-2">
                        <input type="radio" checked={d.default === e.name} onChange={() => set({ ...d, default: e.name })} className="accent-[var(--color-accent)]" />默认
                      </label>
                      <Button size="icon-sm" variant="ghost" title="移除" disabled={d.items.length <= 1}
                        onClick={async () => {
                          if (e.name && !(await confirm({ title: `移除环境 ${e.name}？`, description: "移除后：引用它的任务环境限制、定时触发会保存失败，需要先改掉；历史运行与记忆不受影响。", danger: true, confirmText: "移除" }))) return;
                          set({ ...d, items: d.items.filter((_, j) => j !== i), default: d.default === e.name ? d.items.find((_, j) => j !== i)!.name : d.default });
                        }}><LuTrash2 /></Button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-line px-4 py-2.5 text-[12px] text-fg-3">受保护：危险命令、进程启停、命中「需审批」策略的提交都要人放行（规则见「审批」）。</div>
          </Card>
          <Card>
            <CardHeader title="各服务的启用情况" description="点服务名去服务页修改（服务 → 环境 → 启用）" />
            <Table>
              <thead><tr><Th>服务</Th>{d.items.map((e) => <Th key={e.name} className="text-center"><EnvBadge env={e.name} /></Th>)}</tr></thead>
              <tbody>
                {(services ?? []).map((s) => (
                  <Tr key={s.name}>
                    <Td><Link to={`/services/${s.name}?tab=envs`} className="font-medium text-fg hover:text-accent">{s.name}</Link>{!s.enabled && <Badge tone="idle" className="ml-2">服务已停用</Badge>}</Td>
                    {d.items.map((e) => {
                      const on = s.enabled && s.envs[e.name]?.enabled !== false;
                      return <Td key={e.name} className="text-center">{on ? <span className="text-ok">●</span> : <span className="text-fg-3">○</span>}</Td>;
                    })}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </SectionPage>
  );
}

// ———————— 审批 ————————

export function ApprovalsSettingsPage() {
  const [sample, setSample] = useState("rm -rf /srv/board/logs/2026-09-*");
  return (
    <SectionPage section="approvals" title="审批" description="agent 在运行中要执行危险命令时挂起等人放行；超时视同拒绝。提交时的审批由「提交策略」决定，进程启停在受保护环境总是要审批。">
      {(d, set) => {
        const hit = d.danger_patterns.find((p) => { try { return new RegExp(p, "i").test(sample); } catch { return false; } });
        return (
          <>
            <Card>
              <div className="divide-y divide-line">
                <SettingRow title="哪些环境要审批危险命令" hint="仅受保护环境：prod 这类；所有环境：test/dev 里的危险命令也要审批">
                  <Segmented value={d.required_in} onChange={(v) => set({ ...d, required_in: v })} options={[{ value: "protected", label: "仅受保护环境" }, { value: "all", label: "所有环境" }]} />
                </SettingRow>
                <SettingRow title="等待时长" hint="超过这个时间没人处理，视同拒绝">
                  <div className="flex items-center gap-2"><Input className="w-20" inputMode="numeric" value={d.timeout_minutes} onChange={(e) => set({ ...d, timeout_minutes: Number(e.target.value) || 1 })} /><span className="text-[12.5px] text-fg-3">分钟</span></div>
                </SettingRow>
              </div>
            </Card>
            <Card>
              <CardHeader title="危险命令模式" description="正则，不区分大小写；bash、run_code 的代码、service_ctl 都按它判断" />
              <div className="space-y-4 p-4">
                <Textarea mono rows={Math.max(5, d.danger_patterns.length + 1)} value={d.danger_patterns.join("\n")}
                  onChange={(e) => set({ ...d, danger_patterns: e.target.value.split("\n").filter((x, i, a) => x.trim() || i < a.length - 1) })} />
                <Field label="试一下" help={hit ? <span className="text-warn">命中 <code className="font-mono">{hit}</code> → 挂起等审批</span> : <span className="text-ok">未命中 → 直接执行</span>}>
                  <Input mono value={sample} onChange={(e) => setSample(e.target.value)} />
                </Field>
              </div>
            </Card>
          </>
        );
      }}
    </SectionPage>
  );
}

// ———————— 通知 ————————

const EVENTS: { value: NotifyEvent; label: string; hint: string }[] = [
  { value: "run_failed", label: "运行失败", hint: "" },
  { value: "run_succeeded", label: "运行成功", hint: "量大，建议加范围" },
  { value: "approval_requested", label: "等待审批", hint: "" },
  { value: "process_stopped", label: "进程停止", hint: "租约到期或异常退出" },
];
const TRIGGERS = ["api", "chat", "schedule", "event", "web"];

export function NotificationsSettingsPage() {
  const { data: services } = useServices();
  const { data: tasks } = useTasks();
  const { data: meta } = useMeta();
  const [testing, setTesting] = useState("");
  const test = async (name: string) => {
    setTesting(name);
    try { await api.testChannel(name); toast(`已向 ${name} 发送测试消息`); } catch (e) { toast.error("发送失败", (e as Error).message); } finally { setTesting(""); }
  };
  return (
    <SectionPage section="notifications" title="通知" description="渠道是发到哪（钉钉群 / Webhook）；规则是什么事件、什么范围发到哪个渠道。任务的「结果投递」与 agent 的 notify 工具也用这里的渠道。">
      {(d, set) => {
        const channels = Object.entries(d.channels);
        const setChannel = (name: string, ch: Channel | null, rename?: string) => {
          const next = { ...d.channels };
          delete next[name];
          if (ch) next[rename ?? name] = ch;
          set({ ...d, channels: next, rules: rename ? d.rules.map((r) => (r.channel === name ? { ...r, channel: rename } : r)) : d.rules });
        };
        const setRule = (i: number, r: NotifyRule | null) => set({ ...d, rules: r ? d.rules.map((x, j) => (j === i ? r : x)) : d.rules.filter((_, j) => j !== i) });
        return (
          <>
            <Card>
              <CardHeader title="渠道" actions={<Button size="sm" icon={<LuPlus />} onClick={() => setChannel(`channel-${channels.length + 1}`, { type: "dingtalk", url: "", token: "" })}>添加渠道</Button>} />
              {!channels.length ? <Empty title="还没有渠道" description="至少建一个 default 渠道，任务的结果投递默认发到它" /> : (
                <div className="divide-y divide-line">
                  {channels.map(([name, ch]) => (
                    <div key={name} className="grid items-end gap-3 px-4 py-3.5 md:grid-cols-[150px_120px_1fr_180px_auto]">
                      <Field label="名字"><Input mono defaultValue={name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== name && setChannel(name, ch, e.target.value.trim())} /></Field>
                      <Field label="类型"><Select value={ch.type} onChange={(type) => setChannel(name, { ...ch, type })} options={[{ value: "dingtalk", label: "钉钉" }, { value: "webhook", label: "Webhook" }]} /></Field>
                      <Field label={ch.type === "dingtalk" ? "中继地址" : "POST 地址"}><Input mono value={ch.url} onChange={(e) => setChannel(name, { ...ch, url: e.target.value })} placeholder="https://…" /></Field>
                      <Field label={ch.type === "dingtalk" ? "机器人 access_token" : "Bearer token（可空）"}><Input mono type="password" value={ch.token} onChange={(e) => setChannel(name, { ...ch, token: e.target.value })} /></Field>
                      <div className="flex gap-1 pb-0.5">
                        <Button size="sm" icon={<LuSend />} loading={testing === name} onClick={() => test(name)} title="保存后才能测试新填的地址">测试</Button>
                        <Button size="icon-sm" variant="ghost" title="移除" onClick={() => setChannel(name, null)}><LuTrash2 /></Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card>
              <CardHeader title="规则" description="范围各项不填 = 不限；填了的之间是「且」"
                actions={<Button size="sm" icon={<LuPlus />} disabled={!channels.length} onClick={() => set({ ...d, rules: [...d.rules, { name: "新规则", enabled: true, events: ["run_failed"], services: [], envs: [], tasks: [], triggers: [], channel: channels[0][0] }] })}>添加规则</Button>} />
              {!d.rules.length ? <Empty title="还没有规则" description="没有规则时平台事件不会发通知（任务的结果投递不受影响）" /> : (
                <div className="divide-y divide-line">
                  {d.rules.map((r, i) => (
                    <div key={i} className={cn("space-y-3 px-4 py-4", !r.enabled && "opacity-60")}>
                      <div className="flex flex-wrap items-center gap-3">
                        <Input className="w-56" value={r.name} onChange={(e) => setRule(i, { ...r, name: e.target.value })} />
                        <span className="text-[12.5px] text-fg-3">发到</span>
                        <Select className="w-40" value={r.channel} onChange={(channel) => setRule(i, { ...r, channel })} options={channels.map(([n, c]) => ({ value: n, label: n, hint: c.type === "dingtalk" ? "钉钉" : "Webhook" }))} />
                        <div className="ml-auto flex items-center gap-2">
                          <Switch checked={r.enabled} onChange={(enabled) => setRule(i, { ...r, enabled })} size="sm" />
                          <Button size="icon-sm" variant="ghost" onClick={() => setRule(i, null)}><LuTrash2 /></Button>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-x-5 gap-y-1">
                        {EVENTS.map((ev) => (
                          <Checkbox key={ev.value} checked={r.events.includes(ev.value)} label={ev.label} hint={ev.hint || undefined}
                            onChange={(on) => setRule(i, { ...r, events: on ? [...r.events, ev.value] : r.events.filter((x) => x !== ev.value) })} />
                        ))}
                      </div>
                      <div className="grid gap-3 md:grid-cols-4">
                        <Field label="服务"><TagInput mono value={r.services} onChange={(services) => setRule(i, { ...r, services })} suggestions={(services ?? []).map((s) => s.name).slice(0, 5)} /></Field>
                        <Field label="环境"><TagInput mono value={r.envs} onChange={(envs) => setRule(i, { ...r, envs })} suggestions={(meta?.envs ?? []).map((e) => e.name)} /></Field>
                        <Field label="任务"><TagInput mono value={r.tasks} onChange={(t) => setRule(i, { ...r, tasks: t })} suggestions={(tasks ?? []).filter((t) => !t.extends).map((t) => t.name).slice(0, 5)} /></Field>
                        <Field label="触发方式"><TagInput mono value={r.triggers} onChange={(triggers) => setRule(i, { ...r, triggers })} suggestions={TRIGGERS} /></Field>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </>
        );
      }}
    </SectionPage>
  );
}

// ———————— 记忆 ————————

export function MemorySettingsPage() {
  return (
    <SectionPage section="memory" title="记忆" description="运行前召回什么、运行后沉淀什么的平台默认。任务可以单独覆盖（任务 → 设置），单次请求也可以再覆盖（请求 > 任务 > 这里）。">
      {(d, set) => (
        <Card>
          <div className="divide-y divide-line">
            <SettingRow title="召回" hint="运行前按问题检索历史知识、同类案例与方法，拼进提示"><Switch checked={d.recall} onChange={(recall) => set({ ...d, recall })} /></SettingRow>
            <SettingRow title="沉淀" hint="运行成功后用一次轻量模型调用提炼可复用的知识与案例"><Switch checked={d.save} onChange={(save) => set({ ...d, save })} /></SettingRow>
            <SettingRow title="会话交接摘要" hint="同一会话里，每轮结束写「结论 / 被否方案 / 当前约束 / 未决问题」，下一个同类会话召回置顶"><Switch checked={d.handoff_summary} onChange={(handoff_summary) => set({ ...d, handoff_summary })} /></SettingRow>
            <SettingRow title="每次最多召回知识" hint="条"><Input className="w-20" inputMode="numeric" value={d.knowledge_limit} onChange={(e) => set({ ...d, knowledge_limit: Math.min(20, Number(e.target.value) || 0) })} /></SettingRow>
            <SettingRow title="每次最多注入方法" hint="条；本任务的方法优先，其次服务通用"><Input className="w-20" inputMode="numeric" value={d.asset_limit} onChange={(e) => set({ ...d, asset_limit: Math.min(20, Number(e.target.value) || 0) })} /></SettingRow>
          </div>
        </Card>
      )}
    </SectionPage>
  );
}

// ———————— 进程 ————————

export function ProcessesSettingsPage() {
  const { data: meta } = useMeta();
  const backend = meta?.features.process_control;
  return (
    <SectionPage section="processes" title="进程" description="服务进程按环境启停（服务页 → 进程，或 agent 的 service_ctl 工具）。每次启动都带租约，到期自动停，调试用的环境不会被遗忘地一直跑着。">
      {(d, set) => (
        <>
          <Card>
            <div className="divide-y divide-line">
              <SettingRow title="默认租约" hint="进程定义里没写租约时用它"><div className="flex items-center gap-2"><Input className="w-20" inputMode="decimal" value={d.default_lease_hours} onChange={(e) => set({ ...d, default_lease_hours: Number(e.target.value) || 0.5 })} /><span className="text-[12.5px] text-fg-3">小时</span></div></SettingRow>
              <SettingRow title="租约上限" hint="启动与续期都不能超过它"><div className="flex items-center gap-2"><Input className="w-20" inputMode="decimal" value={d.max_lease_hours} onChange={(e) => set({ ...d, max_lease_hours: Number(e.target.value) || 1 })} /><span className="text-[12.5px] text-fg-3">小时</span></div></SettingRow>
            </div>
          </Card>
          <Card>
            <CardHeader title="执行方式" description="部署配置决定（conf/env/*.yaml 的 process_control.backend），这里只读" />
            <div className="px-4 py-3.5 text-[13px] text-fg-2">
              当前：<Badge tone={backend === "off" ? "idle" : "accent"}>{backend === "systemd" ? "systemd 模板单元 agent-svc@<服务:环境:进程>" : backend === "local" ? "本机子进程（开发）" : "关闭"}</Badge>
              <p className="mt-2 text-[12.5px] leading-relaxed text-fg-3">启动时平台写好启动规格，svcrun 在 bwrap 里把该环境的配置文件绑定到服务读的固定路径、遮蔽其他环境的配置，再拉起业务进程——一套部署，按环境起。</p>
            </div>
          </Card>
        </>
      )}
    </SectionPage>
  );
}
