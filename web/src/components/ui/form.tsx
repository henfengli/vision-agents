/**
 * 表单件：统一高度/边框/焦点样式。Select 用 Headless UI Listbox（可搜索的用 Combobox 版 SearchSelect）。
 */
import {
  Combobox, ComboboxInput, ComboboxOption, ComboboxOptions, Listbox, ListboxButton, ListboxOption, ListboxOptions,
  Switch as HSwitch,
} from "@headlessui/react";
import { forwardRef, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from "react";
import { LuCheck, LuChevronDown, LuSearch, LuX } from "react-icons/lu";

import { cn } from "@/lib/cn";

const control = "w-full rounded-md border border-line bg-panel text-[13px] text-fg placeholder:text-fg-3 shadow-[var(--shadow-card)] transition-[border,box-shadow] hover:border-line-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-[color-mix(in_oklab,var(--color-accent)_18%,transparent)] disabled:opacity-60 aria-[invalid=true]:border-bad";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; prefixIcon?: ReactNode }>(
  function Input({ className, mono, prefixIcon, ...p }, ref) {
    if (prefixIcon) {
      return (
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3 [&_svg]:size-3.5">{prefixIcon}</span>
          <input ref={ref} className={cn(control, "h-8 pl-8 pr-2.5", mono && "font-mono text-[12.5px]", className)} {...p} />
        </div>
      );
    }
    return <input ref={ref} className={cn(control, "h-8 px-2.5", mono && "font-mono text-[12.5px]", className)} {...p} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(
  function Textarea({ className, mono, rows = 4, ...p }, ref) {
    return <textarea ref={ref} rows={rows} className={cn(control, "block px-2.5 py-2 leading-relaxed", mono && "font-mono text-[12.5px]", className)} {...p} />;
  },
);

export function Field({ label, help, error, children, className, required, aside }: {
  label?: ReactNode; help?: ReactNode; error?: string | null; children: ReactNode; className?: string; required?: boolean; aside?: ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      {label && (
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label className="text-[12.5px] font-medium text-fg">{label}{required && <span className="ml-0.5 text-bad">*</span>}</label>
          {aside}
        </div>
      )}
      {children}
      {error ? <div className="mt-1 text-xs text-bad">{error}</div> : help ? <div className="mt-1 text-xs leading-relaxed text-fg-3">{help}</div> : null}
    </div>
  );
}

export interface Option<T extends string = string> {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
}

export function Select<T extends string>({ value, onChange, options, placeholder = "请选择", className, size = "md", disabled }: {
  value: T | null | undefined; onChange: (v: T) => void; options: Option<T>[]; placeholder?: string; className?: string; size?: "sm" | "md"; disabled?: boolean;
}) {
  const cur = options.find((o) => o.value === value);
  return (
    <Listbox value={value ?? null} onChange={(v) => v !== null && onChange(v as T)} disabled={disabled}>
      <ListboxButton className={cn(control, "flex items-center gap-2 text-left", size === "sm" ? "h-7 px-2 text-[12.5px]" : "h-8 px-2.5", className)}>
        {cur?.icon}
        <span className={cn("min-w-0 flex-1 truncate", !cur && "text-fg-3")}>{cur ? cur.label : placeholder}</span>
        <LuChevronDown className="size-3.5 shrink-0 text-fg-3" />
      </ListboxButton>
      <ListboxOptions anchor={{ to: "bottom start", gap: 4 }} transition
        className="z-50 max-h-72 w-[var(--button-width)] min-w-44 overflow-auto rounded-lg border border-line bg-raised p-1 shadow-[var(--shadow-pop)] outline-none transition duration-100 data-[closed]:opacity-0 data-[closed]:-translate-y-1">
        {options.map((o) => (
          <ListboxOption key={o.value} value={o.value}
            className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-fg data-[focus]:bg-hover">
            {o.icon}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{o.label}</span>
              {o.hint && <span className="block truncate text-xs text-fg-3">{o.hint}</span>}
            </span>
            <LuCheck className="invisible size-3.5 text-accent group-data-[selected]:visible" />
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}

/** 筛选条上的紧凑下拉：带"全部"项 */
export function FilterSelect({ value, onChange, options, allLabel, label }: {
  value: string; onChange: (v: string) => void; options: Option[]; allLabel: string; label?: string;
}) {
  const all: Option[] = [{ value: "", label: allLabel }, ...options];
  const cur = all.find((o) => o.value === value) ?? all[0];
  return (
    <Listbox value={value} onChange={onChange}>
      <ListboxButton className={cn("inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12.5px] transition-colors",
        value ? "border-accent/40 bg-accent-soft text-accent" : "border-line bg-panel text-fg-2 hover:bg-hover")}>
        {label && <span className={cn(value ? "text-accent/70" : "text-fg-3")}>{label}</span>}
        <span className="max-w-40 truncate font-medium">{cur.label}</span>
        <LuChevronDown className="size-3 opacity-60" />
      </ListboxButton>
      <ListboxOptions anchor={{ to: "bottom start", gap: 4 }} transition
        className="z-50 max-h-80 min-w-44 overflow-auto rounded-lg border border-line bg-raised p-1 shadow-[var(--shadow-pop)] outline-none transition duration-100 data-[closed]:opacity-0">
        {all.map((o) => (
          <ListboxOption key={o.value} value={o.value} className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] data-[focus]:bg-hover">
            {o.icon}
            <span className="flex-1 truncate">{o.label}</span>
            {o.hint && <span className="text-xs text-fg-3">{o.hint}</span>}
            <LuCheck className="invisible size-3.5 text-accent group-data-[selected]:visible" />
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}

export function SearchSelect<T extends string>({ value, onChange, options, placeholder = "搜索…", className }: {
  value: T | null; onChange: (v: T) => void; options: Option<T>[]; placeholder?: string; className?: string;
}) {
  const [query, setQuery] = useState("");
  const filtered = query ? options.filter((o) => String(o.value).toLowerCase().includes(query.toLowerCase()) || String(o.label).toLowerCase().includes(query.toLowerCase())) : options;
  return (
    <Combobox value={value} onChange={(v) => v && onChange(v as T)} onClose={() => setQuery("")}>
      <div className={cn("relative", className)}>
        <ComboboxInput className={cn(control, "h-8 pl-2.5 pr-7")} placeholder={placeholder}
          displayValue={(v: T | null) => (v ? String(options.find((o) => o.value === v)?.label ?? v) : "")}
          onChange={(e) => setQuery(e.target.value)} />
        <LuChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
      </div>
      <ComboboxOptions anchor={{ to: "bottom start", gap: 4 }}
        className="z-50 max-h-72 w-[var(--input-width)] overflow-auto rounded-lg border border-line bg-raised p-1 shadow-[var(--shadow-pop)] empty:invisible">
        {filtered.map((o) => (
          <ComboboxOption key={o.value} value={o.value} className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] data-[focus]:bg-hover">
            <span className="min-w-0 flex-1">
              <span className="block truncate">{o.label}</span>
              {o.hint && <span className="block truncate text-xs text-fg-3">{o.hint}</span>}
            </span>
            <LuCheck className="invisible size-3.5 text-accent group-data-[selected]:visible" />
          </ComboboxOption>
        ))}
      </ComboboxOptions>
    </Combobox>
  );
}

/**
 * 可新建的选择：从已有项里选，或直接输入一个新值（下拉里出现"新建：xxx"）。
 * 空字符串表示"不选"。用于子任务对象名这类"有就选、没有就建"的字段。
 */
export function CreatableSelect({ value, onChange, options, placeholder = "选择或输入…", createLabel = "新建", className, validate }: {
  value: string; onChange: (v: string) => void; options: Option[]; placeholder?: string; createLabel?: string; className?: string;
  validate?: (v: string) => string | null;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim();
  const filtered = q ? options.filter((o) => o.value.toLowerCase().includes(q.toLowerCase()) || String(o.label).toLowerCase().includes(q.toLowerCase())) : options;
  const exists = options.some((o) => o.value === q);
  const invalid = q && !exists ? validate?.(q) ?? null : null;
  return (
    <Combobox value={value} onChange={(v: string | null) => onChange(v ?? "")} onClose={() => setQuery("")}>
      <div className={cn("relative", className)}>
        <ComboboxInput className={cn(control, "h-8 pl-2.5 pr-12 font-mono text-[12.5px]")} placeholder={placeholder}
          displayValue={(v: string) => v} onChange={(e) => setQuery(e.target.value)} />
        {value && (
          <button type="button" aria-label="清除" onClick={() => onChange("")} className="absolute right-7 top-1/2 -translate-y-1/2 rounded p-0.5 text-fg-3 hover:text-fg">
            <LuX className="size-3.5" />
          </button>
        )}
        <LuChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
      </div>
      <ComboboxOptions anchor={{ to: "bottom start", gap: 4 }}
        className="z-50 max-h-72 w-[var(--input-width)] overflow-auto rounded-lg border border-line bg-raised p-1 shadow-[var(--shadow-pop)] empty:invisible">
        {q && !exists && (invalid
          ? <div className="px-2 py-1.5 text-xs text-bad">{invalid}</div>
          : (
            <ComboboxOption value={q} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] data-[focus]:bg-hover">
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">{createLabel}</span>
              <span className="truncate font-mono text-[12.5px]">{q}</span>
            </ComboboxOption>
          ))}
        {filtered.map((o) => (
          <ComboboxOption key={o.value} value={o.value} className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] data-[focus]:bg-hover">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[12.5px]">{o.label}</span>
              {o.hint && <span className="block truncate text-xs text-fg-3">{o.hint}</span>}
            </span>
            <LuCheck className="invisible size-3.5 text-accent group-data-[selected]:visible" />
          </ComboboxOption>
        ))}
      </ComboboxOptions>
    </Combobox>
  );
}

/** 子任务对象名的合法性（与后端 OBJECT_NAME_RE 一致） */
export function objectNameError(v: string): string | null {
  if (v.length > 120) return "不超过 120 个字符";
  if (/[:\s/\\]/.test(v)) return "不能含冒号、空白或斜杠";
  return null;
}

export function Switch({ checked, onChange, label, disabled, size = "md" }: {
  checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; size?: "sm" | "md";
}) {
  return (
    <label className={cn("inline-flex items-center gap-2", disabled ? "opacity-60" : "cursor-pointer")}>
      <HSwitch checked={checked} onChange={onChange} disabled={disabled}
        className={cn("group relative inline-flex shrink-0 items-center rounded-full border border-transparent bg-line-strong transition-colors data-[checked]:bg-accent",
          size === "sm" ? "h-4 w-7" : "h-5 w-9")}>
        <span className={cn("inline-block rounded-full bg-white shadow transition-transform",
          size === "sm" ? "size-3 translate-x-0.5 group-data-[checked]:translate-x-3.5" : "size-4 translate-x-0.5 group-data-[checked]:translate-x-4")} />
      </HSwitch>
      {label && <span className="text-[13px] text-fg">{label}</span>}
    </label>
  );
}

export function Checkbox({ checked, onChange, label, hint, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean;
}) {
  return (
    <label className={cn("flex items-start gap-2 rounded-md py-1", disabled ? "opacity-60" : "cursor-pointer")}>
      <span className={cn("mt-[2px] flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
        checked ? "border-accent bg-accent text-white" : "border-line-strong bg-panel")}>
        {checked && <LuCheck className="size-3" strokeWidth={3} />}
      </span>
      <input type="checkbox" className="sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="block text-[13px] text-fg">{label}</span>
        {hint && <span className="block text-xs text-fg-3">{hint}</span>}
      </span>
    </label>
  );
}

/** 分段选择（小选项集合的单选） */
export function Segmented<T extends string>({ value, onChange, options, size = "md", className }: {
  value: T; onChange: (v: T) => void; options: Option<T>[]; size?: "sm" | "md"; className?: string;
}) {
  return (
    <div className={cn("inline-flex rounded-md border border-line bg-sunken p-0.5", className)}>
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={cn("inline-flex items-center gap-1.5 rounded-[5px] font-medium transition-colors [&_svg]:size-3.5",
            size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-2.5 text-[12.5px]",
            o.value === value ? "bg-panel text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-fg-3 hover:text-fg")}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}

/** 标签输入：回车/逗号添加，退格删除最后一个 */
export function TagInput({ value, onChange, placeholder, suggestions = [], mono }: {
  value: string[]; onChange: (v: string[]) => void; placeholder?: string; suggestions?: string[]; mono?: boolean;
}) {
  const [text, setText] = useState("");
  const add = (t: string) => {
    const v = t.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(text); }
    else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
  };
  const rest = suggestions.filter((s) => !value.includes(s));
  return (
    <div>
      <div className={cn(control, "flex min-h-8 flex-wrap items-center gap-1 px-1.5 py-1")}>
        {value.map((v) => (
          <span key={v} className={cn("inline-flex h-5 items-center gap-1 rounded bg-sunken px-1.5 text-xs text-fg", mono && "font-mono")}>
            {v}
            <button type="button" aria-label={`移除 ${v}`} className="text-fg-3 hover:text-fg" onClick={() => onChange(value.filter((x) => x !== v))}><LuX className="size-3" /></button>
          </span>
        ))}
        <input className={cn("h-6 min-w-24 flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-fg-3", mono && "font-mono text-[12.5px]")}
          value={text} placeholder={value.length ? "" : placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={() => text && add(text)} />
      </div>
      {rest.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {rest.map((s) => (
            <button key={s} type="button" onClick={() => onChange([...value, s])}
              className={cn("h-5 rounded border border-dashed border-line px-1.5 text-xs text-fg-3 hover:border-accent hover:text-accent", mono && "font-mono")}>+ {s}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = "搜索…", className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={cn("relative", className)}>
      <LuSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        className={cn(control, "h-7 pl-8 pr-7 text-[12.5px]")} />
      {value && (
        <button type="button" aria-label="清除搜索" onClick={() => onChange("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-fg-3 hover:bg-hover hover:text-fg">
          <LuX className="size-3.5" />
        </button>
      )}
    </div>
  );
}
