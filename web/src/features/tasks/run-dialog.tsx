/**
 * 「运行任务」对话框：选任务 → 服务（通用任务）→ 环境 → 子任务（可选）→ 按输入 schema 生成的表单 → 记忆开关。
 * 提交走 POST /v1/runs，与 API/SDK 同一路径；成功后跳到运行详情。
 */
import { useEffect, useMemo, useState } from "react";
import { LuPlay, LuShieldCheck } from "react-icons/lu";

import { api, useEnvs, useServices, useSettings, useSubtasks, useTasks } from "@/api/hooks";
import type { InputField, MemoryOverride, TaskSummary } from "@/api/types";
import { EnvBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { CreatableSelect, Field, Input, SearchSelect, Select, Segmented, Switch, Textarea, objectNameError } from "@/components/ui/form";
import { Dialog, toast } from "@/components/ui/overlay";
import { cn } from "@/lib/cn";
import { seconds } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { navigate } from "@/lib/router";
import { useUi } from "@/lib/store";

/** 通用入口：任何服务任何环境直接提问或交代一件事，不用先建任务；POST /v1/runs 不填 task 就是它 */
export const ASK_TASK = "ask";

export function RunTaskDialog({ open, onClose, task: presetTask, service: presetService, subtask: presetSubtask }: {
  open: boolean; onClose: () => void; task?: string; service?: string; subtask?: string;
}) {
  const { data: tasks } = useTasks();
  const { data: services } = useServices();
  const { data: envs } = useEnvs();
  const { env: globalEnv } = useUi();

  /** 通用入口 ask 排第一个 */
  const runnable = useMemo(() => (tasks ?? []).filter((t) => !t.extends && t.enabled && (!presetService || t.service === presetService || t.service === "*"))
    .sort((a, b) => Number(b.name === ASK_TASK) - Number(a.name === ASK_TASK)), [tasks, presetService]);
  const [taskName, setTaskName] = useState(presetTask ?? "");
  /** 不选任务 = 通用入口 ask（POST /v1/runs 不带 task） */
  const effectiveName = taskName || ASK_TASK;
  const task: TaskSummary | undefined = runnable.find((t) => t.name === effectiveName) ?? tasks?.find((t) => t.name === effectiveName);
  const [service, setService] = useState(presetService ?? "");
  const [env, setEnv] = useState("");
  const [subtask, setSubtask] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [memory, setMemory] = useState<MemoryOverride>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setTaskName(presetTask ?? "");
    setService(presetService ?? "");
    setSubtask(presetSubtask ?? "");
    setMemory({});
    setErrors({});
  }, [open, presetTask, presetService, presetSubtask]);

  const needService = task?.service === "*";
  const serviceName = needService ? service : task?.service ?? "";
  const svc = services?.find((s) => s.name === serviceName);
  /** 任务限定的环境，再去掉服务在其中停用的环境 */
  // health[env].enabled 已经算上了服务整体停用（服务停用 = 每个环境都不收运行）
  const allowedEnvs = useMemo(() => (envs ?? []).filter((e) =>
    (!task?.envs.length || task.envs.includes(e.name)) && svc?.health[e.name]?.enabled !== false), [envs, task, svc]);
  const preferredEnv = () => (allowedEnvs.find((e) => e.name === globalEnv) ?? allowedEnvs.find((e) => !e.protected) ?? allowedEnvs[0])?.name ?? "";
  /** 依赖用名字串而不是数组：任务 / 服务列表后台刷新（比如切回窗口）会换新对象，不能因此把填了一半的表单清掉 */
  const allowedKey = allowedEnvs.map((e) => e.name).join(",");
  // 打开或换了任务：环境回到首选，输入回到默认值（后端没写默认值的字段 default 是 null）
  useEffect(() => {
    if (!open || !task) return;
    setEnv(preferredEnv());
    const init: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(task.input)) if (f.default != null) init[k] = f.default;
    setValues(init);
  }, [open, task?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  // 可选环境变了（换了服务、环境列表到了）：当前选的还能用就留着
  useEffect(() => {
    setEnv((cur) => (allowedEnvs.some((e) => e.name === cur) ? cur : preferredEnv()));
  }, [allowedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: subtasks } = useSubtasks(task && !task.extends ? task.name : "");
  const subtaskOptions = (subtasks ?? []).map((t) => ({ value: t.name.split(":")[1], label: t.name.split(":")[1], hint: t.title || undefined }));
  const envMeta = envs?.find((e) => e.name === env);

  const submit = useMutation(async () => {
    if (!task) return;
    const errs: Record<string, string> = {};
    for (const [k, f] of Object.entries(task.input)) {
      const v = values[k];
      if (f.required && (v == null || (typeof v === "string" && !v.trim()))) errs[k] = "必填";
      if (f.type === "json" && typeof v === "string" && v.trim()) { try { JSON.parse(v); } catch { errs[k] = "不是合法 JSON"; } }
      if (f.type === "int" && v !== undefined && v !== "" && !Number.isInteger(Number(v))) errs[k] = "需要整数";
    }
    if (needService && !service) errs.__service = "通用任务需要选择服务";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    // 填了又清空的字段不发：否则整数会变成 0、JSON 变成 null，agent 的任务说明里多出"字段: null"
    const input = Object.fromEntries(Object.entries(values)
      .filter(([, v]) => v != null && !(typeof v === "string" && !v.trim()))
      .map(([k, v]) => {
        const f = task.input[k];
        if (f?.type === "int") return [k, Number(v)];
        if (f?.type === "json" && typeof v === "string") return [k, JSON.parse(v)];
        return [k, v];
      }));
    try {
      const res = await api.submitRun({ task: taskName || undefined, service: needService ? service : null, env, subtask: subtask || null, input, memory });
      invalidate("runs");
      invalidate("tasks");
      onClose();
      if (res.subtask_created) toast("已自动创建子任务", { description: `${res.subtask_created}（继承父任务，档案待补全）` });
      if (res.dedup) toast.info("命中去重，复用已有运行", res.run_id.slice(0, 8));
      else toast("已开始运行", { description: res.run_id.slice(0, 8) });
      navigate(`/runs/${res.run_id}`);
    } catch (e) {
      toast.error("提交被拒绝", (e as Error).message);
    }
  });

  return (
    <Dialog open={open} onClose={onClose} size="lg" title="运行任务" description="与 API / SDK 调用走同一条提交路径，闸门链、去重全部生效；不选任务就是通用入口「问一下」"
      footer={<>
        <span className="mr-auto text-xs text-fg-3">{task ? `超时 ${seconds(task.timeout_s)} · 结果${deliverLabel(task)}` : ""}</span>
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon={<LuPlay />} disabled={!task || !env} loading={submit.pending} onClick={() => void submit.mutate(undefined)}>运行</Button>
      </>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="任务" required={!!presetTask} className={cn(presetTask && "col-span-2")}
            help={!presetTask && !taskName ? "不选 = 通用入口「问一下」（ask）：直接提问或交代一件事" : undefined}>
            {presetTask ? (
              <div className="flex h-8 items-center rounded-md border border-line bg-sunken px-2.5 text-[13px]">{task?.title || presetTask}<span className="ml-2 font-mono text-xs text-fg-3">{presetTask}</span></div>
            ) : (
              <SearchSelect value={taskName || null} onChange={(v) => { setTaskName(v); setSubtask(""); }} placeholder="不选 = 问一下（ask）"
                options={runnable.map((t) => ({ value: t.name, label: t.title || t.name, hint: t.name === ASK_TASK ? "ask · 通用入口" : `${t.name} · ${t.service === "*" ? "通用" : t.service ?? "平台"}` }))} />
            )}
          </Field>
          {!presetTask && <div />}
          {needService && (
            <Field label="服务" required error={errors.__service}>
              <Select value={service || null} onChange={setService} placeholder="选择服务"
                options={(services ?? []).filter((s) => s.enabled).map((s) => ({ value: s.name, label: s.title, hint: s.name }))} />
            </Field>
          )}
          <Field label="环境" required help={task?.envs.length ? `该任务只能跑在：${task.envs.join("、")}` : undefined}>
            {task && !allowedEnvs.length && <div className="text-[12.5px] text-bad">没有可用环境：{serviceName} 在任务允许的环境里都已停用</div>}
            <div className="flex flex-wrap gap-1.5">
              {allowedEnvs.map((e) => (
                <button key={e.name} type="button" onClick={() => setEnv(e.name)}
                  className={cn("inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 transition-colors", env === e.name ? "border-accent bg-accent-soft" : "border-line bg-panel hover:bg-hover")}>
                  <EnvBadge env={e.name} />
                  <span className="text-[12.5px] text-fg-2">{e.title}</span>
                </button>
              ))}
            </div>
          </Field>
        </div>

        {envMeta?.protected && (
          <div className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
            <LuShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>{envMeta.title}（{envMeta.name}）是受保护环境：agent 跑在这个环境的部署主机上，读的是线上代码、查的是这个环境的库（只读账号），注意别影响线上。</span>
          </div>
        )}

        {task && task.form !== "builtin" && (
          <Field label="对象（子任务，可选）" help="针对某个具体对象运行：带上它的专属档案，记忆也归到它名下。输入新名字会继承父任务自动创建。">
            <CreatableSelect value={subtask} onChange={setSubtask} options={subtaskOptions} validate={objectNameError}
              placeholder={`${task.name} 的对象，如 ${task.service === "vision-dagster" ? "dws_account_pnl_daily" : "某个资产或报表"}`} />
          </Field>
        )}

        {task && Object.keys(task.input).length > 0 && (
          <div className="space-y-3 rounded-lg border border-line bg-sunken/50 p-3.5">
            <div className="text-[11.5px] font-semibold uppercase tracking-wider text-fg-3">输入</div>
            {Object.entries(task.input).map(([k, f]) => (
              <InputControl key={k} name={k} field={f} value={values[k]} error={errors[k]} onChange={(v) => setValues((s) => ({ ...s, [k]: v }))} />
            ))}
          </div>
        )}

        {task && task.form !== "builtin" && <MemoryToggles task={task} value={memory} onChange={setMemory} />}
      </div>
    </Dialog>
  );
}

const deliverLabel = (t: TaskSummary) => t.deliver?.channel ? `推送到 ${t.deliver.channel}` : t.deliver?.url ? "HTTP 回调" : "页面查看";

/** 这一次运行的记忆开关：默认跟随任务 / 平台，只在想要不同的时候改 */
function MemoryToggles({ task, value, onChange }: { task: TaskSummary; value: MemoryOverride; onChange: (v: MemoryOverride) => void }) {
  const { data: settings } = useSettings();
  const inherited = (key: "recall" | "save") => task.memory?.[key] ?? settings?.memory[key] ?? true;
  const item = (key: "recall" | "save", label: string) => {
    const v = value[key];
    return (
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] text-fg-2">{label}</span>
        <Segmented size="sm" value={v === undefined || v === null ? "inherit" : v ? "on" : "off"}
          onChange={(m) => onChange({ ...value, [key]: m === "inherit" ? null : m === "on" })}
          options={[{ value: "inherit", label: `默认（${inherited(key) ? "开" : "关"}）` }, { value: "on", label: "开" }, { value: "off", label: "关" }]} />
      </div>
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-3">
      <span className="text-[11.5px] font-semibold uppercase tracking-wider text-fg-3">记忆</span>
      {item("recall", "召回")}
      {item("save", "沉淀")}
    </div>
  );
}

function InputControl({ name, field, value, error, onChange }: { name: string; field: InputField; value: unknown; error?: string; onChange: (v: unknown) => void }) {
  const label = <span className="font-mono">{name}</span>;
  if (field.type === "bool") return <Switch checked={!!value} onChange={onChange} label={<>{label}{field.description && <span className="ml-2 text-xs text-fg-3">{field.description}</span>}</>} />;
  if (field.type === "enum") return (
    <Field label={label} help={field.description} required={field.required} error={error}>
      <Select value={(value as string) ?? null} onChange={onChange} options={(field.options ?? []).map((o) => ({ value: o, label: o }))} />
    </Field>
  );
  if (field.type === "text" || field.type === "json") return (
    <Field label={label} help={field.description} required={field.required} error={error}>
      <Textarea mono={field.type === "json"} rows={field.type === "json" ? 5 : 3} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} placeholder={field.type === "json" ? "{ }" : undefined} />
    </Field>
  );
  return (
    <Field label={label} help={field.description} required={field.required} error={error}>
      <Input value={(value as string) ?? ""} inputMode={field.type === "int" ? "numeric" : undefined} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} />
    </Field>
  );
}
