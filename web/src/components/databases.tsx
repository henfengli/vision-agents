/**
 * 只读库（服务定义的 databases、各环境覆盖、服务×环境视图）：{库名: 连接串}，scheme 决定类型。
 * - DbBadge / DbList：只读展示，只显示类型、主机与库名，不显示口令
 * - DatabasesEditor：库名 + 连接串的小列表编辑器；环境覆盖时按库名覆盖基座，连接串留空 = 本环境没有这个库
 */
import { useEffect, useState } from "react";
import { LuDatabase, LuPlus, LuTrash2 } from "react-icons/lu";

import { DB_LABEL, DB_SCHEMES, dbError, dbKind, dbWhere } from "@/lib/db";
import { cn } from "@/lib/cn";
import { Button } from "./ui/button";
import { Badge } from "./ui/primitives";

export function DbBadge({ url, className }: { url: string; className?: string }) {
  const kind = dbKind(url);
  if (!url.trim()) return <Badge tone="idle" className={className}>本环境没有</Badge>;
  return kind
    ? <Badge tone="info" icon={<LuDatabase />} className={className}>{DB_LABEL[kind]}</Badge>
    : <Badge tone="bad" className={className}>类型不认识</Badge>;
}

/** 服务×环境视图里的只读库：库名 · 类型 · 主机/库名 */
export function DbList({ databases, empty }: { databases: Record<string, string>; empty?: React.ReactNode }) {
  const entries = Object.entries(databases);
  if (!entries.length) return <>{empty ?? <span className="text-fg-3">未配置</span>}</>;
  return (
    <ul className="space-y-1">
      {entries.map(([name, url]) => {
        const w = dbWhere(url);
        const where = w.host + (w.database ? `/${w.database}` : "");
        return (
          <li key={name} className="flex min-w-0 flex-wrap items-center gap-1.5">
            <code className="font-mono text-[12px] font-medium text-fg">{name}</code>
            <DbBadge url={url} />
            {where && <span className="min-w-0 truncate font-mono text-[11.5px] text-fg-3" title={where}>{where}</span>}
          </li>
        );
      })}
    </ul>
  );
}

const SCHEMES = Object.keys(DB_SCHEMES).map((s) => s + "://");

/** 编辑器下面的说明：支持的 scheme + 口令写法 */
export function DatabasesHint({ override }: { override?: boolean }) {
  return (
    <div className="text-xs leading-relaxed text-fg-3">
      类型按连接串的开头判断：{SCHEMES.map((s, i) => <span key={s}>{i > 0 && " "}<code className="font-mono">{s}</code></span>)}。
      口令写 <code className="font-mono">{"${VAR}"}</code>（真实值放 secrets.env）；直接写的口令回显为 <code className="font-mono">***</code>，原样保存表示不改。只给只读账号。
      {override && <> 环境里按库名覆盖基座；连接串留空 = 这个环境没有这个库。</>}
    </div>
  );
}

interface Row { id: number; name: string; url: string }
let rowId = 0;
const toRows = (v: Record<string, string>): Row[] => Object.entries(v).map(([name, url]) => ({ id: ++rowId, name, url }));
/** 重名时以第一个为准（后面的那行会标红） */
const toRecord = (rows: Row[]) => {
  const out: Record<string, string> = {};
  for (const r of rows) if (!(r.name in out)) out[r.name] = r.url;
  return out;
};
const same = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(a) === JSON.stringify(b);

/**
 * base：环境覆盖时的基座库（给占位与"覆盖 / 本环境没有"的快捷按钮）。
 * 库名重名、类型不认识就地标红；保存前调用方再用 databasesError 兜底检查。
 */
export function DatabasesEditor({ value, onChange, base }: {
  value: Record<string, string>; onChange: (v: Record<string, string>) => void; base?: Record<string, string>;
}) {
  const override = base !== undefined;
  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  // 外部改了（放弃修改、保存后刷新）：重新铺行；自己输入引起的变化不重铺，避免打断输入
  useEffect(() => { if (!same(toRecord(rows), value)) setRows(toRows(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (next: Row[]) => { setRows(next); onChange(toRecord(next)); };
  const set = (id: number, patch: Partial<Row>) => commit(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = (name = "", url = "") => {
    let n = name || "db";
    let i = 1;
    while (rows.some((r) => r.name === n)) n = `${name || "db"}${++i}`;
    commit([...rows, { id: ++rowId, name: n, url }]);
  };
  const baseLeft = Object.keys(base ?? {}).filter((k) => !rows.some((r) => r.name === k));
  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <div className="rounded-md border border-dashed border-line px-3 py-3 text-center text-xs text-fg-3">
          {override ? "沿用基座的只读库" : "没有只读库：db_query 在这个服务上不可用"}
        </div>
      )}
      {rows.map((r) => {
        const dup = rows.find((x) => x.name === r.name)!.id !== r.id;
        const error = dup ? `库名 ${r.name} 重复` : dbError(r.name, r.url, override);
        const inherited = base?.[r.name];
        return (
          <div key={r.id}>
            <div className="grid grid-cols-[140px_minmax(0,1fr)_auto_auto] items-center gap-2">
              <input value={r.name} aria-label="库名" placeholder="库名，如 ck" spellCheck={false}
                onChange={(e) => set(r.id, { name: e.target.value.trim() })} aria-invalid={!!error && (dup || !!error.startsWith("库名"))}
                className="h-8 w-full rounded-md border border-line bg-panel px-2.5 font-mono text-[12.5px] outline-none focus:border-accent aria-[invalid=true]:border-bad" />
              <input value={r.url} aria-label={`${r.name || "库"} 的连接串`} spellCheck={false}
                placeholder={inherited ? `留空 = 本环境没有（基座：${inherited}）` : "clickhouse://${CK_RO_USER}:${CK_RO_PASSWORD}@host:8123/default"}
                onChange={(e) => set(r.id, { url: e.target.value.trim() })}
                className="h-8 w-full min-w-0 rounded-md border border-line bg-panel px-2.5 font-mono text-[12.5px] outline-none focus:border-accent" />
              <DbBadge url={r.url} className="w-[104px] justify-center" />
              <Button variant="ghost" size="icon-sm" aria-label={`删除库 ${r.name}`} onClick={() => commit(rows.filter((x) => x.id !== r.id))}><LuTrash2 /></Button>
            </div>
            {error && <div className="mt-0.5 text-xs text-bad">{error}</div>}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <Button size="xs" icon={<LuPlus />} onClick={() => add()}>添加库</Button>
        {baseLeft.map((k) => (
          <span key={k} className="inline-flex gap-1">
            <button type="button" onClick={() => add(k, base![k].replace(/:\*\*\*@/, ":${PASSWORD}@"))} title={`在这个环境换一个 ${k} 的连接串`}
              className={cn("h-6 rounded border border-dashed border-line px-2 font-mono text-xs text-fg-3 hover:border-accent hover:text-accent")}>覆盖 {k}</button>
            <button type="button" onClick={() => add(k, "")} title={`这个环境没有 ${k}（db_query 查不到它）`}
              className="h-6 rounded border border-dashed border-line px-2 text-xs text-fg-3 hover:border-accent hover:text-accent">本环境没有 <span className="font-mono">{k}</span></button>
          </span>
        ))}
      </div>
    </div>
  );
}
