/**
 * 设置：左侧分组导航 + 右侧内容。分两组——
 * 平台（对所有人生效：四节配置带版本历史）/ 定义与接入（角色、API 密钥）。/settings 本身就是第一个平台设置页。
 */
import { type ReactNode } from "react";
import {
  LuBell, LuBot, LuBrain, LuKeyRound, LuLayers, LuMessageSquareText,
} from "react-icons/lu";

import { Page } from "@/components/layout/shell";
import { cn } from "@/lib/cn";
import { Link, useActive, useLocation } from "@/lib/router";

const GROUPS: { title: string; hint: string; items: { to: string; label: string; icon: ReactNode }[] }[] = [
  {
    title: "平台", hint: "对所有人生效", items: [
      { to: "/settings/envs", label: "环境", icon: <LuLayers /> },
      { to: "/settings/notifications", label: "通知", icon: <LuBell /> },
      { to: "/settings/memory", label: "记忆", icon: <LuBrain /> },
      { to: "/settings/prompts", label: "提示词", icon: <LuMessageSquareText /> },
    ],
  },
  {
    title: "定义与接入", hint: "", items: [
      { to: "/settings/roles", label: "角色", icon: <LuBot /> },
      { to: "/settings/api-keys", label: "API 密钥", icon: <LuKeyRound /> },
    ],
  },
];

function NavLink({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  const { path } = useLocation();
  // /settings 本身就是第一个平台设置页
  const active = useActive(to) || (to === GROUPS[0].items[0].to && path === "/settings");
  return (
    <Link to={to} aria-current={active ? "page" : undefined} className={cn("flex h-8 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 text-[13px] transition-colors [&_svg]:size-4",
      active ? "bg-panel font-medium text-fg shadow-[0_0_0_1px_var(--color-line)]" : "text-fg-2 hover:bg-hover hover:text-fg")}>
      <span className={active ? "text-accent" : "text-fg-3"}>{icon}</span>{label}
    </Link>
  );
}

export function SettingsLayout({ title, description, actions, children, wide }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean;
}) {
  return (
    <Page wide={wide}>
      {/* 宽屏（≥ 1280）左侧竖排导航；窄一些就放到顶上横排：再在主侧栏旁边占 200px，表单只剩一半宽 */}
      <div className="flex flex-col gap-5 xl:flex-row xl:gap-6">
        <nav className="flex shrink-0 gap-6 overflow-x-auto border-b border-line pb-3 xl:w-52 xl:flex-col xl:gap-5 xl:border-0 xl:pb-0">
          {GROUPS.map((g) => (
            <div key={g.title} className="min-w-fit">
              <div className="mb-1.5 px-2.5">
                <div className="text-[11.5px] font-semibold text-fg-3">{g.title}</div>
                {g.hint && <div className="hidden text-[10.5px] text-fg-3/80 xl:block">{g.hint}</div>}
              </div>
              <div className="flex gap-0.5 xl:flex-col">{g.items.map((i) => <NavLink key={i.to} {...i} />)}</div>
            </div>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          <div className="mb-5 flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="min-w-0 truncate text-[19px] font-semibold tracking-tight text-fg">{title}</h1>
              {description && <div className="mt-0.5 max-w-3xl text-[13px] leading-relaxed text-fg-3">{description}</div>}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          </div>
          {children}
        </div>
      </div>
    </Page>
  );
}

/** 一行设置：左边说明，右边控件 */
export function SettingRow({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-fg">{title}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-relaxed text-fg-3">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
