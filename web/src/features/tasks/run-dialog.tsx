/**
 * 「运行任务」对话框：手动跑一次任务。选任务 → 服务（通用任务）→ 环境 → 按任务输入生成的表单。
 * 在子任务（某个对象）上打开时，用的是子任务合并后的定义，对象固定；任务声明了对象字段（如 asset_key）时，
 * 对象就从这个字段里选，不用填两遍。提交走 POST /v1/runs，成功后跳到运行详情。
 */
import { useEffect, useMemo, useState } from "react";
import { LuChevronDown, LuChevronRight, LuPlay, LuShieldCheck, LuX } from "react-icons/lu";

import { api, useEnvs, useRuns, useServices, useSettings, useSubtasks, useTasks } from "@/api/hooks";
import type { MemoryOverride, TaskSummary } from "@/api/types";
import { EnvBadge, RUN_STATUS } from "@/components/status";
import { Button } from "@/components/ui/button";
import { CreatableSelect, Field, SearchSelect, Segmented, Select, Textarea, objectNameError } from "@/components/ui/form";
import { Dialog, toast } from "@/components/ui/overlay";
import { cn } from "@/lib/cn";
import { seconds, shortId } from "@/lib/format";
import { invalidate, useMutation } from "@/lib/query";
import { navigate } from "@/lib/router";
import { useUi } from "@/lib/store";
import { InputControl, initialValues, inputErrors, inputValue } from "./input-control";

/** 通用入口：任何服务任何环境直接提问或交代一件事，不用先建任务；POST /v1/runs 不填 task 就是它 */
export const ASK_TASK = "ask";

export function RunTaskDialog({ open, onClose, task: presetTask, service: presetService, subtask: presetSubtask, after: presetAfter }: {
  open: boolean; onClose: () => void; task?: string; service?: string; subtask?: string;
  /** 预先点名要等的上游运行（运行详情「等它成功后跑一个任务」）：都成功了才开始 */
  after?: string[];
}) {
  const { data: tasks } = useTasks();
  const { data: services } = useServices();
  const { data: envs } = useEnvs();
  const { env: globalEnv } = useUi();

  /** 能选的任务：启用的父任务（内建任务也能手动跑），通用入口排第一 */
  const runnable = useMemo(() => (tasks ?? []).filter((t) => !t.extends && t.enabled && (!presetService || t.service === presetService || t.service === "*"))
    .sort((a, b) => Number(b.name === ASK_TASK) - Number(a.name === ASK_TASK)), [tasks, presetService]);
  const [taskName, setTaskName] = useState(presetTask ?? "");
  const baseName = taskName || ASK_TASK;
  const base: TaskSummary | undefined = tasks?.find((t) => t.name === baseName);
  const [service, setService] = useState(presetService ?? "");
  const [env, setEnv] = useState("");
  const [object, setObject] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [memory, setMemory] = useState<MemoryOverride>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [more, setMore] = useState(false);
  const [deps, setDeps] = useState<string[]>([]);
  const afterKey = (presetAfter ?? []).join(",");

  useEffect(() => {
    if (!open) return;
    setTaskName(presetTask ?? "");
    setService(presetService ?? "");
    setObject(presetSubtask ?? "");
    setMemory({});
    setErrors({});
    setMore(false);
    setDeps(presetAfter ?? []);
  }, [open, presetTask, presetService, presetSubtask, afterKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 能点名等的：还没结束的运行（成功了的不用等，失败了的点名会被拒）
  const { data: runningRuns } = useRuns({ status: "running", limit: 30 }, { enabled: open });
  const { data: queuedRuns } = useRuns({ status: "queued", limit: 30 }, { enabled: open });
  const depOptions = [...(runningRuns?.items ?? []), ...(queuedRuns?.items ?? [])].filter((r) => !deps.includes(r.run_id))
    .map((r) => ({ value: r.run_id, label: `${r.task_title || r.task} · ${r.summary}`.slice(0, 80), hint: `${shortId(r.run_id)} · ${r.env} · ${RUN_STATUS[r.status].label}` }));

  const objectField = base?.form === "agent" ? base.object_input ?? null : null;
  /** 选中的对象：子任务页上固定；有对象字段时就是那个字段的值 */
  const chosen = presetSubtask || (objectField ? String(values[objectField] ?? "").trim() : object);
  /** 对象已经有子任务：用它合并后的定义（环境、输入、投递可能和父任务不同） */
  const sub = chosen ? tasks?.find((t) => t.name === `${baseName}:${chosen}`) : undefined;
  const def = sub ?? base;

  const needService = def?.service === "*";
  const serviceName = needService ? service : def?.service ?? "";
  const svc = services?.find((s) => s.name === serviceName);
  /** 任务允许的环境里，去掉服务在其中停用的 */
  const taskEnvs = useMemo(() => (envs ?? []).filter((e) => !def?.envs.length || def.envs.includes(e.name)), [envs, def]);
  const allowedEnvs = taskEnvs.filter((e) => svc?.health[e.name]?.enabled !== false);
  const offEnvs = taskEnvs.filter((e) => svc?.health[e.name]?.enabled === false);
  const preferredEnv = () => (allowedEnvs.find((e) => e.name === globalEnv) ?? allowedEnvs.find((e) => !e.protected) ?? allowedEnvs[0])?.name ?? "";
  /** 依赖用名字串：列表后台刷新会换新对象，不能因此把填了一半的表单清掉 */
  const allowedKey = allowedEnvs.map((e) => e.name).join(",");
  // 打开或换了任务：环境回到首选，输入回到默认值
  useEffect(() => {
    if (!open || !base) return;
    setEnv(preferredEnv());
    const init = initialValues(base.input);
    if (presetSubtask && base.object_input) init[base.object_input] = presetSubtask;
    setValues(init);
    setErrors({});
  }, [open, base?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setEnv((cur) => (allowedEnvs.some((e) => e.name === cur) ? cur : preferredEnv()));
  }, [allowedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: subtasks } = useSubtasks(base && base.form === "agent" && base.name !== ASK_TASK ? base.name : "");
  const objectOptions = (subtasks ?? []).map((t) => ({ value: t.name.split(":")[1], label: t.name.split(":")[1], hint: t.overrides.includes("title") ? t.title : undefined }));
  const envMeta = envs?.find((e) => e.name === env);
  const fields = def?.input ?? {};
  /** 没有 question 字段的 agent 任务：给一个补充说明框（发成 input.question，agent 会看到） */
  const note = def?.form === "agent" && !("question" in fields);
  const showObjectPicker = !presetSubtask && !objectField && base?.form === "agent" && base.name !== ASK_TASK;

  const submit = useMutation(async () => {
    if (!def || !base) return;
    const errs = inputErrors(fields, values);
    if (needService && !service) errs.__service = "选择服务";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    // 填了又清空的字段不发：否则整数会变成 0、JSON 变成 null，agent 的任务说明里多出"字段: null"
    const input: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      const val = inputValue(fields[k], v);
      if (val !== undefined) input[k] = val;
    }
    try {
      const res = await api.submitRun({
        task: taskName || undefined, service: needService ? service : null, env,
        subtask: presetSubtask || (showObjectPicker && object ? object : null), input, memory,
        after: deps.length ? deps : undefined,
      });
      invalidate("runs");
      invalidate("tasks");
      onClose();
      if (res.subtask_created) toast("新对象已加入子任务", { description: `${res.subtask_created}：以后可以给它写专属档案` });
      if (res.dedup) toast.info("和刚才的一次运行重复，直接用它的结果", res.run_id.slice(0, 8));
      else if (deps.length) toast("已排队", { description: `等 ${deps.length} 个上游运行成功后开始 · ${res.run_id.slice(0, 8)}` });
      else toast("已开始运行", { description: res.run_id.slice(0, 8) });
      navigate(`/runs/${res.run_id}`);
    } catch (e) {
      toast.error("没能开始运行", (e as Error).message);
    }
  });

  const title = presetSubtask ? `运行 ${presetSubtask}` : base && presetTask ? `运行 ${base.title || base.name}` : "运行任务";
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={title}
      description={presetSubtask && base ? <>{base.title || base.name} · 这个对象的档案和记忆会一起带上</> : !presetTask ? "手动跑一次；不选任务就是「问一下」：直接提问或交代一件事" : undefined}
      footer={<>
        <span className="mr-auto text-xs text-fg-3">{def ? `${def.form === "builtin" ? "内建作业" : "最长"} ${seconds(def.timeout_s)} · ${deliverLabel(def)}` : ""}</span>
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon={<LuPlay />} disabled={!def || !env} loading={submit.pending} onClick={() => void submit.mutate(undefined)}>运行</Button>
      </>}>
      <div className="space-y-4">
        {!presetTask && (
          <Field label="任务">
            <SearchSelect value={taskName || null} onChange={(v) => { setTaskName(v); setObject(""); }} placeholder="不选 = 问一下"
              options={runnable.map((t) => ({ value: t.name, label: t.title || t.name, hint: t.name === ASK_TASK ? "直接提问或交代一件事" : `${t.service === "*" ? "通用" : t.service ?? "平台任务"} · ${t.name}` }))} />
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {needService && (
            <Field label="服务" required error={errors.__service}>
              <Select value={service || null} onChange={setService} placeholder="在哪个服务上跑"
                options={(services ?? []).filter((s) => s.enabled).map((s) => ({ value: s.name, label: s.title, hint: s.name }))} />
            </Field>
          )}
          <Field label="环境" required className={cn(!needService && "sm:col-span-2")}
            help={offEnvs.length ? `${offEnvs.map((e) => e.title || e.name).join("、")}：${serviceName} 在那里已停用` : undefined}>
            {def && !allowedEnvs.length ? <div className="text-[12.5px] text-bad">没有能跑的环境：{needService && !service ? "先选服务" : `${serviceName} 在任务允许的环境里都已停用`}</div> : (
              <div className="flex flex-wrap gap-1.5">
                {allowedEnvs.map((e) => (
                  <button key={e.name} type="button" onClick={() => setEnv(e.name)} aria-pressed={env === e.name}
                    className={cn("inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 transition-colors", env === e.name ? "border-accent bg-accent-soft" : "border-line bg-panel hover:bg-hover")}>
                    <EnvBadge env={e.name} /><span className="text-[12.5px] text-fg-2">{e.title}</span>
                  </button>
                ))}
              </div>
            )}
          </Field>
        </div>

        {envMeta?.protected && (
          <div className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
            <LuShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>{envMeta.title}是线上环境：读的是线上代码，查的是这个环境的库（只读账号）。{def?.deliver ? `结论会${deliverLabel(def)}。` : ""}</span>
          </div>
        )}

        {def && (Object.keys(fields).length > 0 || note || showObjectPicker) && (
          <div className="space-y-3 rounded-lg border border-line bg-sunken/40 p-3.5">
            {Object.entries(fields).map(([k, f]) => (
              <InputControl key={k} name={k} field={f} value={values[k]} error={errors[k]} onChange={(v) => setValues((s) => ({ ...s, [k]: v }))}
                objects={k === objectField && !presetSubtask ? objectOptions : undefined} locked={k === objectField && !!presetSubtask} />
            ))}
            {showObjectPicker && (
              <Field label="针对某个对象（可选）" help="一张表、一个报表、一个资产：会带上它的专属档案，记下的东西也归到它名下；输入新名字就新建一个">
                <CreatableSelect value={object} onChange={setObject} options={objectOptions} validate={objectNameError} createLabel="新对象" placeholder="不指定" />
              </Field>
            )}
            {note && (
              <Field label="补充说明（可选）" help="这次想让 agent 特别注意什么；会附在任务说明后面">
                <Textarea rows={2} value={(values.question as string) ?? ""} onChange={(e) => setValues((s) => ({ ...s, question: e.target.value }))} />
              </Field>
            )}
          </div>
        )}

        {(presetAfter?.length ?? 0) > 0 && <AfterRuns value={deps} onChange={setDeps} options={depOptions} />}

        {def && (
          <div className="border-t border-line pt-3">
            <button type="button" onClick={() => setMore(!more)} className="flex items-center gap-1 text-[12.5px] text-fg-3 hover:text-fg">
              {more ? <LuChevronDown className="size-3.5" /> : <LuChevronRight className="size-3.5" />}更多选项
              {!more && (memory.recall != null || memory.save != null || (!presetAfter?.length && deps.length > 0)) && <span className="ml-1 text-accent">（已改）</span>}
            </button>
            {more && (
              <div className="mt-2.5 space-y-3 pl-4">
                {def.form === "agent" && <MemoryToggles task={def} value={memory} onChange={setMemory} />}
                {!presetAfter?.length && <AfterRuns value={deps} onChange={setDeps} options={depOptions} />}
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

const deliverLabel = (t: TaskSummary) => t.deliver?.channel ? `推送到 ${t.deliver.channel}` : t.deliver?.url ? "回调到业务方" : "结果在运行详情里看";

/** 这一次运行的记忆开关：默认跟随任务 / 平台，只在想要不同的时候改 */
function MemoryToggles({ task, value, onChange }: { task: TaskSummary; value: MemoryOverride; onChange: (v: MemoryOverride) => void }) {
  const { data: settings } = useSettings();
  const inherited = (key: "recall" | "save") => task.memory?.[key] ?? settings?.memory[key];
  const item = (key: "recall" | "save", label: string, hint: string) => {
    const v = value[key];
    const dflt = inherited(key);
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-10 text-[12.5px] text-fg-2">{label}</span>
        <Segmented size="sm" value={v === undefined || v === null ? "inherit" : v ? "on" : "off"}
          onChange={(m) => onChange({ ...value, [key]: m === "inherit" ? null : m === "on" })}
          options={[{ value: "inherit", label: dflt === undefined ? "默认" : `默认（${dflt ? "开" : "关"}）` }, { value: "on", label: "开" }, { value: "off", label: "关" }]} />
        <span className="text-[11.5px] text-fg-3">{hint}</span>
      </div>
    );
  };
  return (
    <div className="space-y-2">
      {item("recall", "召回", "运行前查以前记下的事实和方法")}
      {item("save", "沉淀", "运行成功后把结论记下来")}
    </div>
  );
}

/** 点名等的上游运行（POST /v1/runs 的 after）：都成功了才开始，有一个失败 / 取消这次就不执行 */
function AfterRuns({ value, onChange, options }: { value: string[]; onChange: (v: string[]) => void; options: { value: string; label: string; hint: string }[] }) {
  return (
    <Field label="等这些运行成功后再开始（可选）" help="先排着队，点名的运行都成功了才执行；有一个失败或被取消，这次就不执行（upstream_failed）。可以粘贴运行 id">
      <div className="space-y-2">
        {value.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {value.map((id) => (
              <span key={id} className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-sunken/60 pl-2 pr-1 font-mono text-[12px] text-fg-2">
                {shortId(id)}
                <button type="button" aria-label={`不等 ${id}`} onClick={() => onChange(value.filter((x) => x !== id))} className="rounded p-0.5 text-fg-3 hover:bg-hover hover:text-fg"><LuX className="size-3.5" /></button>
              </span>
            ))}
          </div>
        )}
        <CreatableSelect key={value.join(",")} value="" onChange={(v) => v && !value.includes(v) && onChange([...value, v.trim()])} options={options}
          placeholder={options.length ? "选一个还在跑的运行，或粘贴运行 id…" : "粘贴运行 id…"} createLabel="等它"
          validate={(v) => (/^[0-9a-f]{8,64}$/i.test(v.trim()) ? null : "运行 id 是十六进制串")} />
      </div>
    </Field>
  );
}
