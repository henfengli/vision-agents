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

/** includeShared：记忆按服务分区，env 为空的条目对所有环境成立——选某个环境 = 该环境的 + 通用的；"*" = 只看通用的 */
export function EnvFilter({ value, onChange, includeShared }: { value: string; onChange: (v: string) => void; includeShared?: boolean }) {
  const { data } = useEnvs();
  const options: Option[] = (data ?? []).map((e) => ({ value: e.name, label: <span className="font-mono uppercase">{e.name}</span>, hint: includeShared ? `${e.title} + 通用` : e.title }));
  if (includeShared) options.push({ value: "*", label: "所有环境", hint: "只看通用的" });
  return <FilterSelect label="环境" allLabel="全部" value={value} onChange={onChange} options={options} />;
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
