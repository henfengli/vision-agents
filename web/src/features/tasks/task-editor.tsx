/**
 * 任务定义的编辑表单：新建任务（NewTaskPage）和任务详情的「定义」标签（TaskDefinitionEditor）共用一份。
 * 分节：基本 · 输入 · 触发 · 结果与限制 · 结构化输出 · 记忆 · 环境（新建时多一节档案）。
 * 校验与后端写入时的检查一致（domain/tasks.py consistency_error、registry._check_task），点保存前就能看到哪里不对。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  LuBraces, LuBrain, LuCalendarClock, LuCircleAlert, LuCode, LuCopy, LuFileInput, LuLayers, LuMessageSquare, LuPlus, LuScrollText,
  LuSend, LuSettings, LuSparkles, LuTrash2, LuWebhook, LuZap,
} from "react-icons/lu";

import { api, useEnvs, useMeta, useRoles, useServices, useSettings, useTasks } from "@/api/hooks";
import type { Deliver, Env, InputField, MemoryOverride, Task, TaskSummary, Trigger, TriggerRule } from "@/api/types";
import { Page, PageHeader } from "@/components/layout/shell";
import { SaveBar } from "@/components/save-bar";
import { EnvBadge, TRIGGER } from "@/components/status";
import { Button } from "@/components/ui/button";
import { KeyValueEditor } from "@/components/ui/data";
import { Checkbox, Field, Input, SearchSelect, Segmented, Select, Switch, Textarea } from "@/components/ui/form";
import { Menu, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader } from "@/components/ui/primitives";
import { describeCron, nextRuns, validateCron } from "@/lib/cron";
import { cn } from "@/lib/cn";
import { dayjs } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { navigate, useLeaveGuard, useSearch } from "@/lib/router";
import { PROFILE_LABEL } from "../services/service-detail";
import { InputControl, initialValues, inputErrors, inputValue } from "./input-control";

// ———————— 草稿 ————————

/**
 * 输入字段在编辑时按行存：改名不会和别的字段撞、不会丢。
 * ref：名字被清空的那一刻，去重 / 对象字段 / 事件映射 / 定时输入里引用它的地方还指着原来的名字，重新敲上名字时从这里改过去
 */
export interface InputRow { id: number; name: string; field: InputField; ref?: string }

export interface Draft {
  title: string;
  description: string;
  service: string | null;
  role: string | null;
  form: Task["form"];
  inputs: InputRow[];
  object_input: string | null;
  envs: string[];
  triggers: Trigger[];
  deliver: Deliver | null;
  dedup: { key: string; window_s: number } | null;
  memory: MemoryOverride;
  timeout_s: number;
  handler: string | null;
  schema: string;                       // 结构化输出的 JSON 文本；空 = 不要求
  profile: Record<string, string>;      // 只有新建时在这里编辑（已有任务在「档案」标签）
}

let rowSeq = 0;
const rowsOf = (input: Record<string, InputField>): InputRow[] =>
  Object.entries(input).map(([name, f]) => ({ id: ++rowSeq, name, field: { ...f, options: f.options?.length ? f.options : undefined } }));

type TaskLike = Pick<Task, "title" | "description" | "service" | "role" | "form" | "input" | "envs" | "triggers" | "deliver" | "dedup" | "memory" | "timeout_s"> &
  Partial<Pick<Task, "handler" | "output_schema" | "object_input" | "profile">>;

export function toDraft(t: TaskLike): Draft {
  return structuredClone({
    title: t.title, description: t.description, service: t.service, role: t.role, form: t.form, inputs: rowsOf(t.input),
    object_input: t.object_input ?? null, envs: t.envs, triggers: t.triggers, deliver: t.deliver, dedup: t.dedup, memory: t.memory ?? {},
    timeout_s: t.timeout_s, handler: t.handler ?? null, schema: t.output_schema ? JSON.stringify(t.output_schema, null, 2) : "", profile: t.profile ?? {},
  });
}

/** 草稿 → 接口要的定义（不含 name / profile） */
export function fromDraft(d: Draft): Partial<Task> {
  const input = Object.fromEntries(d.inputs.map((r) => [r.name.trim(), {
    ...r.field, options: r.field.type === "enum" ? (r.field.options ?? []).filter(Boolean) : [],
    default: r.field.default === "" ? null : r.field.default ?? null,
  }]));
  const agent = d.form === "agent";
  return {
    title: d.title.trim(), description: d.description, service: d.service, form: d.form, input, envs: d.envs, triggers: d.triggers,
    deliver: d.deliver, dedup: d.dedup, memory: agent ? d.memory : {}, timeout_s: d.timeout_s,
    role: agent ? d.role : null, handler: agent ? null : d.handler,
    output_schema: agent ? parseSchema(d.schema).value : null, object_input: agent ? d.object_input : null,
  };
}

const sameDraft = (a: Draft, b: Draft) => {
  const strip = (d: Draft) => ({ ...d, inputs: d.inputs.map((r) => [r.name, r.field]) });
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

function parseSchema(text: string): { value: Record<string, unknown> | null; error: string | null } {
  if (!text.trim()) return { value: null, error: null };
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { value: null, error: "须是一个 JSON 对象" };
    if ((v as { type?: unknown }).type !== "object") return { value: null, error: '顶层须是 {"type": "object", …}' };
    return { value: v as Record<string, unknown>, error: null };
  } catch (e) {
    return { value: null, error: `不是合法的 JSON：${(e as Error).message}` };
  }
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const regexError = (p: string) => { try { new RegExp(p); return null; } catch (e) { return (e as Error).message; } };

/** 会话命名模板：占位要是字段名；字面花括号写成 {{ }}（与后端 str.format 一致） */
function templateError(t: string): string | null {
  const rest = t.replace(/\{\{|\}\}/g, "");
  const names = [...rest.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  if (rest.replace(/\{[^{}]*\}/g, "").match(/[{}]/)) return "花括号没配对（字面花括号写成 {{ }}）";
  if (names.some((n) => !/^[A-Za-z_]\w*$/.test(n))) return "占位要是字段名，如 {asset_key}、{date}";
  return null;
}

export type Section = "basic" | "input" | "triggers" | "deliver" | "output" | "memory" | "envs" | "profile";
export interface DraftError { section: Section; message: string }

/** 与后端写入时的检查一致；返回全部问题（按分节） */
export function draftErrors(d: Draft, ctx: { channels: string[]; handlers: string[] }): DraftError[] {
  const out: DraftError[] = [];
  const err = (section: Section, message: string) => out.push({ section, message });
  const names = d.inputs.map((r) => r.name.trim());
  if (d.form === "agent" && !d.role) err("basic", "选一个执行角色");
  if (d.form === "builtin") {
    if (!d.handler) err("basic", "选一个内建处理器");
    else if (ctx.handlers.length && !ctx.handlers.includes(d.handler)) err("basic", `没有这个内建处理器：${d.handler}`);
  }
  for (const n of names) if (!FIELD_NAME.test(n)) err("input", n ? `字段名 ${n} 不合法：字母、数字、下划线，不以数字开头` : "有字段没写名字");
  const dup = names.filter((n, i) => n && names.indexOf(n) !== i);
  if (dup.length) err("input", `字段名重复：${[...new Set(dup)].join("、")}`);
  for (const r of d.inputs) if (r.field.type === "enum" && !(r.field.options ?? []).filter(Boolean).length) err("input", `枚举字段 ${r.name || "?"} 至少要有一个选项`);
  if (d.object_input && !names.includes(d.object_input)) err("input", `对象字段 ${d.object_input} 不在输入里`);

  const fields = Object.fromEntries(d.inputs.map((r) => [r.name.trim(), r.field]));
  const ids = d.triggers.map((t) => t.id);
  if (new Set(ids).size !== ids.length) err("triggers", "触发器 id 重复");
  for (const tr of d.triggers) {
    if (tr.type === "schedule") {
      if (validateCron(tr.cron)) err("triggers", `定时 ${tr.id}：cron 不合法（${validateCron(tr.cron)}）`);
      if (!tr.envs.length) err("triggers", `定时 ${tr.id}：至少选一个环境`);
      const outside = d.envs.length ? tr.envs.filter((e) => !d.envs.includes(e)) : [];
      if (outside.length) err("triggers", `定时 ${tr.id}：环境 ${outside.join("、")} 不在任务允许的环境里`);
      if (d.service === "*" && !tr.service) err("triggers", `定时 ${tr.id}：通用任务的定时要指定服务`);
      const bad = inputErrors(fields, tr.input ?? {});
      if (Object.keys(bad).length) err("triggers", `定时 ${tr.id} 的固定输入：${Object.entries(bad).map(([k, v]) => `${k} ${v}`).join("；")}`);
    }
    if (tr.type === "event") {
      for (const [k, p] of Object.entries(tr.filter ?? {})) if (regexError(p)) err("triggers", `事件 ${tr.id}：过滤 ${k} 的正则不合法`);
      for (const k of Object.keys(tr.map ?? {})) if (!names.includes(k)) err("triggers", `事件 ${tr.id}：映射的 ${k} 不是输入字段`);
      if (tr.session && templateError(tr.session)) err("triggers", `事件 ${tr.id}：会话命名 ${templateError(tr.session)}`);
      for (const r of tr.rules ?? []) {
        if (!r.pattern.trim()) err("triggers", `事件 ${tr.id}：有规则的正则是空的（空正则会截下所有报错）`);
        else if (regexError(r.pattern)) err("triggers", `事件 ${tr.id}：规则 ${r.pattern} 的正则不合法`);
        if (!r.conclusion.trim()) err("triggers", `事件 ${tr.id}：规则 ${r.pattern || "?"} 没写结论`);
      }
    }
  }
  if (d.deliver) {
    if (d.deliver.url != null) {
      if (!/^https?:\/\/\S+/.test(d.deliver.url)) err("deliver", "回调地址要以 http:// 或 https:// 开头");
    } else if (!d.deliver.channel) err("deliver", "选一个通知渠道（不推送就选「不推送」）");
    else if (ctx.channels.length && !ctx.channels.includes(d.deliver.channel)) err("deliver", `渠道 ${d.deliver.channel} 不存在`);
  }
  if (!(d.timeout_s >= 1 && d.timeout_s <= 7200)) err("deliver", "超时要在 1 秒到 2 小时之间");
  if (d.dedup) {
    const keys = d.dedup.key.split("+").map((k) => k.trim()).filter(Boolean);
    if (!keys.length) err("deliver", "去重要选按哪些输入字段");
    const missing = keys.filter((k) => !names.includes(k));
    if (missing.length) err("deliver", `去重字段不在输入里：${missing.join("、")}`);
  }
  if (d.form === "agent" && parseSchema(d.schema).error) err("output", `结构化输出：${parseSchema(d.schema).error}`);
  return out;
}

/** 改字段名：去重、对象字段、事件映射、定时的固定输入里引用它的地方跟着改 */
function renameInput(d: Draft, from: string, to: string): Draft {
  if (!from || from === to) return d;
  const swap = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k === from ? to : k, v]));
  return {
    ...d,
    object_input: d.object_input === from ? to : d.object_input,
    dedup: d.dedup ? { ...d.dedup, key: d.dedup.key.split("+").map((k) => (k.trim() === from ? to : k.trim())).join("+") } : null,
    triggers: d.triggers.map((t) => t.type === "schedule" ? { ...t, input: swap(t.input ?? {}) }
      : t.type === "event" && t.map ? { ...t, map: swap(t.map) as Record<string, string> } : t),
  };
}

function removeInput(d: Draft, name: string): Draft {
  const drop = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== name));
  const keys = d.dedup ? d.dedup.key.split("+").map((k) => k.trim()).filter((k) => k && k !== name) : [];
  return {
    ...d,
    object_input: d.object_input === name ? null : d.object_input,
    dedup: d.dedup ? (keys.length ? { ...d.dedup, key: keys.join("+") } : null) : null,
    triggers: d.triggers.map((t) => t.type === "schedule" ? { ...t, input: drop(t.input ?? {}) }
      : t.type === "event" && t.map ? { ...t, map: drop(t.map) as Record<string, string> } : t),
  };
}

const PROFILE_SUGGESTIONS = Object.entries(PROFILE_LABEL).map(([key, label]) => ({ key, label }));

// ———————— 表单本体 ————————

function Section({ id, icon, title, description, children, actions, errors }: {
  id: Section; icon: ReactNode; title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode; errors: DraftError[];
}) {
  const mine = errors.filter((e) => e.section === id);
  return (
    <Card id={`sec-${id}`} className="scroll-mt-4">
      <CardHeader icon={icon} title={title} description={description} actions={actions} />
      {mine.length > 0 && (
        <ul className="space-y-0.5 border-b border-bad/20 bg-bad-soft/40 px-4 py-2 text-[12.5px] text-bad">
          {mine.map((e, i) => <li key={i} className="flex items-start gap-1.5"><LuCircleAlert className="mt-0.5 size-3.5 shrink-0" />{e.message}</li>)}
        </ul>
      )}
      <div className="p-4">{children}</div>
    </Card>
  );
}

const SECTIONS: { id: Section; label: string; when?: (d: Draft, create: boolean) => boolean }[] = [
  { id: "basic", label: "基本" },
  { id: "input", label: "输入" },
  { id: "triggers", label: "触发" },
  { id: "deliver", label: "结果与限制" },
  { id: "output", label: "结构化输出", when: (d) => d.form === "agent" },
  { id: "memory", label: "记忆", when: (d) => d.form === "agent" },
  { id: "envs", label: "环境" },
  { id: "profile", label: "档案", when: (d, create) => create && d.form === "agent" },
];

const scrollTo = (s: Section) => document.getElementById(`sec-${s}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

function TaskForm({ d, setD, errors, create, resetKey, head }: {
  d: Draft; setD: (fn: (d: Draft) => Draft) => void; errors: DraftError[]; create: boolean; resetKey: number; head?: ReactNode;
}) {
  const { data: roles } = useRoles();
  const { data: services } = useServices();
  const { data: envs } = useEnvs();
  const { data: meta } = useMeta();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((s) => ({ ...s, [k]: v }));
  const agent = d.form === "agent";
  const generic = d.service === "*";
  const role = roles?.find((r) => r.name === d.role);
  const fields = Object.fromEntries(d.inputs.map((r) => [r.name.trim(), r.field]));
  const allowedEnvs = (envs ?? []).filter((e) => !d.envs.length || d.envs.includes(e.name));
  const sections = SECTIONS.filter((s) => !s.when || s.when(d, create));
  const setForm = (form: Task["form"]) => setD((s) => ({
    ...s, form,
    // 换形态：另一种形态用不上的字段清掉，不然会原样存进去（内建任务还挂着角色、结构化输出）
    role: form === "agent" ? s.role : null, handler: form === "builtin" ? s.handler ?? meta?.builtin_handlers[0] ?? null : null,
    schema: form === "agent" ? s.schema : "", object_input: form === "agent" ? s.object_input : null,
  }));

  return (
    <div className="grid gap-5 lg:grid-cols-[150px_1fr]">
      <nav className="sticky top-4 hidden h-fit space-y-0.5 text-[12.5px] lg:block">
        {sections.map((s) => {
          const n = errors.filter((e) => e.section === s.id).length;
          return (
            <a key={s.id} href={`#sec-${s.id}`} onClick={(e) => { e.preventDefault(); scrollTo(s.id); }}
              className="flex items-center justify-between rounded-md px-2.5 py-1.5 text-fg-2 hover:bg-hover hover:text-fg">
              {s.label}{n > 0 && <span className="rounded-full bg-bad-soft px-1.5 text-[11px] text-bad">{n}</span>}
            </a>
          );
        })}
      </nav>
      <div className="min-w-0 space-y-4 pb-24">
        {head}
        <Section id="basic" icon={<LuSettings />} title="基本" errors={errors}
          description={agent ? "角色决定 agent 能用哪些工具、怎么做事；任务写清要达成什么" : "内建任务不过模型，由平台代码按固定逻辑执行"}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="显示名" help="列表、运行记录、钉钉消息里显示的名字">
              <Input value={d.title} onChange={(e) => set("title", e.target.value)} placeholder="如：Web 日常巡检" />
            </Field>
            <Field label="归属" help={d.service === "*" ? "每次运行时再指定服务" : d.service ? "只在这个服务上跑" : "不涉及任何业务服务"}>
              <Select value={d.service ?? "_platform"} onChange={(v) => set("service", v === "_platform" ? null : v)} options={[
                ...(services ?? []).map((s) => ({ value: s.name, label: s.title, hint: s.name })),
                { value: "*", label: "通用（运行时指定服务）", hint: "比如问答类任务" }, { value: "_platform", label: "平台任务", hint: "不涉及业务服务" },
              ]} />
            </Field>
            <Field label="说明" className="md:col-span-2" help={agent ? "agent 拿到的任务说明：要达成什么、结论里要有什么。写得越具体，结果越稳" : "给人看的说明"}>
              <Textarea rows={3} value={d.description} onChange={(e) => set("description", e.target.value)}
                placeholder={agent ? "如：每天检查报表依赖的几张表是否到了上个交易日、线上报表页能否打开，异常项给出证据" : ""} />
            </Field>
            <Field label="形态">
              <Segmented value={d.form} onChange={setForm} options={[{ value: "agent", label: "agent（单角色）" }, { value: "builtin", label: "内建处理器" }]} />
            </Field>
            {agent ? (
              <Field label="执行角色" required help={role ? <span className="line-clamp-2">{role.description || role.name} · 工具：{role.tools.length
                ? role.tools.map((t) => (t === "*" ? "全部" : t.startsWith("mcp:") ? `${t.slice(4)} 的全部 MCP 工具` : t)).join("、")
                : role.extends ? `跟随 ${role.extends}` : "无"}</span> : "角色在 设置 → 角色 里管理"}>
                <Select value={d.role ?? null} onChange={(v) => set("role", v)} placeholder="选择角色"
                  options={(roles ?? []).map((r) => ({ value: r.name, label: r.title || r.name, hint: r.description || r.name }))} />
              </Field>
            ) : (
              <Field label="处理器" required help="平台代码里实现的作业">
                <Select value={d.handler ?? null} onChange={(v) => set("handler", v)} placeholder="选择处理器"
                  options={(meta?.builtin_handlers ?? []).map((h) => ({ value: h, label: h }))} />
              </Field>
            )}
          </div>
        </Section>

        <Section id="input" icon={<LuFileInput />} title="输入" errors={errors}
          description="运行时要给的参数：运行对话框按它生成表单，API 调用按它校验，事件按映射填进来">
          <InputSchemaEditor d={d} setD={setD} />
          {agent && d.inputs.length > 0 && (
            <div className="mt-4 grid gap-3 border-t border-line pt-4 md:grid-cols-[260px_1fr] md:items-start">
              <Field label="对象字段（可选）">
                <Select value={d.object_input ?? ""} onChange={(v) => set("object_input", v || null)}
                  options={[{ value: "", label: "无" }, ...d.inputs.filter((r) => r.name.trim()).map((r) => ({ value: r.name.trim(), label: r.name.trim(), hint: r.field.description || undefined }))]} />
              </Field>
              <p className="text-[12px] leading-relaxed text-fg-3 md:pt-6">
                这个字段的值就是要处理的「对象」（比如失败的资产 asset_key）：每个对象单独一份档案和记忆（子任务）。
                运行时选了对象就自动填上它；事件或 API 只给了这个字段，也会落到对应对象名下。
              </p>
            </div>
          )}
        </Section>

        <Section id="triggers" icon={<LuZap />} title="触发" errors={errors}
          description="这个任务会被什么启动。控制台里手动运行不受这里限制"
          actions={<AddTriggerMenu existing={d.triggers} envs={allowedEnvs} onAdd={(t) => set("triggers", [...d.triggers, t])} />}>
          <div className="space-y-3">
            {d.triggers.length === 0 && <div className="rounded-md border border-dashed border-line px-3 py-6 text-center text-xs text-fg-3">没有触发：只能在控制台手动运行</div>}
            {d.triggers.map((tr, i) => (
              <TriggerEditor key={`${tr.id}:${resetKey}:${i}`} tr={tr} envs={allowedEnvs} fields={fields} generic={generic}
                onChange={(v) => set("triggers", d.triggers.map((x, j) => (j === i ? v : x)))}
                onRemove={() => set("triggers", d.triggers.filter((_, j) => j !== i))} />
            ))}
          </div>
        </Section>

        <Section id="deliver" icon={<LuSend />} title="结果与限制" errors={errors} description="结果总能在运行详情里看到；这里决定要不要另外推送出去">
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="结果推送" className="md:col-span-2">
              <DeliverEditor value={d.deliver} channels={meta?.channels ?? []} onChange={(v) => set("deliver", v)} />
            </Field>
            <Field label="超时" help="一次运行最长能跑多久（含排队等模型），最长 2 小时">
              <div className="flex items-center gap-2">
                <Input className="w-24" inputMode="numeric" value={Math.round(d.timeout_s / 60) || ""} onChange={(e) => set("timeout_s", Math.min(120, Number(e.target.value.replace(/\D/g, "")) || 0) * 60)} />
                <span className="text-[12.5px] text-fg-3">分钟</span>
              </div>
            </Field>
            <DedupEditor d={d} set={(v) => set("dedup", v)} />
          </div>
        </Section>

        {agent && (
          <Section id="output" icon={<LuBraces />} title="结构化输出（可选）" errors={errors}
            description="给程序调用方用：要求 agent 最后按这份 JSON Schema 交回结果（当场校验），放在运行输出的 data 里；文字结论照旧"
            actions={!d.schema.trim() && <Button size="sm" onClick={() => set("schema", SCHEMA_EXAMPLE)}>插入示例</Button>}>
            <Textarea mono rows={Math.min(18, Math.max(3, d.schema.split("\n").length + 1))} value={d.schema} onChange={(e) => set("schema", e.target.value)}
              placeholder="留空 = 不要求结构化结果" aria-invalid={!!parseSchema(d.schema).error} />
          </Section>
        )}

        {agent && (
          <Section id="memory" icon={<LuBrain />} title="记忆" errors={errors} description="跟随 = 用平台默认（设置 → 记忆）；单次运行还可以再改">
            <MemoryEditor value={d.memory} onChange={(v) => set("memory", v)} />
          </Section>
        )}

        <Section id="envs" icon={<LuLayers />} title="环境" errors={errors} description="限定能在哪些环境跑；都不勾 = 所有环境">
          <div className="flex flex-wrap gap-4">
            {(envs ?? []).map((e) => (
              <Checkbox key={e.name} checked={d.envs.includes(e.name)} onChange={(v) => set("envs", v ? [...d.envs, e.name] : d.envs.filter((x) => x !== e.name))}
                label={<span className="flex items-center gap-1.5"><EnvBadge env={e.name} />{e.title}</span>} hint={e.protected ? "受保护" : undefined} />
            ))}
          </div>
        </Section>

        {create && agent && (
          <Section id="profile" icon={<LuScrollText />} title="档案（可选）" errors={errors}
            description="每次运行都原样放在提示词最前面：代码和配置里读不出来的事实，比如口径、禁区、常见坑。以后在任务的「档案」标签里改">
            <KeyValueEditor value={d.profile} onChange={(v) => set("profile", v)} suggestions={PROFILE_SUGGESTIONS} keyPlaceholder="键，如 pitfalls" valuePlaceholder="内容（支持 Markdown）" />
          </Section>
        )}
      </div>
    </div>
  );
}

const SCHEMA_EXAMPLE = `{
  "type": "object",
  "properties": {
    "category": { "enum": ["code", "data", "infra", "upstream"] },
    "root_cause": { "type": "string" }
  },
  "required": ["category", "root_cause"]
}`;

// ———————— 已有任务：定义标签 ————————

export function TaskDefinitionEditor({ task, onSaved }: { task: TaskSummary; onSaved: () => void }) {
  const [d, setDraft] = useState<Draft>(() => toDraft(task));
  /** 有了新版本 / 放弃修改时换一批触发器编辑器：它们自己留着输入框里的文本 */
  const [resetKey, setResetKey] = useState(0);
  const base = useMemo(() => toDraft(task), [task]);
  useEffect(() => { setDraft(toDraft(task)); setResetKey((n) => n + 1); }, [task.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: meta } = useMeta();
  const errors = draftErrors(d, { channels: meta?.channels ?? [], handlers: meta?.builtin_handlers ?? [] });
  const dirty = !sameDraft(d, base);

  const save = useMutation(async () => {
    try {
      const r = await api.update<TaskSummary>("tasks", task.name, fromDraft(d));
      toast(`已保存为 v${r.version}`, { description: "下一次运行就用新定义，定时也按它触发" });
      invalidate("tasks");
      onSaved();
    } catch (e) {
      toast.error("保存失败", (e as Error).message);
    }
  });

  return (
    <>
      <TaskForm d={d} setD={(fn) => setDraft(fn)} errors={errors} create={false} resetKey={resetKey} />
      <SaveBar visible={dirty} saving={save.pending} label={`保存为 v${task.version + 1}`}
        onSave={() => {
          if (errors.length) { toast.error(`还有 ${errors.length} 处要改`, errors[0].message); scrollTo(errors[0].section); }
          else void save.mutate(undefined);
        }}
        onDiscard={() => { setDraft(toDraft(task)); setResetKey((n) => n + 1); }} />
    </>
  );
}

// ———————— 新建任务 ————————

const TASK_NAME = /^[a-z][a-z0-9-]{1,48}$/;

type Preset = "qa" | "schedule" | "event" | "blank";

/** 几种常见起点：只是预填，之后每一项都能改 */
/** 各起点优先用的角色（种子里有就用，没有退回第一个角色）；只是预选，随时能换 */
const PRESET_ROLES: Record<Preset, string[]> = {
  qa: ["generalist"], schedule: ["inspector", "generalist"], event: ["ops_analyst", "generalist"], blank: ["generalist"],
};

function presetDraft(p: Preset, ctx: { service: string | null; envs: Env[]; roles: string[]; channel: string | null; eventSource?: { source: string; event: string } }): Draft {
  const env = (ctx.envs.find((e) => !e.protected) ?? ctx.envs[0])?.name ?? "test";
  const deliver = ctx.channel ? { channel: ctx.channel } : null;
  const role = PRESET_ROLES[p].find((r) => ctx.roles.includes(r)) ?? ctx.roles[0] ?? null;
  const base: TaskLike = { title: "", description: "", service: ctx.service, role, form: "agent", input: {}, envs: [], triggers: [{ id: "api", type: "api" }], deliver: null, dedup: null, memory: {}, timeout_s: 900 };
  if (p === "qa") return toDraft({ ...base, service: "*", input: { question: { type: "text", required: true, description: "问题或要做的事" } },
    triggers: [{ id: "chat", type: "chat" }, { id: "api", type: "api" }], timeout_s: 600 });
  if (p === "schedule") return toDraft({ ...base, triggers: [{ id: "daily", type: "schedule", cron: "0 9 * * 1-5", envs: [env], input: {} }, { id: "api", type: "api" }], deliver });
  if (p === "event" && ctx.eventSource) return toDraft({ ...base, triggers: [{ id: ctx.eventSource.source, type: "event", source: ctx.eventSource.source, event: ctx.eventSource.event, map: {}, rules: [] }, { id: "api", type: "api" }], deliver });
  return toDraft(base);
}

const PRESETS: { value: Preset; label: string; hint: string; icon: ReactNode }[] = [
  { value: "qa", label: "问答", hint: "在对话页和 API 里提问，输入一个问题", icon: <LuMessageSquare /> },
  { value: "schedule", label: "定时检查", hint: "按时自己跑，结果推送到群", icon: <LuCalendarClock /> },
  { value: "event", label: "事件触发", hint: "Dagster 失败、GitLab 部署这类事件来了就跑", icon: <LuWebhook /> },
  { value: "blank", label: "空白", hint: "从头写", icon: <LuSparkles /> },
];

export function NewTaskPage() {
  const [search] = useSearch<{ from: string }>();
  const { data: tasks } = useTasks();
  const { data: envs } = useEnvs();
  const { data: meta } = useMeta();
  const { data: services } = useServices();
  const { data: roles } = useRoles();
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<Preset | "copy">(search.from ? "copy" : "qa");
  const [from, setFrom] = useState(search.from ?? "");
  const [d, setDraft] = useState<Draft | null>(null);
  const [resetKey, setResetKey] = useState(0);
  /** 点过一次「创建」才把问题标出来：刚打开就满屏红字没意义 */
  const [tried, setTried] = useState(false);
  const touched = useRef(false);
  const ctx = () => ({
    service: services?.[0]?.name ?? "*", envs: envs ?? [], roles: (roles ?? []).map((r) => r.name),
    channel: meta?.channels.includes("default") ? "default" : meta?.channels[0] ?? null,
    eventSource: meta?.event_sources[0]?.events[0] ? { source: meta.event_sources[0].name, event: meta.event_sources[0].events[0].name } : undefined,
  });
  const source = tasks?.find((t) => t.name === from && !t.extends);

  // 选了起点（或复制的任务到了）就重新预填
  const fill = (p: Preset | "copy", copyFrom = from): boolean => {
    const src = tasks?.find((t) => t.name === copyFrom && !t.extends);
    if (p === "copy" && !src) return false;
    setPreset(p);
    setFrom(copyFrom);
    setDraft(p === "copy" ? { ...toDraft(src!), title: src!.title ? `${src!.title}（副本）` : "" } : presetDraft(p, ctx()));
    setResetKey((n) => n + 1);
    touched.current = false;
    return true;
  };
  /** 已经改过表单再换起点：先确认，不然改的东西一下就没了 */
  const apply = async (p: Preset | "copy", copyFrom = from) => {
    if (touched.current && !(await confirm({ title: "换一个起点？", description: "表单会按新的起点重新预填，刚才改的内容不保留（任务名留着）。", confirmText: "换", danger: true }))) return;
    fill(p, copyFrom);
  };
  const ready = !!envs && !!meta && !!services && !!tasks && !!roles;
  useEffect(() => {
    if (!ready || d) return;
    // ?from= 指的任务不存在（或是子任务）：退回问答起点，别让页面一直停在加载
    if (search.from && !fill("copy", search.from)) {
      toast.error("没找到要复制的任务", `${search.from} 不存在或是子任务，先从「问答」开始`);
      fill("qa", "");
    } else if (!search.from) fill("qa", "");
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const nameError = !name ? null : !TASK_NAME.test(name) ? "小写字母开头，只能有小写字母、数字、连字符（2~49 个字符）"
    : tasks?.some((t) => t.name === name) ? "已经有这个任务了" : null;
  const errors = d ? draftErrors(d, { channels: meta?.channels ?? [], handlers: meta?.builtin_handlers ?? [] }) : [];
  useLeaveGuard(touched.current || !!name);

  const create = useMutation(async () => {
    if (!d) return;
    try {
      await api.create("tasks", { name, ...fromDraft(d), profile: d.form === "agent" ? d.profile : {} });
      invalidate("tasks");
      touched.current = false;
      toast("任务已创建", { description: name });
      navigate(`/tasks/${name}`, { replace: true, force: true });
    } catch (e) {
      toast.error("创建失败", (e as Error).message);
    }
  });
  const submit = () => {
    setTried(true);
    if (!name || nameError) { toast.error("先填任务名", nameError ?? "任务名是它在 API 和运行记录里的标识"); document.getElementById("task-name")?.focus(); return; }
    if (errors.length) { toast.error(`还有 ${errors.length} 处要改`, errors[0].message); scrollTo(errors[0].section); return; }
    void create.mutate(undefined);
  };

  const head = (
    <Card>
      <CardHeader icon={<LuSparkles />} title="从哪里开始" description="选一种起点预填，之后每一项都能改" />
      <div className="space-y-4 p-4">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {PRESETS.filter((p) => p.value !== "event" || meta?.event_sources.length).map((p) => (
            <button key={p.value} type="button" onClick={() => void apply(p.value)}
              className={cn("rounded-lg border px-3 py-2.5 text-left transition-colors", preset === p.value ? "border-accent bg-accent-soft" : "border-line bg-panel hover:bg-hover")}>
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-fg [&_svg]:size-3.5 [&_svg]:text-fg-3">{p.icon}{p.label}</div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-fg-3">{p.hint}</div>
            </button>
          ))}
          <div className={cn("rounded-lg border px-3 py-2.5", preset === "copy" ? "border-accent bg-accent-soft" : "border-line bg-panel")}>
            <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-fg"><LuCopy className="size-3.5 text-fg-3" />复制已有任务</div>
            <SearchSelect value={from || null} onChange={(v) => void apply("copy", v)} placeholder="选一个任务…"
              options={(tasks ?? []).filter((t) => !t.extends).map((t) => ({ value: t.name, label: t.title || t.name, hint: t.name }))} />
          </div>
        </div>
        <div className="grid gap-4 border-t border-line pt-4 md:grid-cols-2">
          <Field label="任务名" required error={nameError} help="API、运行记录里用的标识，建好后不能改：小写字母、数字、连字符">
            <Input id="task-name" mono autoFocus value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} placeholder="web-inspection" aria-invalid={!!nameError} />
          </Field>
          {preset === "copy" && source && (
            <p className="text-[12px] leading-relaxed text-fg-3 md:pt-6">
              复制了 <b className="font-medium text-fg-2">{source.title || source.name}</b> 的定义和档案（不含子任务、运行记录、记忆）。
            </p>
          )}
        </div>
      </div>
    </Card>
  );

  return (
    <Page wide>
      <PageHeader crumbs={[{ label: "任务", to: "/tasks" }, { label: "新建" }]} title="新建任务"
        actions={<>
          <Button onClick={() => navigate("/tasks")}>取消</Button>
          <Button variant="primary" icon={<LuPlus />} loading={create.pending} onClick={submit}>创建任务</Button>
        </>} />
      {!d ? <div className="h-96 animate-pulse rounded-lg bg-sunken" /> : (
        <TaskForm d={d} setD={(fn) => { touched.current = true; setDraft((cur) => (cur ? fn(cur) : cur)); }} errors={tried ? errors : []} create resetKey={resetKey} head={head} />
      )}
      <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
        <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-line bg-raised py-2 pl-4 pr-2 shadow-[var(--shadow-pop)]">
          <span className="text-[13px] text-fg-2">{tried && errors.length ? <span className="text-bad">还有 {errors.length} 处要改</span> : name && !nameError ? <>创建 <code className="font-mono">{name}</code></> : "填好任务名就能创建"}</span>
          <Button size="sm" variant="primary" loading={create.pending} onClick={submit}>创建任务</Button>
        </div>
      </div>
    </Page>
  );
}

// ———————— 结果推送 / 去重 / 记忆 ————————

type DeliverMode = "none" | "channel" | "url";

function DeliverEditor({ value, channels, onChange }: { value: Deliver | null; channels: string[]; onChange: (v: Deliver | null) => void }) {
  // 按字段在不在判断，不按有没有值：刚选「HTTP 回调」时 url 还是空串，按值判断会退回「不推送」，地址框永远出不来
  const mode: DeliverMode = !value ? "none" : value.url != null ? "url" : "channel";
  const setMode = (m: DeliverMode) => onChange(m === "none" ? null : m === "channel" ? { channel: channels.includes("default") ? "default" : channels[0] ?? "" } : { url: "" });
  return (
    <div className="space-y-2">
      <Segmented value={mode} onChange={setMode} options={[{ value: "none", label: "不推送" }, { value: "channel", label: "推送到通知渠道" }, { value: "url", label: "HTTP 回调" }]} />
      {mode === "none" && <div className="text-xs text-fg-3">调用方用 run_id 来取，或在运行详情里看</div>}
      {mode === "channel" && (
        <div className="flex flex-wrap items-center gap-2">
          <Select className="w-56" value={value?.channel ?? null} onChange={(channel) => onChange({ channel })} placeholder="选择渠道" options={channels.map((c) => ({ value: c, label: c }))} />
          <span className="text-xs text-fg-3">{channels.length ? "跑完把结论发到这个群" : "还没有渠道：先在 设置 → 通知 里建"}</span>
        </div>
      )}
      {mode === "url" && <>
        <Input mono value={value?.url ?? ""} onChange={(e) => onChange({ url: e.target.value })} placeholder="https://vision-board.ipa.zs/hooks/agent" />
        <div className="text-xs text-fg-3">跑完 POST <code className="font-mono">{"{run_id, task, service, env, status, output}"}</code></div>
      </>}
    </div>
  );
}

function DedupEditor({ d, set }: { d: Draft; set: (v: Draft["dedup"]) => void }) {
  const names = d.inputs.map((r) => r.name.trim()).filter(Boolean);
  const keys = d.dedup ? d.dedup.key.split("+").map((k) => k.trim()).filter(Boolean) : [];
  return (
    <Field label="去重" help="窗口内同样输入的成功运行直接复用结果，不再跑一遍（比如同一个 Dagster run 的失败事件重复推送）">
      <div className="space-y-2">
        <Switch checked={!!d.dedup} disabled={!names.length} onChange={(v) => set(v ? { key: names[0] ?? "", window_s: 600 } : null)}
          label={<span className="text-[12.5px] text-fg-2">{!names.length ? "没有输入字段，不能去重" : d.dedup ? "开" : "关"}</span>} />
        {d.dedup && (
          <div className="space-y-2 rounded-md border border-line bg-sunken/40 p-2.5">
            <div className="flex flex-wrap gap-x-4">
              <span className="pt-1 text-[12px] text-fg-3">按</span>
              {names.map((n) => (
                <Checkbox key={n} checked={keys.includes(n)} label={<span className="font-mono text-[12.5px]">{n}</span>}
                  onChange={(v) => set({ ...d.dedup!, key: (v ? [...keys, n] : keys.filter((k) => k !== n)).join("+") })} />
              ))}
            </div>
            <div className="flex items-center gap-2 text-[12px] text-fg-3">
              窗口<Input className="w-20" inputMode="numeric" value={Math.round(d.dedup.window_s / 60) || ""} onChange={(e) => set({ ...d.dedup!, window_s: Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1) * 60 })} />分钟
            </div>
          </div>
        )}
      </div>
    </Field>
  );
}

function MemoryEditor({ value, onChange }: { value: MemoryOverride; onChange: (v: MemoryOverride) => void }) {
  const { data: settings } = useSettings();
  const platform = settings?.memory;
  const row = (key: "recall" | "save", title: string, hint: string) => {
    const v = value[key];
    return (
      <div className="flex flex-wrap items-center gap-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-fg">{title}</div>
          <div className="text-xs text-fg-3">{hint}</div>
        </div>
        <Segmented size="sm" value={v === true ? "on" : v === false ? "off" : "inherit"}
          onChange={(m) => onChange({ ...value, [key]: m === "inherit" ? null : m === "on" })}
          options={[{ value: "inherit", label: `跟随平台${platform ? (platform[key] ? "（开）" : "（关）") : ""}` }, { value: "on", label: "开" }, { value: "off", label: "关" }]} />
      </div>
    );
  };
  return (
    <div className="divide-y divide-line">
      {row("recall", "召回", "运行前查以前记下的事实、报错教训和方法，放进提示词")}
      {row("save", "沉淀", "运行成功后，把以后还用得上的结论记下来")}
    </div>
  );
}

// ———————— 输入字段 ————————

const TYPE_OPTIONS: { value: InputField["type"]; label: string }[] = [
  { value: "str", label: "文本" }, { value: "text", label: "长文本" }, { value: "int", label: "整数" }, { value: "bool", label: "开关" }, { value: "enum", label: "枚举" }, { value: "json", label: "JSON" },
];

function InputSchemaEditor({ d, setD }: { d: Draft; setD: (fn: (d: Draft) => Draft) => void }) {
  const update = (id: number, patch: Partial<InputRow>) => setD((s) => {
    const row = s.inputs.find((r) => r.id === id)!;
    if (patch.name === undefined) return { ...s, inputs: s.inputs.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
    // 引用跟着改名走；名字清空的中间态不改引用（记在 ref），重新敲上名字时再从原名改过去
    const from = row.ref ?? row.name.trim();
    const to = patch.name.trim();
    const next = { ...s, inputs: s.inputs.map((r) => (r.id === id ? { ...r, ...patch, ref: to ? undefined : from } : r)) };
    return to ? renameInput(next, from, to) : next;
  });
  const setField = (id: number, f: Partial<InputField>) => setD((s) => ({ ...s, inputs: s.inputs.map((r) => (r.id === id ? { ...r, field: { ...r.field, ...f } } : r)) }));
  const add = () => setD((s) => {
    let n = s.inputs.length ? "field" : "question";
    let j = 1;
    while (s.inputs.some((r) => r.name === n)) n = `field${++j}`;
    return { ...s, inputs: [...s.inputs, { id: ++rowSeq, name: n, field: { type: n === "question" ? "text" : "str" } }] };
  });
  return (
    <div className="space-y-2">
      {d.inputs.length === 0 && <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-fg-3">没有输入：运行时不用填参数（agent 只看任务说明和档案）</div>}
      {d.inputs.length > 0 && (
        <div className="hidden grid-cols-[170px_110px_56px_1fr_32px] gap-2 px-0.5 text-[11.5px] text-fg-3 md:grid"><span>字段名</span><span>类型</span><span>必填</span><span>说明 / 默认值</span><span /></div>
      )}
      {d.inputs.map((r) => (
        <div key={r.id} className="grid grid-cols-[170px_110px_56px_1fr_32px] items-start gap-2 rounded-md py-1">
          <Input mono value={r.name} onChange={(e) => update(r.id, { name: e.target.value.replace(/\s/g, "") })} aria-invalid={!FIELD_NAME.test(r.name)} />
          <Select value={r.field.type} onChange={(t) => setField(r.id, { type: t as InputField["type"], default: null, options: t === "enum" ? r.field.options ?? [] : undefined })} options={TYPE_OPTIONS} />
          <div className="flex h-8 items-center">
            <Switch size="sm" checked={!!r.field.required} disabled={r.field.type === "bool"} onChange={(v) => setField(r.id, { required: v })} />
          </div>
          <div className="space-y-1.5">
            <Input value={r.field.description ?? ""} onChange={(e) => setField(r.id, { description: e.target.value })} placeholder="说明：运行表单里显示在字段下面" />
            {/* 输入时不去空项：否则刚敲下的逗号立刻被吞掉，第二个选项加不上；保存时再去掉 */}
            {r.field.type === "enum" && <Input mono value={(r.field.options ?? []).join(",")} onChange={(e) => setField(r.id, { options: e.target.value.split(",").map((x) => x.trim()) })} placeholder="选项，逗号分隔：full,quick" />}
            <DefaultValue field={r.field} onChange={(v) => setField(r.id, { default: v })} />
          </div>
          <Button size="icon-sm" variant="ghost" aria-label={`删除字段 ${r.name}`}
            onClick={() => setD((s) => removeInput({ ...s, inputs: s.inputs.filter((x) => x.id !== r.id) }, r.ref ?? r.name.trim()))}><LuTrash2 /></Button>
        </div>
      ))}
      <Button size="xs" icon={<LuPlus />} onClick={add}>添加字段</Button>
    </div>
  );
}

function DefaultValue({ field, onChange }: { field: InputField; onChange: (v: unknown) => void }) {
  const v = field.default;
  if (field.type === "bool") return (
    <label className="flex items-center gap-2 text-[12px] text-fg-3">默认<Switch size="sm" checked={v === true} onChange={onChange} /></label>
  );
  if (field.type === "enum") return (
    <div className="flex items-center gap-2 text-[12px] text-fg-3">默认
      <Select className="w-40" value={(v as string) ?? ""} onChange={(x) => onChange(x || null)}
        options={[{ value: "", label: "无" }, ...(field.options ?? []).filter(Boolean).map((o) => ({ value: o, label: o }))]} />
    </div>
  );
  if (field.type === "json") return null;
  return (
    <Input className="text-[12.5px]" value={v == null ? "" : String(v)} placeholder="默认值（可空）"
      onChange={(e) => onChange(e.target.value === "" ? null : field.type === "int" && /^-?\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value)} />
  );
}

// ———————— 触发 ————————

const newId = (type: string, existing: Trigger[]) => { let n = type; let i = 1; while (existing.some((t) => t.id === n)) n = `${type}-${++i}`; return n; };

function AddTriggerMenu({ onAdd, existing, envs }: { onAdd: (t: Trigger) => void; existing: Trigger[]; envs: Env[] }) {
  const { data: meta } = useMeta();
  const has = (t: string) => existing.some((x) => x.type === t);
  // 新定时默认跑在第一个不受保护的环境（一般是测试）：先在测试验证，再勾上生产
  const env = (envs.find((e) => !e.protected) ?? envs[0])?.name;
  return (
    <Menu trigger={<Button size="sm" icon={<LuPlus />}>添加触发</Button>} items={[
      { label: "API 调用", icon: <LuCode />, disabled: has("api"), hint: has("api") ? "已有" : "业务项目用 SDK / HTTP 调", onClick: () => onAdd({ id: "api", type: "api" }) },
      { label: "对话", icon: <LuMessageSquare />, disabled: has("chat"), hint: has("chat") ? "已有" : "出现在对话页", onClick: () => onAdd({ id: "chat", type: "chat" }) },
      { label: "定时", icon: <LuCalendarClock />, hint: "按 cron 在选定的环境各跑一份", onClick: () => onAdd({ id: newId("schedule", existing), type: "schedule", cron: "0 9 * * 1-5", envs: env ? [env] : [], input: {} }) },
      { separator: true, label: "" },
      ...(meta?.event_sources ?? []).flatMap((s) => s.events.map((ev) => ({
        label: `${s.title} · ${ev.title}`, icon: <LuWebhook />, onClick: () => onAdd({ id: newId(s.name, existing), type: "event" as const, source: s.name, event: ev.name, map: {}, rules: [] }),
      }))),
    ]} />
  );
}

function TriggerEditor({ tr, envs, fields, generic, onChange, onRemove }: {
  tr: Trigger; envs: Env[]; fields: Record<string, InputField>; generic: boolean; onChange: (t: Trigger) => void; onRemove: () => void;
}) {
  const meta = TRIGGER[tr.type];
  const { data: m } = useMeta();
  const source = tr.type === "event" ? m?.event_sources.find((s) => s.name === tr.source) : undefined;
  return (
    <div className={cn("rounded-lg border border-line", tr.enabled === false && "opacity-70")}>
      <div className="flex items-center gap-2 border-b border-line bg-sunken/50 px-3 py-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-panel text-fg-2 shadow-[var(--shadow-card)] [&_svg]:size-3.5">{meta.icon}</span>
        <span className="text-[13px] font-medium text-fg">{meta.label}</span>
        {tr.type === "event" && <span className="text-[12px] text-fg-3">{source?.title ?? tr.source} · {source?.events.find((e) => e.name === tr.event)?.title ?? tr.event}</span>}
        <code className="ml-1 font-mono text-[11px] text-fg-3">#{tr.id}</code>
        <div className="ml-auto flex items-center gap-2">
          <Switch size="sm" checked={tr.enabled !== false} onChange={(v) => onChange({ ...tr, enabled: v })} label={<span className="text-xs text-fg-3">{tr.enabled === false ? "已关闭" : "启用"}</span>} />
          <Button size="icon-xs" variant="ghost" onClick={onRemove} aria-label="删除这个触发"><LuTrash2 /></Button>
        </div>
      </div>
      <div className="p-3.5">
        {tr.type === "api" && <div className="text-[12.5px] text-fg-3">业务项目经 SDK 或 <code className="font-mono">POST /v1/runs</code> 调用。去掉它，API 调用会被拒绝。</div>}
        {tr.type === "chat" && <div className="text-[12.5px] text-fg-3">出现在对话页的任务选择里，可以多轮追问。</div>}
        {tr.type === "schedule" && <ScheduleEditor tr={tr} envs={envs} fields={fields} generic={generic} onChange={onChange} />}
        {tr.type === "event" && <EventEditor tr={tr} fields={fields} generic={generic} eventFields={source?.events.find((e) => e.name === tr.event)?.fields ?? []} onChange={onChange} />}
      </div>
    </div>
  );
}

/** 通用任务的定时 / 事件触发要说清楚跑哪个服务 */
function TriggerServiceField({ value, required, onChange }: { value: string | null | undefined; required: boolean; onChange: (v: string | null) => void }) {
  const { data: services } = useServices();
  return (
    <Field label="服务" required={required} help={required ? "通用任务的定时要指定跑在哪个服务上" : "不选 = 用事件数据里的 service 字段"}>
      <Select value={value ?? ""} onChange={(v) => onChange(v || null)} placeholder="选择服务"
        options={[...(required ? [] : [{ value: "", label: "取自事件" }]), ...(services ?? []).map((s) => ({ value: s.name, label: s.title, hint: s.name }))]} />
    </Field>
  );
}

const CRON_PRESETS = [["工作日 09:00", "0 9 * * 1-5"], ["每天 08:50", "50 8 * * *"], ["每小时", "0 * * * *"], ["每 15 分钟", "*/15 * * * *"], ["每周一 10:00", "0 10 * * 1"]];

function ScheduleEditor({ tr, envs, fields, generic, onChange }: {
  tr: Extract<Trigger, { type: "schedule" }>; envs: Env[]; fields: Record<string, InputField>; generic: boolean; onChange: (t: Trigger) => void;
}) {
  const err = validateCron(tr.cron);
  const next = err ? [] : nextRuns(tr.cron, 3);
  // 固定输入的表单值（输入框里是字符串）
  const [raw, setRaw] = useState(() => initialValues(fields, tr.input ?? {}));
  // 输入字段改名 / 增删了：触发器上的固定输入已经跟着改了（renameInput），表单值按它重来
  const names = Object.keys(fields).join("\n");
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setRaw(initialValues(fields, tr.input ?? {}));
  }, [names]); // eslint-disable-line react-hooks/exhaustive-deps
  const errs = inputErrors(fields, raw);
  const setValue = (k: string, v: unknown) => {
    const nextRaw = { ...raw, [k]: v };
    setRaw(nextRaw);
    const input: Record<string, unknown> = {};
    for (const [name, f] of Object.entries(fields)) {
      // 解析不了的 JSON 原样写回：保存前的检查（draftErrors）看的是触发器上的值，这样才拦得住，也不会悄悄丢掉
      try { const val = inputValue(f, nextRaw[name]); if (val !== undefined) input[name] = val; } catch { input[name] = nextRaw[name]; }
    }
    onChange({ ...tr, input });
  };
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="时间（cron：分 时 日 月 周，北京时间）" error={err}
        help={!err && <span>{describeCron(tr.cron)}　接下来：{next.map((x) => dayjs(x).format("MM-DD HH:mm")).join("、")}</span>}>
        <Input mono value={tr.cron} onChange={(e) => onChange({ ...tr, cron: e.target.value })} aria-invalid={!!err} />
        <div className="mt-1.5 flex flex-wrap gap-1">
          {CRON_PRESETS.map(([label, c]) => (
            <button key={c} type="button" onClick={() => onChange({ ...tr, cron: c })} className={cn("h-5 rounded border px-1.5 text-[11px]", tr.cron === c ? "border-accent text-accent" : "border-line text-fg-3 hover:text-fg")}>{label}</button>
          ))}
        </div>
      </Field>
      <Field label="在这些环境各跑一份" error={!tr.envs.length ? "至少选一个环境" : null} help="先只勾测试，确认没问题再加生产">
        <div className="flex flex-wrap gap-3 pt-1">
          {envs.map((e) => <Checkbox key={e.name} checked={tr.envs.includes(e.name)} onChange={(v) => onChange({ ...tr, envs: v ? [...tr.envs, e.name] : tr.envs.filter((x) => x !== e.name) })} label={<EnvBadge env={e.name} />} />)}
        </div>
      </Field>
      {generic && <TriggerServiceField value={tr.service} required onChange={(service) => onChange({ ...tr, service })} />}
      {Object.keys(fields).length > 0 && (
        <div className="space-y-3 rounded-md border border-line bg-sunken/40 p-3 md:col-span-2">
          <div className="text-[12px] text-fg-3">每次定时运行带的输入</div>
          <div className="grid gap-3 md:grid-cols-2">
            {Object.entries(fields).map(([k, f]) => <InputControl key={k} name={k} field={f} value={raw[k]} error={errs[k]} onChange={(v) => setValue(k, v)} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function EventEditor({ tr, fields, generic, eventFields, onChange }: {
  tr: Extract<Trigger, { type: "event" }>; fields: Record<string, InputField>; generic: boolean; eventFields: string[]; onChange: (t: Trigger) => void;
}) {
  const rules = tr.rules ?? [];
  const setRule = (i: number, r: TriggerRule | null) => onChange({ ...tr, rules: r ? rules.map((x, j) => (j === i ? r : x)) : rules.filter((_, j) => j !== i) });
  const unmapped = Object.keys(fields).filter((k) => !(k in (tr.map ?? {})));
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="只处理满足条件的事件" help="事件字段 → 正则，全部满足才触发；不写 = 来了就处理">
          <KeyValueEditor multiline={false} value={tr.filter ?? {}} onChange={(v) => onChange({ ...tr, filter: v })} keyPlaceholder="事件字段" valuePlaceholder="正则，如 ^vision-board$" />
        </Field>
        <Field label="事件字段 → 任务输入" help={<>不写 = 事件整份当输入{eventFields.length > 0 && <>。事件里有：{eventFields.map((f) => <code key={f} className="mr-1 font-mono">{f}</code>)}</>}</>}>
          <KeyValueEditor multiline={false} value={tr.map ?? {}} onChange={(v) => onChange({ ...tr, map: v })} keyPlaceholder="输入字段" valuePlaceholder="事件字段"
            suggestions={unmapped.map((k) => ({ key: k, label: k }))} />
        </Field>
      </div>
      {generic && <TriggerServiceField value={tr.service} required={false} onChange={(service) => onChange({ ...tr, service })} />}
      <Field label="会话（可选）" error={tr.session ? templateError(tr.session) : null}
        help="同一个会话里 agent 记得前几次的分析。比如 dagster:{asset_key}:{error_class}:{date}：同一资产同类报错当天续着查，第二天重新开始。留空 = 每次独立">
        <Input mono value={tr.session ?? ""} onChange={(e) => onChange({ ...tr, session: e.target.value || null })} placeholder="dagster:{asset_key}:{date}" />
      </Field>
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="text-[12.5px] font-medium text-fg">规则先行 <span className="ml-1 font-normal text-fg-3">报错命中正则就直接给结论，不调模型（也记一条运行）</span></div>
          <Button size="xs" icon={<LuPlus />} onClick={() => onChange({ ...tr, rules: [...rules, { pattern: "", category: "infra", conclusion: "" }] })}>添加规则</Button>
        </div>
        {rules.length === 0 ? <div className="rounded-md border border-dashed border-line px-3 py-3 text-center text-xs text-fg-3">没有规则：每个事件都交给 agent 分析</div> : (
          <div className="space-y-2">
            {rules.map((r, i) => (
              <div key={i} className="grid grid-cols-[1.2fr_110px_1.6fr_auto_auto] items-center gap-2">
                <Input mono value={r.pattern} onChange={(e) => setRule(i, { ...r, pattern: e.target.value })} placeholder="报错正则，如 connection.*refused" aria-invalid={!r.pattern.trim() || !!regexError(r.pattern)} />
                <Select value={r.category} onChange={(v) => setRule(i, { ...r, category: v })} options={[["infra", "基础设施"], ["data", "数据"], ["code", "代码"], ["upstream", "上游"]].map(([v, l]) => ({ value: v, label: l }))} />
                <Input value={r.conclusion} onChange={(e) => setRule(i, { ...r, conclusion: e.target.value })} placeholder="直接给出的结论" aria-invalid={!r.conclusion.trim()} />
                <Switch size="sm" checked={r.enabled !== false} onChange={(v) => setRule(i, { ...r, enabled: v })} />
                <Button size="icon-xs" variant="ghost" aria-label="删除这条规则" onClick={() => setRule(i, null)}><LuTrash2 /></Button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-3"><Badge tone="outline">POST /v1/events/{tr.source}</Badge>事件统一入口；跑在事件数据的 env 字段指的环境</div>
    </div>
  );
}
