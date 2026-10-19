/**
 * 任务定义编辑器：基本 / 输入 / 触发 / 输出与去重 / 环境 / 档案 / 高级（任务图、处理器）。
 * 分节表单 + 本地草稿 + 未保存提示条。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LuCalendarClock, LuCode, LuFileInput, LuLayers, LuMessageSquare, LuPlus, LuScrollText, LuSend, LuSettings, LuTrash2,
  LuWebhook, LuWorkflow, LuZap,
} from "react-icons/lu";

import { api, useEnvs, useMeta, useRoles, useServices } from "@/api/hooks";
import type { InputField, Task, TaskSummary, Trigger, TriggerRule } from "@/api/types";
import { EnvBadge, TRIGGER } from "@/components/status";
import { Button } from "@/components/ui/button";
import { KeyValueEditor } from "@/components/ui/data";
import { Checkbox, Field, Input, Segmented, Select, Switch, Textarea } from "@/components/ui/form";
import { Menu, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader } from "@/components/ui/primitives";
import { describeCron, nextRuns, validateCron } from "@/lib/cron";
import { cn } from "@/lib/cn";
import { dayjs } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";

type Draft = Pick<Task, "title" | "description" | "service" | "role" | "form" | "input" | "envs" | "triggers" | "output" | "dedup" | "timeout_s" | "context" | "graph" | "handler">;

const toDraft = (t: TaskSummary): Draft => structuredClone({
  title: t.title, description: t.description, service: t.service, role: t.role, form: t.form, input: t.input, envs: t.envs,
  triggers: t.triggers, output: t.output, dedup: t.dedup, timeout_s: t.timeout_s, context: t.context, graph: t.graph ?? null, handler: t.handler ?? null,
});

function Section({ id, icon, title, description, children, actions }: { id: string; icon: ReactNode; title: string; description: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-4">
      <CardHeader icon={icon} title={title} description={description} actions={actions} />
      <div className="p-4">{children}</div>
    </Card>
  );
}

export function TaskDefinitionEditor({ task, onSaved }: { task: TaskSummary; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(() => toDraft(task));
  useEffect(() => setD(toDraft(task)), [task.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: roles } = useRoles();
  const { data: services } = useServices();
  const { data: envs } = useEnvs();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((s) => ({ ...s, [k]: v }));
  const dirty = useMemo(() => JSON.stringify(d) !== JSON.stringify(toDraft(task)), [d, task]);
  const [graphText, setGraphText] = useState(() => JSON.stringify(task.graph ?? {}, null, 2));
  const graphError = useMemo(() => { if (d.form !== "graph") return null; try { JSON.parse(graphText); return null; } catch (e) { return (e as Error).message; } }, [graphText, d.form]);
  const cronErrors = d.triggers.some((t) => t.type === "schedule" && validateCron(t.cron));

  const save = useMutation(async () => {
    try {
      const body = { ...d, graph: d.form === "graph" ? JSON.parse(graphText) : null };
      const r = await api.putTask(task.name, body);
      toast(`已保存为 v${r.version}`, { description: "定时触发已重新同步" });
      invalidate("tasks");
      onSaved();
    } catch (e) {
      toast.error("保存失败", (e as Error).message);
    }
  });

  const enabledEnvs = (envs ?? []).filter((e) => e.enabled);
  const nav = [["basic", "基本"], ["input", "输入"], ["triggers", "触发"], ["output", "输出与去重"], ["envs", "环境"], ["context", "任务档案"], ...(d.form !== "agent" ? [["advanced", d.form === "graph" ? "任务图" : "处理器"]] : [])];

  return (
    <div className="grid gap-5 lg:grid-cols-[160px_1fr]">
      <nav className="sticky top-4 hidden h-fit space-y-0.5 text-[12.5px] lg:block">
        {nav.map(([id, label]) => (
          <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }); }}
            className="block rounded-md px-2.5 py-1.5 text-fg-2 hover:bg-hover hover:text-fg">{label}</a>
        ))}
      </nav>
      <div className="min-w-0 space-y-4 pb-20">
        <Section id="basic" icon={<LuSettings />} title="基本" description="角色决定能力边界（系统提示 + 工具白名单），任务只描述目标">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="显示名"><Input value={d.title} onChange={(e) => set("title", e.target.value)} /></Field>
            <Field label="归属">
              <Select value={d.service ?? "_platform"} onChange={(v) => set("service", v === "_platform" ? null : v)} options={[
                ...(services ?? []).map((s) => ({ value: s.name, label: s.title, hint: "专属 · " + s.name })),
                { value: "*", label: "通用任务", hint: "调用时指定服务" }, { value: "_platform", label: "平台任务", hint: "不涉及业务服务" },
              ]} />
            </Field>
            <Field label="说明" className="md:col-span-2" help="会进入 agent 的任务说明"><Textarea rows={2} value={d.description} onChange={(e) => set("description", e.target.value)} /></Field>
            <Field label="形态">
              <Segmented value={d.form} onChange={(v) => set("form", v)} options={[{ value: "agent", label: "单角色" }, { value: "graph", label: "任务图", icon: <LuWorkflow /> }, { value: "builtin", label: "内建" }]} />
            </Field>
            {d.form !== "builtin" && (
              <Field label="执行角色">
                <Select value={d.role ?? null} onChange={(v) => set("role", v)} placeholder="选择角色" options={(roles ?? []).map((r) => ({ value: r.name, label: r.title || r.name, hint: r.tools.join("、") }))} />
              </Field>
            )}
          </div>
        </Section>

        <Section id="input" icon={<LuFileInput />} title="输入" description="字段定义：页面据此生成运行表单，API 据此校验；事件触发通过字段映射填充">
          <InputSchemaEditor value={d.input} onChange={(v) => set("input", v)} />
        </Section>

        <Section id="triggers" icon={<LuZap />} title="触发" description="平台不写死「哪个 webhook 跑哪个任务」——这里声明的就是全部入口"
          actions={<AddTriggerMenu onAdd={(t) => set("triggers", [...d.triggers, t])} existing={d.triggers} />}>
          <div className="space-y-3">
            {d.triggers.length === 0 && <div className="rounded-md border border-dashed border-line px-3 py-6 text-center text-xs text-fg-3">没有触发器：只能从网页手动运行</div>}
            {d.triggers.map((tr, i) => (
              <TriggerEditor key={tr.id} tr={tr} envs={enabledEnvs.map((e) => e.name)} input={d.input}
                onChange={(v) => set("triggers", d.triggers.map((x, j) => (j === i ? v : x)))}
                onRemove={() => set("triggers", d.triggers.filter((_, j) => j !== i))} />
            ))}
          </div>
        </Section>

        <Section id="output" icon={<LuSend />} title="输出与去重" description="结果投递失败只留事件，不改变 run 的状态（结果已在台账里）">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="结果投递">
              <Segmented value={d.output.channel} onChange={(v) => set("output", { ...d.output, channel: v })} options={[{ value: "caller", label: "调用方自取" }, { value: "dingtalk", label: "钉钉" }, { value: "http", label: "HTTP 回调" }]} />
            </Field>
            {d.output.channel === "http" && (
              <Field label="回调地址" help="POST {run_id, task, status, output}"><Input mono value={d.output.callback ?? ""} onChange={(e) => set("output", { ...d.output, callback: e.target.value })} placeholder="http://…" /></Field>
            )}
            <Field label="超时（秒）" help="单次执行上限，最长 7200"><Input inputMode="numeric" value={d.timeout_s} onChange={(e) => set("timeout_s", Math.min(7200, Number(e.target.value.replace(/\D/g, "")) || 0))} /></Field>
            <Field label="去重" help="时间窗内同键的成功运行直接复用结果；a+b 拼接多个字段" className="md:col-span-2">
              <div className="flex items-center gap-3">
                <Switch checked={!!d.dedup} onChange={(v) => set("dedup", v ? { key: Object.keys(d.input)[0] ?? "", window_s: 600 } : null)} />
                {d.dedup && <>
                  <Input mono className="w-56" value={d.dedup.key} onChange={(e) => set("dedup", { ...d.dedup!, key: e.target.value })} placeholder="run_id" />
                  <span className="text-xs text-fg-3">窗口</span>
                  <Input className="w-24" inputMode="numeric" value={Math.round(d.dedup.window_s / 60)} onChange={(e) => set("dedup", { ...d.dedup!, window_s: (Number(e.target.value) || 1) * 60 })} />
                  <span className="text-xs text-fg-3">分钟</span>
                </>}
              </div>
            </Field>
          </div>
        </Section>

        <Section id="envs" icon={<LuLayers />} title="环境" description="限定这个任务能跑在哪些环境；不选 = 全部。提交到其他环境会被拒（env_not_allowed）">
          <div className="flex flex-wrap gap-4">
            {enabledEnvs.map((e) => (
              <Checkbox key={e.name} checked={d.envs.includes(e.name)} onChange={(v) => set("envs", v ? [...d.envs, e.name] : d.envs.filter((x) => x !== e.name))}
                label={<span className="flex items-center gap-1.5"><EnvBadge env={e.name} />{e.title}</span>} hint={e.protected ? "受保护" : undefined} />
            ))}
          </div>
        </Section>

        <Section id="context" icon={<LuScrollText />} title="任务档案" description="置顶逐字注入该任务的 run（子任务按键合并）。只写代码和配置里读不出来的东西。">
          <KeyValueEditor value={d.context} onChange={(v) => set("context", v)} suggestions={[{ key: "pitfalls", label: "常见坑" }, { key: "code_refs", label: "代码位置" }, { key: "upstream", label: "上游依赖" }, { key: "runbook", label: "运维备注" }]} />
        </Section>

        {d.form === "graph" && (
          <Section id="advanced" icon={<LuWorkflow />} title="任务图" description="节点是产物、边是依赖；每个节点恰好一种物化方式：code / agent / route，可加 map（扇出）与 gate（审批）">
            <Field error={graphError}>
              <Textarea mono rows={16} value={graphText} onChange={(e) => setGraphText(e.target.value)} aria-invalid={!!graphError} />
            </Field>
          </Section>
        )}
        {d.form === "builtin" && (
          <Section id="advanced" icon={<LuCode />} title="内建处理器" description="不过模型的确定性作业，处理器在内核代码里登记">
            <Field label="处理器名"><Input mono value={d.handler ?? ""} onChange={(e) => set("handler", e.target.value)} placeholder="memory-gardener" /></Field>
          </Section>
        )}
      </div>

      {dirty && (
        <div className="fixed inset-x-0 bottom-5 z-40 flex justify-center">
          <div className="flex animate-pop items-center gap-3 rounded-xl border border-line bg-raised py-2 pl-4 pr-2 shadow-[var(--shadow-pop)]">
            <span className="size-2 rounded-full bg-warn" />
            <span className="text-[13px] text-fg">有未保存的修改</span>
            <Button size="sm" variant="ghost" onClick={() => { setD(toDraft(task)); setGraphText(JSON.stringify(task.graph ?? {}, null, 2)); }}>放弃</Button>
            <Button size="sm" variant="primary" disabled={!!graphError || cronErrors} loading={save.pending} onClick={() => save.mutate(undefined)}>保存为 v{task.version + 1}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ———————— 输入 schema ————————

function InputSchemaEditor({ value, onChange }: { value: Record<string, InputField>; onChange: (v: Record<string, InputField>) => void }) {
  const entries = Object.entries(value);
  const update = (i: number, name: string, f: InputField) => onChange(Object.fromEntries(entries.map(([k, v], j) => (j === i ? [name, f] : [k, v]))));
  return (
    <div className="space-y-2">
      {entries.length > 0 && (
        <div className="grid grid-cols-[160px_110px_70px_1fr_32px] gap-2 px-0.5 text-[11.5px] text-fg-3"><span>字段</span><span>类型</span><span>必填</span><span>说明</span><span /></div>
      )}
      {entries.map(([k, f], i) => (
        <div key={i} className="grid grid-cols-[160px_110px_70px_1fr_32px] items-start gap-2">
          <Input mono value={k} onChange={(e) => update(i, e.target.value.replace(/\s/g, ""), f)} />
          <Select size="md" value={f.type} onChange={(t) => update(i, k, { ...f, type: t as InputField["type"] })} options={[
            { value: "str", label: "文本" }, { value: "text", label: "长文本" }, { value: "int", label: "整数" }, { value: "bool", label: "开关" }, { value: "enum", label: "枚举" }, { value: "json", label: "JSON" },
          ]} />
          <div className="flex h-8 items-center"><Switch size="sm" checked={!!f.required} onChange={(v) => update(i, k, { ...f, required: v })} /></div>
          <div className="space-y-1.5">
            <Input value={f.description ?? ""} onChange={(e) => update(i, k, { ...f, description: e.target.value })} placeholder="给调用方看的说明" />
            {f.type === "enum" && <Input mono value={(f.options ?? []).join(",")} onChange={(e) => update(i, k, { ...f, options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="选项，逗号分隔" />}
          </div>
          <Button size="icon-sm" variant="ghost" onClick={() => onChange(Object.fromEntries(entries.filter((_, j) => j !== i)))}><LuTrash2 /></Button>
        </div>
      ))}
      <Button size="xs" icon={<LuPlus />} onClick={() => { let n = "field"; let j = 1; while (n in value) n = `field${++j}`; onChange({ ...value, [n]: { type: "str" } }); }}>添加字段</Button>
    </div>
  );
}

// ———————— 触发器 ————————

const newId = (type: string, existing: Trigger[]) => { let n = type; let i = 1; while (existing.some((t) => t.id === n)) n = `${type}-${++i}`; return n; };

function AddTriggerMenu({ onAdd, existing }: { onAdd: (t: Trigger) => void; existing: Trigger[] }) {
  const { data: meta } = useMeta();
  const has = (t: string) => existing.some((x) => x.type === t);
  return (
    <Menu trigger={<Button size="sm" icon={<LuPlus />}>添加触发</Button>} items={[
      { label: "API 调用", icon: <LuCode />, disabled: has("api"), hint: has("api") ? "已有" : undefined, onClick: () => onAdd({ id: "api", type: "api" }) },
      { label: "对话", icon: <LuMessageSquare />, disabled: has("chat"), hint: has("chat") ? "已有" : undefined, onClick: () => onAdd({ id: "chat", type: "chat" }) },
      { label: "定时", icon: <LuCalendarClock />, onClick: () => onAdd({ id: newId("schedule", existing), type: "schedule", cron: "0 9 * * *", envs: ["test"], input: {} }) },
      { separator: true, label: "" },
      ...(meta?.event_sources ?? []).flatMap((s) => s.events.map((ev) => ({
        label: `${s.title} · ${ev.title}`, icon: <LuWebhook />, onClick: () => onAdd({ id: newId(s.name, existing), type: "event" as const, source: s.name, event: ev.name, map: {}, rules: [] }),
      }))),
    ]} />
  );
}

function TriggerEditor({ tr, envs, input, onChange, onRemove }: { tr: Trigger; envs: string[]; input: Record<string, InputField>; onChange: (t: Trigger) => void; onRemove: () => void }) {
  const meta = TRIGGER[tr.type];
  const { data: m } = useMeta();
  return (
    <div className={cn("rounded-lg border border-line", tr.enabled === false && "opacity-70")}>
      <div className="flex items-center gap-2 border-b border-line bg-sunken/50 px-3 py-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-panel text-fg-2 shadow-[var(--shadow-card)] [&_svg]:size-3.5">{meta.icon}</span>
        <span className="text-[13px] font-medium text-fg">{meta.label}</span>
        {tr.type === "event" && <code className="font-mono text-[12px] text-fg-3">{tr.source}.{tr.event}</code>}
        <code className="ml-1 font-mono text-[11px] text-fg-3">#{tr.id}</code>
        <div className="ml-auto flex items-center gap-2">
          <Switch size="sm" checked={tr.enabled !== false} onChange={(v) => onChange({ ...tr, enabled: v })} label={<span className="text-xs text-fg-3">{tr.enabled === false ? "已关闭" : "启用"}</span>} />
          <Button size="icon-xs" variant="ghost" onClick={onRemove} aria-label="删除"><LuTrash2 /></Button>
        </div>
      </div>
      <div className="p-3.5">
        {tr.type === "api" && <div className="text-[12.5px] text-fg-3">允许业务项目经 <code className="font-mono">POST /v1/runs</code> / SDK 调用。去掉它，任务就只能被定时、事件或网页触发。</div>}
        {tr.type === "chat" && <div className="text-[12.5px] text-fg-3">出现在对话页的任务选择里；同一会话多轮追问共享上下文。</div>}
        {tr.type === "schedule" && <ScheduleEditor tr={tr} envs={envs} onChange={onChange} />}
        {tr.type === "event" && <EventEditor tr={tr} input={input} fields={m?.event_sources.find((s) => s.name === tr.source)?.events.find((e) => e.name === tr.event)?.fields ?? []} onChange={onChange} />}
      </div>
    </div>
  );
}

function ScheduleEditor({ tr, envs, onChange }: { tr: Extract<Trigger, { type: "schedule" }>; envs: string[]; onChange: (t: Trigger) => void }) {
  const err = validateCron(tr.cron);
  const next = err ? [] : nextRuns(tr.cron, 4);
  const presets = [["每天 09:00", "0 9 * * *"], ["工作日 08:30", "30 8 * * 1-5"], ["每小时", "0 * * * *"], ["每 15 分钟", "*/15 * * * *"], ["每周一 10:00", "0 10 * * 1"]];
  const [inputText, setInputText] = useState(() => JSON.stringify(tr.input ?? {}));
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="cron（分 时 日 月 周）" error={err} help={!err && <span>{describeCron(tr.cron)}　接下来：{next.map((d) => dayjs(d).format("MM-DD HH:mm")).join("、")}</span>}>
        <Input mono value={tr.cron} onChange={(e) => onChange({ ...tr, cron: e.target.value })} aria-invalid={!!err} />
        <div className="mt-1.5 flex flex-wrap gap-1">
          {presets.map(([label, c]) => (
            <button key={c} type="button" onClick={() => onChange({ ...tr, cron: c })} className={cn("h-5 rounded border px-1.5 text-[11px]", tr.cron === c ? "border-accent text-accent" : "border-line text-fg-3 hover:text-fg")}>{label}</button>
          ))}
        </div>
      </Field>
      <Field label="在这些环境各跑一份">
        <div className="flex flex-wrap gap-3 pt-1">
          {envs.map((e) => <Checkbox key={e} checked={tr.envs.includes(e)} onChange={(v) => onChange({ ...tr, envs: v ? [...tr.envs, e] : tr.envs.filter((x) => x !== e) })} label={<EnvBadge env={e} />} />)}
        </div>
        {!tr.envs.length && <div className="mt-1 text-xs text-bad">至少选一个环境</div>}
      </Field>
      <Field label="固定输入（JSON）" className="md:col-span-2" help="每次定时触发都带这份输入">
        <Input mono value={inputText} onChange={(e) => { setInputText(e.target.value); try { onChange({ ...tr, input: JSON.parse(e.target.value || "{}") }); } catch { /* 输入中 */ } }} />
      </Field>
    </div>
  );
}

function EventEditor({ tr, input, fields, onChange }: { tr: Extract<Trigger, { type: "event" }>; input: Record<string, InputField>; fields: string[]; onChange: (t: Trigger) => void }) {
  const rules = tr.rules ?? [];
  const setRule = (i: number, r: TriggerRule | null) => onChange({ ...tr, rules: r ? rules.map((x, j) => (j === i ? r : x)) : rules.filter((_, j) => j !== i) });
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="过滤" help="事件字段 → 正则，全部命中才触发（如 project ~ ^board$）">
          <KeyValueEditor multiline={false} value={tr.filter ?? {}} onChange={(v) => onChange({ ...tr, filter: v })} keyPlaceholder="字段" valuePlaceholder="正则" />
        </Field>
        <Field label="字段映射" help={<>任务输入 ← 事件字段{fields.length > 0 && <>（可用：{fields.map((f) => <code key={f} className="mr-1 font-mono">{f}</code>)}）</>}</>}>
          <KeyValueEditor multiline={false} value={tr.map ?? {}} onChange={(v) => onChange({ ...tr, map: v })} keyPlaceholder="输入字段" valuePlaceholder="事件字段"
            suggestions={Object.keys(input).filter((k) => !(k in (tr.map ?? {}))).map((k) => ({ key: k, label: k }))} />
        </Field>
      </div>
      <Field label="会话命名" help="同一会话共享上下文：如 dagster:{asset_key}:{error_class}:{date} 让同类故障当天连续、跨天开新线；留空 = 每次独立">
        <Input mono value={tr.session ?? ""} onChange={(e) => onChange({ ...tr, session: e.target.value || null })} placeholder="{source}:{asset_key}:{date}" />
      </Field>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[12.5px] font-medium text-fg">规则先行 <span className="ml-1 font-normal text-fg-3">正则命中报错即直接给结论，不调模型；也会记一条 run（resolution=rule）</span></div>
          <Button size="xs" icon={<LuPlus />} onClick={() => onChange({ ...tr, rules: [...rules, { pattern: "", category: "infra", conclusion: "" }] })}>添加规则</Button>
        </div>
        {rules.length === 0 ? <div className="rounded-md border border-dashed border-line px-3 py-3 text-center text-xs text-fg-3">没有规则：所有事件都交给 agent</div> : (
          <div className="space-y-2">
            {rules.map((r, i) => (
              <div key={i} className="grid grid-cols-[1.2fr_110px_1.6fr_auto_auto] items-center gap-2">
                <Input mono value={r.pattern} onChange={(e) => setRule(i, { ...r, pattern: e.target.value })} placeholder="connection.*refused" />
                <Select value={r.category} onChange={(v) => setRule(i, { ...r, category: v })} options={["infra", "data", "code", "upstream"].map((c) => ({ value: c, label: c }))} />
                <Input value={r.conclusion} onChange={(e) => setRule(i, { ...r, conclusion: e.target.value })} placeholder="结论" />
                <Switch size="sm" checked={r.enabled !== false} onChange={(v) => setRule(i, { ...r, enabled: v })} />
                <Button size="icon-xs" variant="ghost" onClick={() => setRule(i, null)}><LuTrash2 /></Button>
              </div>
            ))}
          </div>
        )}
        {rules.some((r) => { try { new RegExp(r.pattern); return false; } catch { return true; } }) && <div className="mt-1 text-xs text-bad">有规则的正则不合法</div>}
      </div>
      <div className="flex items-center gap-2 text-xs text-fg-3"><Badge tone="outline">POST /v1/events/{tr.source}</Badge>事件统一入口；环境取自事件的 env 字段</div>
    </div>
  );
}
