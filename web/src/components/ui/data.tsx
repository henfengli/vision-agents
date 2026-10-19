/**
 * 数据展示件：Tabs、表格、代码块、Markdown、JSON 视图、键值编辑器、版本 diff、复制按钮。
 */
import { diffLines } from "diff";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo, useState, type ReactNode, type ThHTMLAttributes, type TdHTMLAttributes } from "react";
import { LuArrowDown, LuArrowUp, LuCheck, LuCopy, LuPlus, LuTrash2 } from "react-icons/lu";

import { cn } from "@/lib/cn";
import { Button } from "./button";
import { Tooltip, toast } from "./overlay";

// ———————— Tabs（受控；页面用 URL 参数驱动） ————————

export interface TabDef<T extends string = string> {
  value: T;
  label: ReactNode;
  count?: number | null;
  icon?: ReactNode;
}

export function Tabs<T extends string>({ value, onChange, tabs, className, size = "md" }: {
  value: T; onChange: (v: T) => void; tabs: TabDef<T>[]; className?: string; size?: "sm" | "md";
}) {
  return (
    <div className={cn("flex items-center gap-1 border-b border-line", className)} role="tablist">
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button key={t.value} role="tab" aria-selected={active} type="button" onClick={() => onChange(t.value)}
            className={cn("relative -mb-px inline-flex items-center gap-1.5 border-b-2 font-medium transition-colors [&_svg]:size-3.5",
              size === "sm" ? "h-8 px-2 text-[12.5px]" : "h-9 px-2.5 text-[13px]",
              active ? "border-accent text-fg" : "border-transparent text-fg-3 hover:text-fg")}>
            {t.icon}{t.label}
            {t.count !== undefined && t.count !== null && (
              <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", active ? "bg-accent-soft text-accent" : "bg-sunken text-fg-3")}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ———————— 表格 ————————

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  );
}

export function Th({ className, sort, onSort, children, ...p }: ThHTMLAttributes<HTMLTableCellElement> & { sort?: "asc" | "desc" | null; onSort?: () => void }) {
  return (
    <th className={cn("h-8 border-b border-line bg-sunken/70 px-3 text-left text-[11.5px] font-medium text-fg-3 first:pl-4 last:pr-4 whitespace-nowrap", onSort && "cursor-pointer select-none hover:text-fg", className)}
      onClick={onSort} {...p}>
      <span className="inline-flex items-center gap-1">
        {children}
        {sort === "asc" ? <LuArrowUp className="size-3" /> : sort === "desc" ? <LuArrowDown className="size-3" /> : null}
      </span>
    </th>
  );
}

export function Td({ className, ...p }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("h-11 border-b border-line px-3 py-1.5 align-middle first:pl-4 last:pr-4", className)} {...p} />;
}

export function Tr({ className, onClick, href, children }: { className?: string; onClick?: () => void; href?: string; children: ReactNode }) {
  return (
    <tr className={cn("group transition-colors", (onClick || href) && "cursor-pointer hover:bg-hover/70", className)} onClick={onClick}>
      {children}
    </tr>
  );
}

// ———————— 复制 ————————

export function CopyButton({ text, className, label }: { text: string; className?: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1200);
  };
  return (
    <Tooltip content={done ? "已复制" : label ?? "复制"}>
      <button type="button" onClick={copy} className={cn("inline-flex size-6 items-center justify-center rounded text-fg-3 hover:bg-hover hover:text-fg", className)}>
        {done ? <LuCheck className="size-3.5 text-ok" /> : <LuCopy className="size-3.5" />}
      </button>
    </Tooltip>
  );
}

export function Mono({ children, className, copy }: { children: string; className?: string; copy?: boolean }) {
  return (
    <span className={cn("group/mono inline-flex min-w-0 max-w-full items-center gap-0.5 font-mono text-[12px] text-fg-2", className)}>
      <span className="truncate">{children}</span>
      {copy && <CopyButton text={children} className="size-5 opacity-0 group-hover/mono:opacity-100" />}
    </span>
  );
}

// ———————— 代码块 / Markdown / JSON ————————

export function CodeBlock({ code, className, maxHeight = 360, wrap, title }: { code: string; className?: string; maxHeight?: number; wrap?: boolean; title?: ReactNode }) {
  return (
    <div className={cn("group/code relative overflow-hidden rounded-md border border-line bg-sunken", className)}>
      {title && <div className="flex h-7 items-center border-b border-line px-3 text-[11.5px] text-fg-3">{title}</div>}
      <pre className={cn("overflow-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed text-fg", wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")} style={{ maxHeight }}>{code}</pre>
      <CopyButton text={code} className="absolute right-1.5 top-1.5 bg-sunken opacity-0 group-hover/code:opacity-100" />
    </div>
  );
}

marked.setOptions({ gfm: true, breaks: true });

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className={cn("prose-ap", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function JsonView({ value, className, maxHeight }: { value: unknown; className?: string; maxHeight?: number }) {
  const text = useMemo(() => (typeof value === "string" ? value : JSON.stringify(value, null, 2)), [value]);
  return <CodeBlock code={text} className={className} maxHeight={maxHeight} wrap />;
}

// ———————— 键值编辑器（档案、环境变量、映射…） ————————

export interface KvSuggestion {
  key: string;
  label: string;
  placeholder?: string;
}

export function KeyValueEditor({ value, onChange, suggestions = [], keyPlaceholder = "键", valuePlaceholder = "值", multiline = true, monoKeys = true }: {
  value: Record<string, string>; onChange: (v: Record<string, string>) => void; suggestions?: KvSuggestion[];
  keyPlaceholder?: string; valuePlaceholder?: string; multiline?: boolean; monoKeys?: boolean;
}) {
  const entries = Object.entries(value);
  const set = (i: number, k: string, v: string) => {
    const next = entries.map(([ek, ev], j) => (j === i ? [k, v] : [ek, ev]));
    onChange(Object.fromEntries(next));
  };
  const remove = (i: number) => onChange(Object.fromEntries(entries.filter((_, j) => j !== i)));
  const add = (k = "") => {
    let key = k || "key";
    let n = 1;
    while (key in value) key = `${k || "key"}_${++n}`;
    onChange({ ...value, [key]: "" });
  };
  const missing = suggestions.filter((s) => !(s.key in value));
  const labelOf = (k: string) => suggestions.find((s) => s.key === k);
  return (
    <div className="space-y-2">
      {entries.length === 0 && <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-fg-3">还没有条目</div>}
      {entries.map(([k, v], i) => (
        <div key={i} className="grid grid-cols-[180px_1fr_auto] items-start gap-2">
          <div>
            <input value={k} onChange={(e) => set(i, e.target.value, v)} placeholder={keyPlaceholder}
              className={cn("h-8 w-full rounded-md border border-line bg-panel px-2.5 text-[12.5px] outline-none focus:border-accent", monoKeys && "font-mono")} />
            {labelOf(k) && <div className="mt-0.5 px-1 text-[11px] text-fg-3">{labelOf(k)!.label}</div>}
          </div>
          {multiline ? (
            <textarea value={v} rows={Math.min(6, Math.max(1, Math.ceil(v.length / 48), v.split("\n").length))} onChange={(e) => set(i, k, e.target.value)}
              placeholder={labelOf(k)?.placeholder ?? valuePlaceholder}
              className="min-h-8 w-full resize-y rounded-md border border-line bg-panel px-2.5 py-[5px] text-[13px] leading-relaxed outline-none focus:border-accent" />
          ) : (
            <input value={v} onChange={(e) => set(i, k, e.target.value)} placeholder={valuePlaceholder}
              className="h-8 w-full rounded-md border border-line bg-panel px-2.5 font-mono text-[12.5px] outline-none focus:border-accent" />
          )}
          <Button variant="ghost" size="icon-sm" onClick={() => remove(i)} aria-label="删除"><LuTrash2 /></Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <Button size="xs" icon={<LuPlus />} onClick={() => add()}>添加</Button>
        {missing.map((s) => (
          <button key={s.key} type="button" onClick={() => add(s.key)}
            className="h-6 rounded border border-dashed border-line px-2 text-xs text-fg-3 hover:border-accent hover:text-accent">+ {s.label}</button>
        ))}
      </div>
    </div>
  );
}

// ———————— diff ————————

export function DiffView({ before, after, className }: { before: string; after: string; className?: string }) {
  const parts = useMemo(() => diffLines(before, after), [before, after]);
  const changed = parts.some((p) => p.added || p.removed);
  if (!changed) return <div className="rounded-md border border-line bg-sunken px-3 py-4 text-center text-xs text-fg-3">两个版本内容相同</div>;
  return (
    <div className={cn("overflow-auto rounded-md border border-line bg-sunken font-mono text-[12px] leading-relaxed", className)}>
      {parts.flatMap((p, i) => p.value.replace(/\n$/, "").split("\n").map((line, j) => (
        <div key={`${i}-${j}`} className={cn("flex whitespace-pre-wrap break-words px-3", p.added && "diff-add", p.removed && "diff-del")}>
          <span className={cn("w-4 shrink-0 select-none", p.added ? "text-ok" : p.removed ? "text-bad" : "text-fg-3")}>{p.added ? "+" : p.removed ? "-" : " "}</span>
          <span className={cn(!p.added && !p.removed && "text-fg-3")}>{line || " "}</span>
        </div>
      )))}
    </div>
  );
}

/** 稳定序列化（键排序）：diff 两个定义时不受键顺序影响 */
export function stableYaml(v: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    if (v.every((x) => typeof x !== "object" || x === null)) return "[" + v.map((x) => JSON.stringify(x)).join(", ") + "]";
    return "\n" + v.map((x) => `${pad}- ${stableYaml(x, indent + 1).trimStart()}`).join("\n");
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as object).sort();
    if (!keys.length) return "{}";
    return (indent ? "\n" : "") + keys.map((k) => {
      const val = (v as Record<string, unknown>)[k];
      const s = stableYaml(val, indent + 1);
      return `${pad}${k}:${s.startsWith("\n") ? s : " " + s}`;
    }).join("\n");
  }
  if (typeof v === "string") return v.includes("\n") ? "|\n" + v.split("\n").map((l) => pad + "  " + l).join("\n") : JSON.stringify(v);
  return String(v);
}

export function copyText(text: string) {
  navigator.clipboard?.writeText(text).then(() => toast("已复制"), () => toast.error("复制失败"));
}
