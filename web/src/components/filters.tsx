/**
 * 列表顶部的快捷筛选：服务 / 环境（及页面自带的其它维度）。值放在 URL 查询参数里，可分享、可回退。
 * 环境默认跟随顶栏的全局环境视角。
 */
import { type ReactNode } from "react";
import { LuX } from "react-icons/lu";

import { useEnvs, useServices } from "@/api/hooks";
import { FilterSelect, type Option } from "./ui/form";

export function ServiceFilter({ value, onChange, includeNone }: { value: string; onChange: (v: string) => void; includeNone?: boolean }) {
  const { data } = useServices();
  const options: Option[] = (data ?? []).map((s) => ({ value: s.name, label: s.name, hint: s.title }));
  if (includeNone) options.push({ value: "-", label: "平台任务", hint: "不属于任何服务" });
  return <FilterSelect label="服务" allLabel="全部" value={value} onChange={onChange} options={options} />;
}

export function EnvFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useEnvs();
  return <FilterSelect label="环境" allLabel="全部" value={value} onChange={onChange}
    options={(data ?? []).map((e) => ({ value: e.name, label: <span className="font-mono uppercase">{e.name}</span>, hint: e.title }))} />;
}

/** 一行筛选条：左边筛选项，右边额外内容；有任一筛选生效时显示"清除" */
export function FilterBar({ children, active, onClear, right }: { children: ReactNode; active: boolean; onClear: () => void; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {children}
      {active && (
        <button type="button" onClick={onClear} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] text-fg-3 hover:bg-hover hover:text-fg">
          <LuX className="size-3.5" />清除
        </button>
      )}
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  );
}
