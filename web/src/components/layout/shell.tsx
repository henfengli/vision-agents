/**
 * 应用骨架：左侧导航（含主题与退出）+ 顶栏（搜索、全局环境视角）+ 内容区。
 */
import { useEffect, type ReactNode } from "react";
import {
  LuActivity, LuBrain, LuChevronsLeft, LuChevronsRight, LuLayoutDashboard, LuListTodo, LuLogOut, LuMessageSquare,
  LuMonitor, LuMoon, LuSearch, LuServer, LuSettings, LuSun,
} from "react-icons/lu";

import { api, useEnvs, useMeta } from "@/api/hooks";
import { cn } from "@/lib/cn";
import { Link, navigate, useActive } from "@/lib/router";
import { setUi, useNarrow, useUi, type Theme } from "@/lib/store";
import { Kbd } from "../ui/primitives";
import { Menu, Tooltip } from "../ui/overlay";
import { PALETTE_HOTKEY, openPalette } from "./palette";

function NavItem({ to, icon, label, collapsed }: { to: string; icon: ReactNode; label: string; collapsed: boolean }) {
  const active = useActive(to);
  const item = (
    <Link to={to} aria-label={collapsed ? label : undefined} aria-current={active ? "page" : undefined} className={cn(
      "group relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
      active ? "bg-panel text-fg shadow-[0_0_0_1px_var(--color-line),var(--shadow-card)]" : "text-fg-2 hover:bg-hover hover:text-fg",
      collapsed && "justify-center px-0",
    )}>
      <span className={cn(active ? "text-accent" : "text-fg-3 group-hover:text-fg-2")}>{icon}</span>
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
    </Link>
  );
  return collapsed ? <div className="[&>span]:flex"><Tooltip content={label} side="right">{item}</Tooltip></div> : item;
}

function Sidebar() {
  const { sidebarCollapsed } = useUi();
  const narrow = useNarrow();
  const collapsed = sidebarCollapsed || narrow;
  const { data: meta } = useMeta();
  return (
    <aside className={cn("flex h-full shrink-0 flex-col border-r border-line bg-sunken/60 transition-[width] duration-150", collapsed ? "w-[56px]" : "w-[220px]")}>
      <div className={cn("flex h-12 items-center gap-2 px-3.5", collapsed && "justify-center px-0")}>
        <Logo />
        {!collapsed && <div className="min-w-0 leading-tight">
          <div className="truncate text-[13px] font-semibold tracking-tight text-fg">agent-platform</div>
          <div className="text-[10.5px] text-fg-3">{meta ? `v${meta.version}` : " "}</div>
        </div>}
      </div>
      <nav aria-label="主导航" className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
        <NavItem to="/" icon={<LuLayoutDashboard />} label="概览" collapsed={collapsed} />
        <NavItem to="/services" icon={<LuServer />} label="服务" collapsed={collapsed} />
        <NavItem to="/tasks" icon={<LuListTodo />} label="任务" collapsed={collapsed} />
        <NavItem to="/runs" icon={<LuActivity />} label="运行" collapsed={collapsed} />
        <NavItem to="/chat" icon={<LuMessageSquare />} label="对话" collapsed={collapsed} />
        <NavItem to="/memory" icon={<LuBrain />} label="记忆" collapsed={collapsed} />
      </nav>
      <div className="px-2 pb-2">
        <NavItem to="/settings" icon={<LuSettings />} label="设置" collapsed={collapsed} />
      </div>
      <div className={cn("flex items-center border-t border-line p-2", collapsed ? "flex-col gap-1" : "justify-between")}>
        <ThemeMenu collapsed={collapsed} />
        {!narrow && <Tooltip content={collapsed ? "展开侧栏" : "收起侧栏"} side="right">
          <button type="button" onClick={() => setUi({ sidebarCollapsed: !collapsed })} aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            className="inline-flex size-7 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg">
            {collapsed ? <LuChevronsRight className="size-4" /> : <LuChevronsLeft className="size-4" />}
          </button>
        </Tooltip>}
      </div>
    </aside>
  );
}

/** 侧栏底部：当前身份 + 主题 / 退出（收起时只剩图标） */
function ThemeMenu({ collapsed }: { collapsed: boolean }) {
  const { theme } = useUi();
  const { data: meta } = useMeta();
  const icon = theme === "dark" ? <LuMoon /> : theme === "light" ? <LuSun /> : <LuMonitor />;
  const set = (t: Theme) => () => setUi({ theme: t });
  const logout = async () => {
    if (!navigate("/login", { replace: true })) return;
    await api.logout().catch(() => undefined);
  };
  const name = meta?.me.name ?? "—";
  return (
    <Menu align="start" trigger={
      <button type="button" title={`${name} · 主题与账户`} aria-label={`${name}：主题与退出`}
        className={cn("inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md text-xs text-fg-3 hover:bg-hover hover:text-fg [&_svg]:size-3.5", collapsed ? "w-7 justify-center" : "px-2")}>
        {icon}{!collapsed && <span className="truncate">{name}</span>}
      </button>
    } items={[
      { label: "浅色", icon: <LuSun />, onClick: set("light") },
      { label: "深色", icon: <LuMoon />, onClick: set("dark") },
      { label: "跟随系统", icon: <LuMonitor />, onClick: set("system") },
      { separator: true, label: "" },
      { label: "退出登录", icon: <LuLogOut />, onClick: logout },
    ]} />
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7 shrink-0", className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-accent" />
      <path d="M9 21.5 16 9l7 12.5" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="18.2" r="2.2" fill="#fff" />
    </svg>
  );
}

/** 全局环境切换：决定各列表/统计默认看哪套环境 */
export function EnvSwitcher() {
  const { env } = useUi();
  const { data: envs } = useEnvs();
  // 存着的视角对应的环境已经在设置里删掉了：回到全部，不然各列表按一个不存在的环境过滤、全是空的
  useEffect(() => { if (envs && env && !envs.some((e) => e.name === env)) setUi({ env: "" }); }, [envs, env]);
  const items = [{ name: "", title: "全部" }, ...(envs ?? [])];
  return (
    <div role="group" aria-label="全局环境视角" className="inline-flex h-7 items-center rounded-md border border-line bg-sunken p-0.5">
      {items.map((e) => (
        <button key={e.name} type="button" onClick={() => setUi({ env: e.name })} aria-pressed={env === e.name}
          title={e.name ? `只看 ${e.title || e.name}` : "看全部环境"}
          className={cn("h-6 rounded-[5px] px-2.5 text-[12px] font-medium transition-colors",
            env === e.name ? "bg-panel text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-fg-3 hover:text-fg",
            e.name && "font-mono uppercase tracking-wide")}>
          {e.name || <><span className="md:hidden">全部</span><span className="hidden md:inline">全部环境</span></>}
        </button>
      ))}
    </div>
  );
}

function Topbar() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel/80 px-3 backdrop-blur md:gap-3 md:px-5">
      <button type="button" onClick={openPalette} aria-label="搜索与命令"
        className="flex h-7 items-center gap-2 rounded-md border border-line bg-sunken px-2.5 text-[12.5px] text-fg-3 transition-colors hover:border-line-strong hover:text-fg-2 md:w-[300px]">
        <LuSearch className="size-3.5" />
        <span className="hidden flex-1 text-left md:inline">搜索服务、任务、运行、记忆…</span>
        <Kbd className="hidden md:inline-flex">{PALETTE_HOTKEY}</Kbd>
      </button>
      <div className="flex-1" />
      <span className="hidden text-[11.5px] text-fg-3 lg:inline">环境视角</span>
      <EnvSwitcher />
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  useMeta();
  return (
    // 整个控制台只有 main 自己滚：外层 relative + overflow-clip，哪个组件再漏出一个按整页定位的元素，也不会让文档跟着滚
    <div className="relative flex h-full overflow-clip">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

// ———————— 页面骨架 ————————

export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={cn("mx-auto w-full px-4 py-5 md:px-6", wide ? "max-w-[1600px]" : "max-w-[1320px]", className)}>{children}</div>;
}

export function PageHeader({ title, description, actions, crumbs, meta, icon }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; crumbs?: { label: ReactNode; to?: string }[]; meta?: ReactNode; icon?: ReactNode;
}) {
  return (
    <div className="mb-5">
      {crumbs && (
        <div className="mb-2 flex items-center gap-1.5 text-[12.5px] text-fg-3">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-line-strong">/</span>}
              {c.to ? <Link to={c.to} className="hover:text-fg">{c.label}</Link> : <span className="text-fg-2">{c.label}</span>}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        {icon && <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-panel text-fg-2 shadow-[var(--shadow-card)] [&_svg]:size-5">{icon}</div>}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[19px] font-semibold tracking-tight text-fg" title={typeof title === "string" ? title : undefined}>{title}</h1>
          {description && <div className="mt-0.5 text-[13px] text-fg-3">{description}</div>}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-fg-3">{meta}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
