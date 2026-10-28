/**
 * 平台配置四节：环境、通知、记忆、提示词。对所有人生效，每次保存是一个新版本，可对比、可恢复。
 * 每页同一个套路：读当前配置 → 本地草稿 → 底部保存条 → PUT 整节。
 * 页面可以给 validate：有错时保存条上的保存只提示、不提交（错误同时在出错的字段下面标出来）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LuHistory, LuPencilLine, LuPlus, LuRotateCcw, LuSend, LuTrash2 } from "react-icons/lu";

import { api, useMeta, usePromptDefaults, useServices, useSettings, useTasks } from "@/api/hooks";
import type {
  Channel, ConfigSection, ConfigSections, Env, EnvColor, NotificationsConfig, NotifyEvent, NotifyRule, PromptsConfig,
} from "@/api/types";
import { MetaVersion } from "@/components/meta";
import { SaveBar } from "@/components/save-bar";
import { DisabledBadge, EnvBadge } from "@/components/status";
import { VersionHistory } from "@/components/versions";
import { Button } from "@/components/ui/button";
import { Table, Td, Th, Tr } from "@/components/ui/data";
import { Checkbox, Field, Input, Segmented, Select, Switch, TagInput, Textarea } from "@/components/ui/form";
import { Tooltip, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, Empty, ErrorState, Skeleton, SkeletonRows } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { invalidate, useMutation } from "@/lib/query";
import { Link, useLeaveGuard, useSearch } from "@/lib/router";
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
  return { entry, pristine, draft, setDraft, dirty, save, error: data ? undefined : error, refetch, reset: () => pristine && setDraft(structuredClone(pristine)) };
}

/**
 * children 拿到草稿、改草稿的函数、已保存的那份（判断哪些是新加的）。
 * validate 返回第一处错误：有错时点保存只提示、不提交。
 */
function SectionPage<S extends ConfigSection>({ section, title, description, validate, children }: {
  section: S; title: string; description: ReactNode; validate?: (d: ConfigSections[S]) => string | null;
  children: (draft: ConfigSections[S], set: (d: ConfigSections[S]) => void, saved: ConfigSections[S]) => ReactNode;
}) {
  const s = useSection(section);
  /** 看哪一面放在 URL 里（?view=versions）：别处（运行详情的配方）能直接链到某一节的版本，回退也能回来 */
  const [q, setQ] = useSearch<{ view: "edit" | "versions" }>();
  const history = q.view === "versions";
  /** 看版本时保存条收起，草稿还在：离开页面照样要确认（只换 view 不算离开） */
  useLeaveGuard(s.dirty && history);
  const onSave = () => {
    const err = s.draft && validate ? validate(s.draft) : null;
    if (err) toast.error("还有错误没改", err);
    else void s.save.mutate(undefined);
  };
  return (
    <SettingsLayout title={title} description={description}
      meta={s.entry && <MetaVersion version={s.entry.version} by={s.entry.updated_by || "默认"} at={s.entry.updated_at || null} />}
      actions={
        // 位置和文案都固定：选中态表示现在看的是哪一面，不再是一个文案来回变的按钮
        <Segmented value={history ? "versions" : "edit"} onChange={(v) => setQ({ view: v === "versions" ? v : undefined }, false)}
          options={[{ value: "edit", label: "编辑", icon: <LuPencilLine /> }, { value: "versions", label: "版本", icon: <LuHistory /> }]} />
      }>
      {history ? <VersionHistory kind={`settings/${section}`} stats={section === "prompts"} />
        : s.error ? <Card><ErrorState error={s.error} onRetry={s.refetch} /></Card> : !s.draft || !s.pristine ? <Skeleton className="h-80" /> : (
        <div className="space-y-4 pb-20">{children(s.draft, s.setDraft, s.pristine)}</div>
      )}
      <SaveBar visible={s.dirty && !history} saving={s.save.pending} onDiscard={s.reset} onSave={onSave} label={`保存为 v${(s.entry?.version ?? 0) + 1}`} />
    </SettingsLayout>
  );
}

// ———————— 环境 ————————

const COLORS: EnvColor[] = ["red", "amber", "blue", "green", "violet", "gray"];
const COLOR_DOT: Record<EnvColor, string> = { red: "bg-[#ef4444]", amber: "bg-[#f59e0b]", blue: "bg-[#3b82f6]", green: "bg-[#22c55e]", violet: "bg-[#8b5cf6]", gray: "bg-fg-3" };
/** 与后端 domain/platform.ENV_NAME_RE 一致 */
const ENV_NAME_RE = /^[a-z][a-z0-9-]{0,15}$/;

function envNameError(items: Env[], i: number): string | null {
  const name = items[i].name;
  if (!name) return "填一个名字";
  if (!ENV_NAME_RE.test(name)) return "小写字母开头，可含数字和连字符，最多 16 个字符";
  if (items.some((x, j) => j !== i && x.name === name)) return `重名了：已经有 ${name}`;
  return null;
}

export function EnvsSettingsPage() {
  const { data: services, error: servicesError, refetch: refetchServices } = useServices();
  /** 这次新加、还没保存的环境（按对象认）：只有它们的名字能改。保存或放弃后草稿换成新对象，就都不在里面了 */
  const fresh = useRef(new WeakSet<Env>());
  const validate = (d: ConfigSections["envs"]) => {
    for (let i = 0; i < d.items.length; i++) {
      const err = envNameError(d.items, i);
      if (err) return `第 ${i + 1} 个环境的名字：${err}`;
    }
    return d.items.some((e) => e.name === d.default) ? null : "选一个默认环境";
  };
  return (
    <SectionPage section="envs" title="环境" validate={validate}
      description={<>平台有哪些环境（如生产、测试）。某个服务在哪些环境启用，到服务页的「环境」里设置。</>}>
      {(d, set) => {
        const add = () => {
          const row: Env = { name: "", title: "", description: "", protected: false, color: "gray" };
          fresh.current.add(row);
          set({ ...d, items: [...d.items, row] });
        };
        return (
          <>
            <Card>
              <CardHeader title="环境列表" description="已保存的环境不能改名（运行、记忆、服务配置都按名字记）" actions={<Button size="sm" icon={<LuPlus />} onClick={add}>添加环境</Button>} />
              <div className="divide-y divide-line">
                {d.items.map((e, i) => {
                  const isNew = fresh.current.has(e);
                  const patch = (p: Partial<Env>) => {
                    const next = { ...e, ...p };
                    if (isNew) fresh.current.add(next);
                    // 新环境改名时，选它做默认的跟着改
                    const def = p.name !== undefined && d.default === e.name && isNew ? next.name : d.default;
                    set({ ...d, default: def, items: d.items.map((x, j) => (j === i ? next : x)) });
                  };
                  const nameErr = isNew && e.name ? envNameError(d.items, i) : null;
                  /**
                   * 删的只是草稿里的一行，保存前不生效、保存条的「放弃修改」就能撤销：不弹确认。
                   * "还在被引用"留给保存时（服务端会拒并列出用到它的地方）；已保存的环境给一句提示。
                   */
                  const remove = () => {
                    if (!isNew) toast.info(`已删除环境 ${e.name}（未保存）`, "保存后生效；还有服务、任务、通知规则用着它时保存会失败并列出来。点「放弃修改」可以撤销");
                    const rest = d.items.filter((_, j) => j !== i);
                    // 移除的是默认环境：换成一个已保存的环境（没有就第一个有名字的）
                    const def = d.default !== e.name ? d.default
                      : (rest.find((x) => x.name && !fresh.current.has(x)) ?? rest.find((x) => x.name))?.name ?? "";
                    set({ ...d, items: rest, default: def });
                  };
                  return (
                    /* 第一行 名字 / 显示名 / 说明（说明占满剩下的宽度，长说明不被截断），第二行 颜色 / 受保护 / 默认 / 移除 */
                    <div key={i} className="grid gap-3 px-4 py-3.5 md:grid-cols-[130px_160px_1fr]">
                      <Field label="名字" error={nameErr} help={isNew ? "保存后不能改" : undefined}>
                        {isNew
                          ? <Input mono autoFocus={!e.name} value={e.name} placeholder="staging" aria-invalid={!!nameErr} onChange={(ev) => patch({ name: ev.target.value.trim().toLowerCase() })} />
                          : <Tooltip content="已保存的环境不能改名"><span className="block w-full"><Input mono readOnly value={e.name} className="cursor-default bg-sunken text-fg-2" /></span></Tooltip>}
                      </Field>
                      <Field label="显示名"><Input value={e.title} onChange={(ev) => patch({ title: ev.target.value })} /></Field>
                      <Field label="说明"><Input value={e.description} onChange={(ev) => patch({ description: ev.target.value })} /></Field>
                      <div className="flex flex-wrap items-center gap-4 md:col-span-3">
                        <span className="text-[12px] text-fg-3">颜色</span>
                        <div className="flex items-center gap-1">
                          {COLORS.map((c) => (
                            <button key={c} type="button" title={c} aria-label={`颜色 ${c}`} onClick={() => patch({ color: c })}
                              className={cn("size-5 rounded-full ring-offset-2 ring-offset-panel", COLOR_DOT[c], e.color === c && "ring-2 ring-accent")} />
                          ))}
                        </div>
                        <Tooltip content="受保护：agent 看不到项目的真实配置，只能用控制台里填的只读版。不受保护：直接用项目的真实配置。">
                          <span><Switch checked={e.protected} onChange={(v) => patch({ protected: v })} label={<span className="text-[12.5px]">受保护</span>} /></span>
                        </Tooltip>
                        <label className={cn("flex items-center gap-1.5 text-[12.5px] text-fg-2", e.name ? "cursor-pointer" : "opacity-50")}>
                          <input type="radio" disabled={!e.name} checked={!!e.name && d.default === e.name} onChange={() => set({ ...d, default: e.name })} className="accent-[var(--color-accent)]" />默认
                        </label>
                        {isNew && <Badge tone="accent">新加的，未保存</Badge>}
                        <span className="ml-auto" />
                        <Button size="icon-sm" variant="ghost" aria-label={`删除环境 ${e.name || "（未命名）"}`} tip="删除环境"
                          reason={d.items.length <= 1 ? "至少保留一个环境" : undefined} onClick={remove}><LuTrash2 /></Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="space-y-1 border-t border-line px-4 py-2.5 text-[12px] text-fg-3">
                <div><b className="font-medium text-fg-2">受保护</b>（如生产）：agent 看不到真实配置，用控制台里填的只读版（在服务页「配置 → 配置文件」里填）。</div>
                <div><b className="font-medium text-fg-2">不受保护</b>（如测试）：直接用项目的真实配置。请求没指定环境时用「默认」的那个。</div>
              </div>
            </Card>
            <Card>
              <CardHeader title="各服务的启用情况" description="点服务名去服务页修改" />
              {/* 服务列表单独加载：出错、加载中、没有服务都要有交代，不能只剩一个空表头 */}
              {servicesError && !services ? <ErrorState error={servicesError} onRetry={() => void refetchServices()} className="py-8" />
                : !services ? <SkeletonRows rows={3} />
                  : !services.length ? <Empty title="还没有服务" description="新建服务后，这里列出它在每个环境是否启用" className="py-8" /> : (
              <Table>
                {/* 编辑中的环境名可能还是空的或重名：按位置做 key */}
                <thead><tr><Th>服务</Th>{d.items.map((e, i) => <Th key={i} className="text-center">{e.name ? <EnvBadge env={e.name} /> : <span className="text-fg-3">未命名</span>}</Th>)}</tr></thead>
                <tbody>
                  {services.map((s) => (
                    <Tr key={s.name} className={cn(!s.enabled && "opacity-60")}>
                      <Td><Link to={`/services/${s.name}?tab=envs`} className="font-medium text-fg hover:text-accent">{s.name}</Link>{!s.enabled && <DisabledBadge scope="service" className="ml-2" />}</Td>
                      {d.items.map((e, i) => {
                        // 只看该环境自己的开关；服务整体停用在服务名旁边说一次
                        const on = s.envs[e.name]?.enabled !== false;
                        return <Td key={i} className="text-center text-[12.5px]">{on ? <span className="text-ok">启用</span> : <span className="text-fg-3">停用</span>}</Td>;
                      })}
                    </Tr>
                  ))}
                </tbody>
              </Table>
              )}
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
  { value: "feedback_negative", label: "收到负反馈", hint: "有人对运行或某一步点了 👎" },
  { value: "run_queued_long", label: "排队太久", hint: "排了 10 分钟还没开始，多半是负责它的主机没在跑" },
];
/** 运行的触发方式（与后端 domain/runs.TriggerType 一致；续跑沿用原运行的触发方式，不单列） */
const TRIGGERS = ["api", "chat", "schedule", "event", "after", "web", "rerun", "correction", "replay"];
const isHttp = (url: string) => /^https?:\/\//.test(url.trim());

function notificationsError(d: NotificationsConfig): string | null {
  for (const [name, ch] of Object.entries(d.channels)) if (!isHttp(ch.url)) return `渠道 ${name} 的地址要以 http:// 或 https:// 开头`;
  const empty = d.rules.findIndex((r) => !r.events.length);
  if (empty >= 0) return `规则「${d.rules[empty].name || `第 ${empty + 1} 条`}」至少要勾一个事件`;
  return null;
}

export function NotificationsSettingsPage() {
  const { data: services } = useServices();
  const { data: tasks } = useTasks();
  const { data: meta } = useMeta();
  const [testing, setTesting] = useState("");
  /** 这次新加、还没保存的渠道（按对象认）：只有它们能改名。已保存的渠道改名会丢掉口令（服务端按名字找回打码的口令） */
  const fresh = useRef(new WeakSet<Channel>());
  const test = async (name: string) => {
    setTesting(name);
    try { await api.testChannel(name); toast(`已向 ${name} 发送测试消息`); } catch (e) { toast.error("发送失败", (e as Error).message); } finally { setTesting(""); }
  };
  return (
    <SectionPage section="notifications" title="通知" validate={notificationsError}
      description="渠道是消息发到哪（钉钉群或 Webhook），规则决定什么事发到哪个渠道。">
      {(d, set, saved) => {
        const channels = Object.entries(d.channels);
        /** 新增 / 修改 / 改名 / 移除一个渠道，保持原有顺序（否则改一个字它就跳到最后、输入框丢焦点）；改名时引用它的规则跟着改 */
        const setChannel = (name: string, ch: Channel | null, rename?: string) => {
          const old = d.channels[name];
          if (ch && old && ch !== old && fresh.current.has(old)) fresh.current.add(ch);
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
        const addChannel = () => {
          const ch: Channel = { type: "dingtalk", url: "", token: "" };
          fresh.current.add(ch);
          setChannel(freshName(), ch);
        };
        /** 和删环境一样：只改草稿、「放弃修改」能撤销，不弹确认；被任务引用留给保存时报 */
        const removeChannel = (name: string, ch: Channel) => {
          const users = d.rules.filter((r) => r.channel === name).map((r) => `「${r.name || "未命名"}」`);
          if (users.length) { toast.error(`渠道 ${name} 还在用`, `先改掉引用它的规则：${users.join("、")}`); return; }
          if (!fresh.current.has(ch)) toast.info(`已删除渠道 ${name}（未保存）`, "保存后生效；还有任务把结果投递到它时保存会失败并列出来。点「放弃修改」可以撤销");
          setChannel(name, null);
        };
        const setRule = (i: number, r: NotifyRule | null) => set({ ...d, rules: r ? d.rules.map((x, j) => (j === i ? r : x)) : d.rules.filter((_, j) => j !== i) });
        return (
          <>
            <Card>
              <CardHeader title="渠道" description="保存过的渠道不能改名" actions={<Button size="sm" icon={<LuPlus />} onClick={addChannel}>添加渠道</Button>} />
              {!channels.length ? <Empty title="还没有渠道" description="至少建一个 default 渠道，任务的结果投递默认发到它" /> : (
                <div className="divide-y divide-line">
                  {channels.map(([name, ch]) => {
                    const isNew = fresh.current.has(ch);
                    const unsaved = isNew || JSON.stringify(ch) !== JSON.stringify(saved.channels[name]);
                    const urlErr = ch.url && !isHttp(ch.url) ? "要以 http:// 或 https:// 开头" : null;
                    return (
                      // 两行：名字 / 类型 / 地址（地址吃掉剩下的宽度），口令 / 测试 / 移除；一行塞五格时窄屏下地址被挤成一个字宽
                      <div key={name} className="grid items-start gap-3 px-4 py-3.5 md:grid-cols-[150px_120px_minmax(0,1fr)]">
                        <Field label="名字" help={isNew ? "保存后不能改" : undefined}>
                          {isNew
                            ? <Input mono defaultValue={name} onBlur={(e) => renameChannel(e.target, name, ch)} />
                            : <Tooltip content="保存过的渠道不能改名"><span className="block w-full"><Input mono readOnly value={name} className="cursor-default bg-sunken text-fg-2" /></span></Tooltip>}
                        </Field>
                        <Field label="类型"><Select value={ch.type} onChange={(type) => setChannel(name, { ...ch, type })} options={[{ value: "dingtalk", label: "钉钉" }, { value: "webhook", label: "Webhook" }]} /></Field>
                        <Field label={ch.type === "dingtalk" ? "中继地址" : "POST 地址"} error={urlErr}>
                          <Input mono value={ch.url} aria-invalid={!!urlErr} onChange={(e) => setChannel(name, { ...ch, url: e.target.value })} placeholder="https://…" />
                        </Field>
                        <Field className="md:col-span-2" label={ch.type === "dingtalk" ? "机器人 access_token" : "Bearer token（可空）"}><Input mono type="password" value={ch.token} onChange={(e) => setChannel(name, { ...ch, token: e.target.value })} /></Field>
                        <div className="flex justify-end gap-1 md:pt-6">
                          <Button size="sm" icon={<LuSend />} loading={testing === name} reason={unsaved ? "先保存，再测试" : undefined} tip="发一条测试消息" onClick={() => test(name)}>测试</Button>
                          <Button size="icon-sm" variant="ghost" tip="删除渠道" aria-label={`删除渠道 ${name}`} onClick={() => removeChannel(name, ch)}><LuTrash2 /></Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
            <Card>
              <CardHeader title="规则" description="范围不填就是不限；填了几项，要同时满足"
                actions={<Button size="sm" icon={<LuPlus />} reason={!channels.length ? "先添加一个渠道" : undefined} onClick={() => set({ ...d, rules: [...d.rules, { name: "新规则", enabled: true, events: ["run_failed"], services: [], envs: [], tasks: [], triggers: [], channel: channels[0][0] }] })}>添加规则</Button>} />
              {!d.rules.length ? <Empty title="还没有规则" description="没有规则时不发事件通知（任务的结果投递不受影响）" /> : (
                <div className="divide-y divide-line">
                  {d.rules.map((r, i) => (
                    <div key={i} className={cn("space-y-3 px-4 py-4", !r.enabled && "opacity-60")}>
                      <div className="flex flex-wrap items-center gap-3">
                        <Input className="w-56" value={r.name} aria-label="规则名" onChange={(e) => setRule(i, { ...r, name: e.target.value })} />
                        <span className="text-[12.5px] text-fg-3">发到</span>
                        <Select className="w-40" value={r.channel} onChange={(channel) => setRule(i, { ...r, channel })} options={channels.map(([n, c]) => ({ value: n, label: n, hint: c.type === "dingtalk" ? "钉钉" : "Webhook" }))} />
                        <div className="ml-auto flex items-center gap-2">
                          <Switch checked={r.enabled} onChange={(enabled) => setRule(i, { ...r, enabled })} size="sm" label={<span className="text-[12px] text-fg-3">{r.enabled ? "启用" : "已停用"}</span>} />
                          <Button size="icon-sm" variant="ghost" tip="删除规则" aria-label={`删除规则 ${r.name}`} onClick={() => setRule(i, null)}><LuTrash2 /></Button>
                        </div>
                      </div>
                      <div>
                        <div className="flex flex-wrap gap-x-5 gap-y-1">
                          {EVENTS.map((ev) => (
                            <Checkbox key={ev.value} checked={r.events.includes(ev.value)} label={ev.label} hint={ev.hint || undefined}
                              onChange={(on) => setRule(i, { ...r, events: on ? [...r.events, ev.value] : r.events.filter((x) => x !== ev.value) })} />
                          ))}
                        </div>
                        {!r.events.length && <div className="mt-1 text-xs text-bad">至少勾一个事件，否则这条规则什么都不会发</div>}
                      </div>
                      <div className="grid gap-3 md:grid-cols-4">
                        <Field label="服务"><TagInput mono value={r.services} onChange={(services) => setRule(i, { ...r, services })} suggestions={(services ?? []).map((s) => s.name)} /></Field>
                        <Field label="环境"><TagInput mono value={r.envs} onChange={(envs) => setRule(i, { ...r, envs })} suggestions={(meta?.envs ?? []).map((e) => e.name)} /></Field>
                        <Field label="任务" help="写父任务就包括它的子任务"><TagInput mono value={r.tasks} onChange={(t) => setRule(i, { ...r, tasks: t })} suggestions={(tasks ?? []).filter((t) => !t.extends).map((t) => t.name)} /></Field>
                        <Field label="触发方式" help="web = 控制台里手动运行，rerun = 重跑，correction = 纠正，replay = 回归重放">
                          <TagInput mono value={r.triggers} onChange={(triggers) => setRule(i, { ...r, triggers })} suggestions={TRIGGERS} />
                        </Field>
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

/** 与后端 MemoryConfig 一致：0~20 的整数 */
const clampLimit = (v: string) => Math.max(0, Math.min(20, Math.floor(Number(v)) || 0));

export function MemorySettingsPage() {
  return (
    <SectionPage section="memory" title="记忆" description="运行前带上哪些记忆、运行后记下什么的默认做法；任务可以单独改。">
      {(d, set) => (
        <Card>
          <div className="divide-y divide-line">
            <SettingRow title="召回" hint="运行前找出相关的记忆和方法，一起交给 agent"><Switch checked={d.recall} onChange={(recall) => set({ ...d, recall })} /></SettingRow>
            <SettingRow title="沉淀" hint="运行结束后自动记下以后用得上的事实和报错教训"><Switch checked={d.save} onChange={(save) => set({ ...d, save })} /></SettingRow>
            <SettingRow title="会话交接摘要" hint="同一会话每轮结束写一份交接摘要，下次同类问题直接接着用"><Switch checked={d.handoff_summary} onChange={(handoff_summary) => set({ ...d, handoff_summary })} /></SettingRow>
            <SettingRow title="每次最多召回记忆" hint="条（0~20），事实和教训合计">
              <Input className="w-20" type="number" min={0} max={20} step={1} inputMode="numeric" aria-label="每次最多召回记忆"
                value={d.knowledge_limit} onChange={(e) => set({ ...d, knowledge_limit: clampLimit(e.target.value) })} />
            </SettingRow>
            <SettingRow title="每次最多带上方法" hint="条（0~20），本任务的方法优先">
              <Input className="w-20" type="number" min={0} max={20} step={1} inputMode="numeric" aria-label="每次最多带上方法"
                value={d.asset_limit} onChange={(e) => set({ ...d, asset_limit: clampLimit(e.target.value) })} />
            </SettingRow>
          </div>
        </Card>
      )}
    </SectionPage>
  );
}

// ———————— 提示词 ————————

const PROMPTS: { key: keyof PromptsConfig; label: string; hint: string; rows: number }[] = [
  { key: "base", label: "平台基础约定", hint: "每个 agent 的系统提示开头，后面接角色提示词", rows: 14 },
  { key: "subagent", label: "子代理约定", hint: "每个子代理的系统提示开头，后面接它的角色提示词", rows: 6 },
  { key: "compaction", label: "上下文压缩", hint: "对话太长时压缩成摘要。占位：{messages}（必须有）", rows: 12 },
  { key: "distill", label: "记忆沉淀", hint: "运行后提炼事实和教训。占位：{service} {env} {task} {input} {output}", rows: 14 },
  { key: "handoff_summary", label: "交接摘要", hint: "会话每轮结束写交接摘要。占位：{task} {input} {output}", rows: 12 },
  { key: "replay_judge", label: "回归判定", hint: "判断重跑的新答案改好没有。占位：{task} {where} {input} {old} {issues} {new}", rows: 14 },
];

/** 模板段 → 可用占位（与后端 domain/prompts.PLACEHOLDERS 一致） */
const PLACEHOLDERS: Partial<Record<keyof PromptsConfig, string[]>> = {
  compaction: ["messages"], distill: ["service", "env", "task", "input", "output"],
  handoff_summary: ["task", "input", "output"], replay_judge: ["task", "where", "input", "old", "issues", "new"],
};

/** 和后端用 Python str.format 校验的结果一致：{{ }} 是普通花括号，{名字} 是占位，落单的花括号不行 */
export function promptError(key: keyof PromptsConfig, text: string): string | null {
  if (key === "base" || key === "subagent") return text.trim() ? null : "不能为空";
  const keys = PLACEHOLDERS[key];
  if (!keys) return null;
  const known = `可用：${keys.map((k) => `{${k}}`).join(" ")}；普通的花括号要写成 {{ }}`;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "}") {
      if (text[i + 1] === "}") { i++; continue; }
      return `有落单的 }（${known}）`;
    }
    if (c !== "{") continue;
    if (text[i + 1] === "{") { i++; continue; }
    const end = text.indexOf("}", i);
    if (end < 0) return `有落单的 {（${known}）`;
    const name = text.slice(i + 1, end).split(/[!:]/)[0].split(/[.[]/)[0];
    if (!keys.includes(name)) return `占位 {${text.slice(i + 1, end)}} 不认识（${known}）`;
    i = end;
  }
  if (key === "compaction" && !text.includes("{messages}")) return "必须包含 {messages}（要压缩的历史放在这里）";
  return null;
}

export function PromptsSettingsPage() {
  const { data: defaults } = usePromptDefaults();
  const validate = (d: PromptsConfig) => {
    for (const p of PROMPTS) { const err = promptError(p.key, d[p.key]); if (err) return `${p.label}：${err}`; }
    return null;
  };
  return (
    <SectionPage section="prompts" title="提示词" validate={validate}
      description="所有角色共用的系统提示开头，以及平台自己用的几段提示词。改了下次运行就生效，「版本」里能看每版的效果。">
      {(d, set) => {
        const field = (p: (typeof PROMPTS)[number]) => {
          const err = promptError(p.key, d[p.key]);
          const isDefault = !!defaults && d[p.key] === defaults[p.key];
          return (
            <Field key={p.key} label={p.label} help={p.hint} error={err}
              aside={<Button size="xs" variant="ghost" icon={<LuRotateCcw />} disabled={!defaults} reason={isDefault ? "已经是默认内容" : undefined}
                tip="换回平台内置的默认内容（保存后生效）" onClick={() => defaults && set({ ...d, [p.key]: defaults[p.key] })}>恢复默认</Button>}>
              <Textarea mono rows={p.rows} value={d[p.key]} aria-invalid={!!err} onChange={(e) => set({ ...d, [p.key]: e.target.value })} />
            </Field>
          );
        };
        return (
          <>
            <Card>
              <CardHeader title="系统提示" description="接在角色提示词前面的平台约定" />
              <div className="space-y-4 p-4">{PROMPTS.slice(0, 2).map(field)}</div>
            </Card>
            <Card>
              <CardHeader title="平台自己用的提示词" description={<>带 {"{占位}"} 的会换成实际内容；普通的花括号要写成 <code className="font-mono">{"{{ }}"}</code></>} />
              <div className="space-y-4 p-4">{PROMPTS.slice(2).map(field)}</div>
            </Card>
          </>
        );
      }}
    </SectionPage>
  );
}
