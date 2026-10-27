/**
 * 平台配置四节：环境、通知、记忆、提示词。对所有人生效，每次保存是一个新版本，可对比、可恢复。
 * 每页同一个套路：读当前配置 → 本地草稿 → 底部保存条 → PUT 整节。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LuHistory, LuPlus, LuSend, LuTrash2 } from "react-icons/lu";

import { api, useMeta, useServices, useSettings, useTasks } from "@/api/hooks";
import type {
  Channel, ConfigSection, ConfigSections, EnvColor, NotifyEvent, NotifyRule, PromptsConfig,
} from "@/api/types";
import { SaveBar } from "@/components/save-bar";
import { EnvBadge } from "@/components/status";
import { VersionHistory } from "@/components/versions";
import { Button } from "@/components/ui/button";
import { Table, Td, Th, Tr } from "@/components/ui/data";
import { Checkbox, Field, Input, Select, Switch, TagInput, Textarea } from "@/components/ui/form";
import { Tooltip, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, Empty, ErrorState, Skeleton } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { ago, datetime } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { Link, useLeaveGuard } from "@/lib/router";
import { SettingRow, SettingsLayout } from "./layout";

// ———————— 共用：一节配置的草稿与保存 ————————

const LEDGER = ["section", "version", "updated_by", "updated_at"];

function useSection<S extends ConfigSection>(section: S) {
  const { data, error, refetch } = useSettings();
  const entry = data?.[section];
  const [draft, setDraft] = useState<ConfigSections[S] | null>(null);
  const pristine = useMemo(() => (entry ? Object.fromEntries(Object.entries(entry).filter(([k]) => !LEDGER.includes(k))) as ConfigSections[S] : null), [entry]);
  /** 后台重新拉到配置（回到窗口时会刷新）：没改过、或版本变了（保存 / 恢复）才换成新内容，正在编辑的草稿不丢 */
  const seen = useRef<{ version: number; json: string } | null>(null);
  useEffect(() => {
    if (!entry || !pristine) return;
    const prev = seen.current;
    seen.current = { version: entry.version, json: JSON.stringify(pristine) };
    setDraft((cur) => (!cur || !prev || prev.version !== entry.version || JSON.stringify(cur) === prev.json ? structuredClone(pristine) : cur));
  }, [entry, pristine]);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(pristine);
  const save = useMutation(async () => {
    if (!draft) return;
    try {
      const saved = await api.putSettings(section, draft);
      toast(`已保存为 v${saved.version}`, { description: "立即对所有人生效" });
      invalidate("settings");
      invalidate("versions");
      if (section === "envs" || section === "notifications") invalidate("meta");
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  });
  return { entry, draft, setDraft, dirty, save, error: data ? undefined : error, refetch, reset: () => pristine && setDraft(structuredClone(pristine)) };
}

function SectionPage<S extends ConfigSection>({ section, title, description, children }: {
  section: S; title: string; description: ReactNode;
  children: (draft: ConfigSections[S], set: (d: ConfigSections[S]) => void) => ReactNode;
}) {
  const s = useSection(section);
  const [history, setHistory] = useState(false);
  /** 看版本时保存条收起，草稿还在：离开页面照样要确认 */
  useLeaveGuard(s.dirty && history);
  return (
    <SettingsLayout title={title} description={description}
      actions={<>
        {s.entry && <span className="text-[12px] text-fg-3" title={s.entry.updated_at ? datetime(s.entry.updated_at, true) : undefined}>v{s.entry.version} · {s.entry.updated_by || "默认"}{s.entry.updated_at ? ` · ${ago(s.entry.updated_at)}` : ""}</span>}
        <Button icon={<LuHistory />} variant={history ? "secondary" : "ghost"} onClick={() => setHistory(!history)}>{history ? "返回编辑" : "版本"}</Button>
      </>}>
      {history ? <VersionHistory kind={`settings/${section}`} stats={section === "prompts"} />
        : s.error ? <Card><ErrorState error={s.error} onRetry={s.refetch} /></Card> : !s.draft ? <Skeleton className="h-80" /> : (
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
    <SectionPage section="envs" title="环境" description={<>平台可操作的业务环境。每个运行请求都带环境（不带就用默认环境）；运行与方法按它分区，记忆可以只对某个环境成立，也可以对所有环境成立。<b className="font-medium text-fg-2">某个服务在某个环境是否启用</b>，在服务页的「环境」里设置。</>}>
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
                      <Tooltip content="受保护：agent 看不到项目的真实配置，用控制台填的只读版（只读账号），bash 里遮蔽。不受保护：直接用项目的真实配置，文件只读，提示词要求库只读。都不拦任何操作">
                        <span><Switch checked={e.protected} onChange={(v) => patch({ protected: v })} label={<span className="text-[12.5px]">受保护</span>} /></span>
                      </Tooltip>
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
            <div className="space-y-1 border-t border-line px-4 py-2.5 text-[12px] text-fg-3">
              <div><b className="font-medium text-fg-2">受保护</b>（如生产）：agent 看不到项目的真实配置，用控制台填的只读版（只读账号，在服务页「配置 → 配置文件」里填），bash 里遮蔽。</div>
              <div><b className="font-medium text-fg-2">不受保护</b>（如测试）：直接用项目的真实配置，文件只读，提示词要求库只读；受保护环境的配置照样遮蔽。</div>
              <div>两种都不拦任何操作；受保护的环境徽标带盾牌、运行任务时提醒一句。请求不带环境时用「默认」的那个。</div>
            </div>
          </Card>
          <Card>
            <CardHeader title="各服务的启用情况" description="点服务名去服务页修改（服务 → 环境 → 启用）" />
            <Table>
              {/* 编辑中的环境名可能还是空的或重名：按位置做 key */}
              <thead><tr><Th>服务</Th>{d.items.map((e, i) => <Th key={i} className="text-center"><EnvBadge env={e.name} /></Th>)}</tr></thead>
              <tbody>
                {(services ?? []).map((s) => (
                  <Tr key={s.name}>
                    <Td><Link to={`/services/${s.name}?tab=envs`} className="font-medium text-fg hover:text-accent">{s.name}</Link>{!s.enabled && <Badge tone="idle" className="ml-2">服务已停用</Badge>}</Td>
                    {d.items.map((e, i) => {
                      const on = s.enabled && s.envs[e.name]?.enabled !== false;
                      return <Td key={i} className="text-center">{on ? <span className="text-ok">●</span> : <span className="text-fg-3">○</span>}</Td>;
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

// ———————— 通知 ————————

const EVENTS: { value: NotifyEvent; label: string; hint: string }[] = [
  { value: "run_failed", label: "运行失败", hint: "" },
  { value: "run_succeeded", label: "运行成功", hint: "量大，建议加范围" },
  { value: "feedback_negative", label: "收到负反馈", hint: "有人对运行或某一步点了 👎，带问题类型与说明" },
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
        /** 新增 / 修改 / 改名 / 移除一个渠道，保持原有顺序（否则改一个字它就跳到最后、输入框丢焦点）；改名时引用它的规则跟着改 */
        const setChannel = (name: string, ch: Channel | null, rename?: string) => {
          const next: Record<string, Channel> = Object.fromEntries(name in d.channels
            ? channels.flatMap(([n, c]): [string, Channel][] => (n !== name ? [[n, c]] : ch ? [[rename ?? name, ch]] : []))
            : ch ? [...channels, [name, ch]] : channels);
          set({ ...d, channels: next, rules: rename ? d.rules.map((r) => (r.channel === name ? { ...r, channel: rename } : r)) : d.rules });
        };
        const renameChannel = (input: HTMLInputElement, name: string, ch: Channel) => {
          const v = input.value.trim();
          if (v && v !== name && v in d.channels) toast.error(`已有名为 ${v} 的渠道`);
          if (!v || v === name || v in d.channels) { input.value = name; return; }
          setChannel(name, ch, v);
        };
        const freshName = () => { let i = channels.length + 1; while (`channel-${i}` in d.channels) i++; return `channel-${i}`; };
        const setRule = (i: number, r: NotifyRule | null) => set({ ...d, rules: r ? d.rules.map((x, j) => (j === i ? r : x)) : d.rules.filter((_, j) => j !== i) });
        return (
          <>
            <Card>
              <CardHeader title="渠道" actions={<Button size="sm" icon={<LuPlus />} onClick={() => setChannel(freshName(), { type: "dingtalk", url: "", token: "" })}>添加渠道</Button>} />
              {!channels.length ? <Empty title="还没有渠道" description="至少建一个 default 渠道，任务的结果投递默认发到它" /> : (
                <div className="divide-y divide-line">
                  {channels.map(([name, ch]) => (
                    <div key={name} className="grid items-end gap-3 px-4 py-3.5 md:grid-cols-[150px_120px_1fr_180px_auto]">
                      <Field label="名字"><Input mono defaultValue={name} onBlur={(e) => renameChannel(e.target, name, ch)} /></Field>
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
                          <Switch checked={r.enabled} onChange={(enabled) => setRule(i, { ...r, enabled })} size="sm" label={<span className="text-[12px] text-fg-3">{r.enabled ? "启用" : "已关闭"}</span>} />
                          <Button size="icon-sm" variant="ghost" aria-label={`删除规则 ${r.name}`} onClick={() => setRule(i, null)}><LuTrash2 /></Button>
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
    <SectionPage section="memory" title="记忆" description="运行前召回什么、运行后沉淀什么的平台默认。任务可以单独覆盖（任务 → 定义 → 记忆），单次请求也可以再覆盖（请求 > 任务 > 这里）。">
      {(d, set) => (
        <Card>
          <div className="divide-y divide-line">
            <SettingRow title="召回" hint="运行前按问题检索记忆（事实、同类报错的教训）与方法，拼进提示"><Switch checked={d.recall} onChange={(recall) => set({ ...d, recall })} /></SettingRow>
            <SettingRow title="沉淀" hint="运行结束后用一次轻量模型调用提炼可复用的事实与报错教训"><Switch checked={d.save} onChange={(save) => set({ ...d, save })} /></SettingRow>
            <SettingRow title="会话交接摘要" hint="同一会话里，每轮结束写「结论 / 被否方案 / 当前约束 / 未决问题」，下一个同类会话召回置顶"><Switch checked={d.handoff_summary} onChange={(handoff_summary) => set({ ...d, handoff_summary })} /></SettingRow>
            <SettingRow title="每次最多召回记忆" hint="条（0~20）；事实与教训合计"><Input className="w-20" inputMode="numeric" value={d.knowledge_limit} onChange={(e) => set({ ...d, knowledge_limit: Math.min(20, Number(e.target.value) || 0) })} /></SettingRow>
            <SettingRow title="每次最多注入方法" hint="条（0~20）；本任务的方法优先，其次服务通用"><Input className="w-20" inputMode="numeric" value={d.asset_limit} onChange={(e) => set({ ...d, asset_limit: Math.min(20, Number(e.target.value) || 0) })} /></SettingRow>
          </div>
        </Card>
      )}
    </SectionPage>
  );
}

// ———————— 提示词 ————————

const PROMPTS: { key: keyof PromptsConfig; label: string; hint: string; rows: number }[] = [
  { key: "base", label: "平台基础约定", hint: "每个主 agent 的系统提示开头，后面接角色提示词", rows: 14 },
  { key: "subagent", label: "子代理约定", hint: "每个子代理的系统提示开头，后面接子代理角色的提示词", rows: 6 },
  { key: "compaction", label: "上下文压缩", hint: "对话历史太长时压缩成摘要。占位：{messages}（必须有）", rows: 12 },
  { key: "distill", label: "记忆沉淀", hint: "运行后提炼事实与教训。占位：{service} {env} {task} {input} {output}", rows: 14 },
  { key: "handoff_summary", label: "交接摘要", hint: "会话每轮结束写交接摘要。占位：{task} {input} {output}", rows: 12 },
  { key: "replay_judge", label: "回归判定", hint: "回归重放判定新答案改好没有。占位：{task} {where} {input} {old} {issues} {new}", rows: 14 },
];

export function PromptsSettingsPage() {
  return (
    <SectionPage section="prompts" title="提示词" description={<>所有角色共用的系统提示开头，以及平台自己发起的辅助模型调用。改了下一次运行就用新的；每次运行的配方里记着用的是第几版，「版本」里能看每版跑出来的效果。带占位的几段是模板，字面花括号写成 <code className="font-mono">{"{{ }}"}</code>，保存时校验。</>}>
      {(d, set) => {
        const field = (p: (typeof PROMPTS)[number]) => (
          <Field key={p.key} label={p.label} help={p.hint}>
            <Textarea mono rows={p.rows} value={d[p.key]} onChange={(e) => set({ ...d, [p.key]: e.target.value })} />
          </Field>
        );
        return (
          <>
            <Card>
              <CardHeader title="系统提示" description="接在角色提示词之前的平台约定" />
              <div className="space-y-4 p-4">{PROMPTS.slice(0, 2).map(field)}</div>
            </Card>
            <Card>
              <CardHeader title="辅助模型调用" description="平台自己发起的模型调用；沉淀、交接、判定在运行的时间线里标着用途" />
              <div className="space-y-4 p-4">{PROMPTS.slice(2).map(field)}</div>
            </Card>
          </>
        );
      }}
    </SectionPage>
  );
}
