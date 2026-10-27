/**
 * 按任务的输入定义生成的表单控件：运行对话框、定时的固定输入共用。
 * 值的形状与后端 TaskDef.validate_input 一致：int 发数字、bool 发 true/false、json 发解析后的对象。
 */
import type { InputField } from "@/api/types";
import { CreatableSelect, Field, Input, Select, Switch, Textarea, objectNameError } from "@/components/ui/form";
import type { Option } from "@/components/ui/form";

/** 表单里的原始值（输入框里是字符串）→ 要发出去的值；空 = 不发 */
export function inputValue(field: InputField | undefined, v: unknown): unknown {
  if (v == null || (typeof v === "string" && !v.trim())) return undefined;
  if (field?.type === "int") return Number(v);
  if (field?.type === "json" && typeof v === "string") return JSON.parse(v);
  return v;
}

/** 逐字段校验；返回 {字段: 错误} */
export function inputErrors(fields: Record<string, InputField>, values: Record<string, unknown>): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const [k, f] of Object.entries(fields)) {
    const v = values[k] ?? f.default;
    const empty = v == null || (typeof v === "string" && !v.trim());
    // 开关没有"没填"：关就是 false
    if (f.required && empty && f.type !== "bool") { errs[k] = "必填"; continue; }
    if (empty) continue;
    if (f.type === "int" && !/^-?\d+$/.test(String(v).trim())) errs[k] = "要填整数";
    if (f.type === "json" && typeof v === "string") { try { JSON.parse(v); } catch { errs[k] = "不是合法的 JSON"; } }
    if (f.type === "enum" && f.options?.length && !f.options.includes(String(v))) errs[k] = `只能是 ${f.options.join(" / ")}`;
  }
  return errs;
}

/** 表单初值：定义里的默认值（json 转成文本，开关没有默认就是关） */
export function initialValues(fields: Record<string, InputField>, given: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(fields)) {
    const v = k in given ? given[k] : f.default;
    if (v == null) { if (f.type === "bool") out[k] = false; continue; }
    out[k] = f.type === "json" && typeof v !== "string" ? JSON.stringify(v, null, 2) : f.type === "int" ? String(v) : v;
  }
  return out;
}

export function InputControl({ name, field, value, error, onChange, objects, locked }: {
  name: string; field: InputField; value: unknown; error?: string; onChange: (v: unknown) => void;
  /** 这个字段是任务的对象字段：可以从已有对象里选，也可以输入新的 */
  objects?: Option[];
  /** 值由别处决定（比如在子任务页上运行，对象就是这个子任务） */
  locked?: boolean;
}) {
  const label = <span className="font-mono">{name}</span>;
  const help = field.description || undefined;
  const join = (a: string | undefined, b: string) => (a ? `${a} · ${b}` : b);
  if (locked) return (
    <Field label={label} help={join(help, "就是这个子任务的对象")}>
      <div className="flex h-8 items-center rounded-md border border-line bg-sunken px-2.5 font-mono text-[12.5px] text-fg-2">{String(value ?? "")}</div>
    </Field>
  );
  if (objects) {
    // 不能当对象名的值（Dagster 多段 asset key 带斜杠）照样能填：后端把这次运行留在父任务上（object_value）
    const v = String(value ?? "");
    const notObject = v && !objects.some((o) => o.value === v) ? objectNameError(v) : null;
    return (
      <Field label={label} required={field.required} error={error}
        help={notObject ? `这个值不能当对象名（${notObject}）：照样运行，但落在父任务上，不带对象的档案和记忆`
          : join(help, objects.length ? `选已有的对象会带上它的档案和记忆（${objects.length} 个）；输入新的就新建一个` : "输入对象名：第一次出现会新建一个子任务，以后它的档案和记忆归在它名下")}>
        <CreatableSelect value={v} onChange={onChange} options={objects} placeholder="选择或输入…"
          createLabel={(q) => (objectNameError(q) ? "直接用" : "新对象")} />
      </Field>
    );
  }
  if (field.type === "bool") return (
    <Field label={label} help={help} error={error}>
      <Switch checked={!!value} onChange={onChange} label={<span className="text-[12.5px] text-fg-2">{value ? "是" : "否"}</span>} />
    </Field>
  );
  if (field.type === "enum") return (
    <Field label={label} help={help} required={field.required} error={error}>
      <Select value={(value as string) ?? null} onChange={onChange} placeholder="选择…" options={(field.options ?? []).filter(Boolean).map((o) => ({ value: o, label: o }))} />
    </Field>
  );
  if (field.type === "text" || field.type === "json") return (
    <Field label={label} help={help} required={field.required} error={error}>
      <Textarea mono={field.type === "json"} rows={field.type === "json" ? 5 : 3} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error} placeholder={field.type === "json" ? "{ }" : undefined} />
    </Field>
  );
  return (
    <Field label={label} help={help} required={field.required} error={error}>
      <Input value={(value as string) ?? ""} inputMode={field.type === "int" ? "numeric" : undefined} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} />
    </Field>
  );
}
