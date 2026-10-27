/**
 * 日志（服务定义的 logs、各环境覆盖、服务×环境视图）：{名字: 文件路径（可带 * 通配，取最新的那个）| docker:<容器名> | journal:<systemd 单元>}，
 * agent 的 logs 工具按名字读。
 * - LogList：只读展示，名字 → 目标
 * - LogsEditor：名字 + 目标的小列表编辑器；环境覆盖时按名字覆盖基座，目标留空 = 本环境没有这个日志
 */
import { useEffect, useState } from "react";
import { LuBox, LuFileText, LuPlus, LuServer, LuTrash2 } from "react-icons/lu";

import { cn } from "@/lib/cn";
import { Button } from "./ui/button";
import { Badge } from "./ui/primitives";

export const LOG_NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;

/** 与后端 _check_logs 一致；override 时目标可以留空（本环境没有这个日志） */
export function logError(name: string, target: string, override = false): string | null {
  if (!LOG_NAME_RE.test(name)) return `日志名不合法：${name || "（空）"}（小写字母开头，可含数字 _ -，最多 31 个字符）`;
  if (!target) return override ? null : `日志 ${name} 要写目标`;
  if (target.startsWith("docker:")) return target.length > 7 ? null : `日志 ${name}：docker: 后面写容器名`;
  if (target.startsWith("journal:")) return target.length > 8 ? null : `日志 ${name}：journal: 后面写 systemd 单元`;
  if (!target.startsWith("/") && !target.startsWith("~")) return `日志 ${name} 要写绝对路径（可以 ~ 开头，可带 * 通配）、docker:<容器名> 或 journal:<systemd 单元>`;
  return null;
}

/** 整份日志定义的第一个错误（保存前兜底检查） */
export function logsError(logs: Record<string, string> | undefined, override = false): string | null {
  for (const [name, target] of Object.entries(logs ?? {})) {
    const e = logError(name, target, override);
    if (e) return e;
  }
  return null;
}

function TargetBadge({ target, className }: { target: string; className?: string }) {
  if (!target) return <Badge tone="idle" className={className}>本环境没有</Badge>;
  if (target.startsWith("docker:")) return <Badge tone="info" icon={<LuBox />} className={className}>容器</Badge>;
  if (target.startsWith("journal:")) return <Badge tone="info" icon={<LuServer />} className={className}>systemd</Badge>;
  return <Badge tone="outline" icon={<LuFileText />} className={className}>文件</Badge>;
}

/** 服务×环境视图里的日志：名字 → 渲染后的目标 */
export function LogList({ logs, empty }: { logs: Record<string, string>; empty?: React.ReactNode }) {
  const entries = Object.entries(logs);
  if (!entries.length) return <>{empty ?? <span className="text-fg-3">未配置</span>}</>;
  return (
    <ul className="space-y-1">
      {entries.map(([name, target]) => (
        <li key={name} className="flex min-w-0 items-center gap-1.5">
          <code className="shrink-0 font-mono text-[12px] font-medium text-fg">{name}</code>
          <span className="shrink-0 text-fg-3">→</span>
          <span className="min-w-0 truncate font-mono text-[11.5px] text-fg-2" title={target}>{target}</span>
        </li>
      ))}
    </ul>
  );
}

interface Row { id: number; name: string; target: string }
let rowId = 0;
const toRows = (v: Record<string, string>): Row[] => Object.entries(v).map(([name, target]) => ({ id: ++rowId, name, target }));
/** 重名时以第一个为准（后面的那行会标红） */
const toRecord = (rows: Row[]) => {
  const out: Record<string, string> = {};
  for (const r of rows) if (!(r.name in out)) out[r.name] = r.target;
  return out;
};
const same = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(a) === JSON.stringify(b);

/** 常见的几种写法：给新加的一行当占位 */
const PLACEHOLDERS = ["~/deploy/xxx/app.log", "docker:xxx-webserver", "journal:xxx.service", "~/deploy/xxx/logs/app-*.log"];

/**
 * base：环境覆盖时的基座日志（给占位与"覆盖 / 本环境没有"的快捷按钮）。
 * 名字重名、目标不合法就地标红；保存前调用方再用 logsError 兜底检查。
 */
export function LogsEditor({ value, onChange, base }: {
  value: Record<string, string>; onChange: (v: Record<string, string>) => void; base?: Record<string, string>;
}) {
  const override = base !== undefined;
  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  // 外部改了（放弃修改、保存后刷新）：重新铺行；自己输入引起的变化不重铺，避免打断输入
  useEffect(() => { if (!same(toRecord(rows), value)) setRows(toRows(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (next: Row[]) => { setRows(next); onChange(toRecord(next)); };
  const set = (id: number, patch: Partial<Row>) => commit(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = (name = "", target = "") => {
    let n = name || "app";
    let i = 1;
    while (rows.some((r) => r.name === n)) n = `${name || "app"}${++i}`;
    commit([...rows, { id: ++rowId, name: n, target }]);
  };
  const baseLeft = Object.keys(base ?? {}).filter((k) => !rows.some((r) => r.name === k));
  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <div className="rounded-md border border-dashed border-line px-3 py-3 text-center text-xs text-fg-3">
          {override ? "沿用基座的日志" : "没有日志：logs 工具在这个服务上不可用"}
        </div>
      )}
      {rows.map((r, i) => {
        const dup = rows.find((x) => x.name === r.name)!.id !== r.id;
        const error = dup ? `日志名 ${r.name} 重复` : logError(r.name, r.target, override);
        const inherited = base?.[r.name];
        return (
          <div key={r.id}>
            <div className="grid grid-cols-[150px_minmax(0,1fr)_auto_auto] items-center gap-2">
              <input value={r.name} aria-label="日志名" placeholder="名字，如 app" spellCheck={false}
                onChange={(e) => set(r.id, { name: e.target.value.trim() })} aria-invalid={!!error && (dup || error.startsWith("日志名"))}
                className="h-8 w-full rounded-md border border-line bg-panel px-2.5 font-mono text-[12.5px] outline-none focus:border-accent aria-[invalid=true]:border-bad" />
              <input value={r.target} aria-label={`${r.name || "日志"} 的目标`} spellCheck={false}
                placeholder={inherited ? `留空 = 本环境没有（基座：${inherited}）` : PLACEHOLDERS[i % PLACEHOLDERS.length]}
                onChange={(e) => set(r.id, { target: e.target.value.trim() })}
                className="h-8 w-full min-w-0 rounded-md border border-line bg-panel px-2.5 font-mono text-[12.5px] outline-none focus:border-accent" />
              <TargetBadge target={r.target} className="w-[84px] justify-center" />
              <Button variant="ghost" size="icon-sm" aria-label={`删除日志 ${r.name}`} onClick={() => commit(rows.filter((x) => x.id !== r.id))}><LuTrash2 /></Button>
            </div>
            {error && <div className="mt-0.5 text-xs text-bad">{error}</div>}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <Button size="xs" icon={<LuPlus />} onClick={() => add()}>添加日志</Button>
        {baseLeft.map((k) => (
          <span key={k} className="inline-flex gap-1">
            <button type="button" onClick={() => add(k, base![k])} title={`在这个环境换一个 ${k} 的位置`}
              className={cn("h-6 rounded border border-dashed border-line px-2 font-mono text-xs text-fg-3 hover:border-accent hover:text-accent")}>覆盖 {k}</button>
            <button type="button" onClick={() => add(k, "")} title={`这个环境没有 ${k}（logs 工具读不到它）`}
              className="h-6 rounded border border-dashed border-line px-2 text-xs text-fg-3 hover:border-accent hover:text-accent">本环境没有 <span className="font-mono">{k}</span></button>
          </span>
        ))}
      </div>
    </div>
  );
}
