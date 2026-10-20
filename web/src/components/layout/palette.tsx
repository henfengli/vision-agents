/**
 * ⌘K 命令面板：页面跳转、切换环境/主题、全局搜索（服务/任务/运行/角色/知识）。
 * 键盘：↑↓ 选择、Enter 执行、Esc 关闭。
 */
import { Dialog, DialogPanel } from "@headlessui/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  LuActivity, LuBell, LuBot, LuBrain, LuCornerDownLeft, LuKeyRound, LuLayers, LuLayoutDashboard, LuListTodo, LuMessageSquare, LuMoon, LuPlay, LuSearch, LuServer, LuSettings, LuShieldCheck, LuSlidersHorizontal, LuSun,
} from "react-icons/lu";

import { api, useEnvs } from "@/api/hooks";
import type { SearchHit } from "@/api/types";
import { cn } from "@/lib/cn";
import { navigate } from "@/lib/router";
import { setUi } from "@/lib/store";
import { Kbd, Spinner } from "../ui/primitives";

let open = false;
const subs = new Set<() => void>();
const setOpen = (v: boolean) => { open = v; subs.forEach((s) => s()); };
export const openPalette = () => setOpen(true);

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen(!open); }
});

interface Cmd { id: string; label: ReactNode; hint?: ReactNode; icon: ReactNode; group: string; run: () => void; keywords?: string }

const HIT_ICON: Record<SearchHit["type"], ReactNode> = {
  service: <LuServer />, task: <LuListTodo />, run: <LuActivity />, role: <LuBot />, knowledge: <LuBrain />, session: <LuMessageSquare />,
};
const HIT_GROUP: Record<SearchHit["type"], string> = { service: "服务", task: "任务", run: "运行", role: "角色", knowledge: "知识", session: "会话" };

export function CommandPalette() {
  const isOpen = useSyncExternalStore((l) => { subs.add(l); return () => subs.delete(l); }, () => open);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const { data: envs } = useEnvs();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!isOpen) { setQ(""); setHits([]); setSel(0); } }, [isOpen]);
  useEffect(() => {
    if (!q.trim()) { setHits([]); return; }
    setLoading(true);
    const id = setTimeout(() => {
      api.search(q.trim()).then(setHits).catch(() => setHits([])).finally(() => setLoading(false));
    }, 160);
    return () => clearTimeout(id);
  }, [q]);

  const commands: Cmd[] = useMemo(() => {
    const go = (to: string) => () => navigate(to);
    return [
      { id: "nav-home", label: "概览", icon: <LuLayoutDashboard />, group: "跳转", run: go("/"), keywords: "overview dashboard" },
      { id: "nav-services", label: "服务", icon: <LuServer />, group: "跳转", run: go("/services"), keywords: "services" },
      { id: "nav-tasks", label: "任务", icon: <LuListTodo />, group: "跳转", run: go("/tasks"), keywords: "tasks" },
      { id: "nav-runs", label: "运行", icon: <LuActivity />, group: "跳转", run: go("/runs"), keywords: "runs" },
      { id: "nav-failed", label: "失败的运行", hint: "近 24h", icon: <LuActivity />, group: "跳转", run: go("/runs?status=failed&hours=24"), keywords: "failed" },
      { id: "nav-chat", label: "对话", icon: <LuMessageSquare />, group: "跳转", run: go("/chat"), keywords: "chat" },
      { id: "nav-approvals", label: "审批", icon: <LuShieldCheck />, group: "跳转", run: go("/approvals"), keywords: "approvals" },
      { id: "nav-memory", label: "记忆", icon: <LuBrain />, group: "跳转", run: go("/memory"), keywords: "memory knowledge" },
      { id: "nav-roles", label: "角色", icon: <LuBot />, group: "跳转", run: go("/settings/roles"), keywords: "roles" },
      { id: "nav-policies", label: "策略", icon: <LuSlidersHorizontal />, group: "跳转", run: go("/settings/policies"), keywords: "policies" },
      { id: "nav-settings", label: "设置", icon: <LuSettings />, group: "跳转", run: go("/settings"), keywords: "settings admin" },
      { id: "nav-prefs", label: "个人偏好", icon: <LuSettings />, group: "跳转", run: go("/settings/preferences"), keywords: "preferences theme" },
      { id: "nav-envs", label: "环境设置", icon: <LuLayers />, group: "跳转", run: go("/settings/envs"), keywords: "envs" },
      { id: "nav-notify", label: "通知设置", icon: <LuBell />, group: "跳转", run: go("/settings/notifications"), keywords: "notifications dingtalk" },
      { id: "nav-keys", label: "API 密钥", icon: <LuKeyRound />, group: "跳转", run: go("/settings/api-keys"), keywords: "api key token" },
      { id: "act-run", label: "运行一个任务…", icon: <LuPlay />, group: "操作", run: go("/tasks?run=1"), keywords: "run start" },
      { id: "act-new-chat", label: "新对话", icon: <LuMessageSquare />, group: "操作", run: go("/chat?new=1"), keywords: "new chat ask" },
      ...[{ name: "", title: "全部" }, ...(envs ?? [])].map((e) => ({
        id: "env-" + e.name, label: `切换到环境：${e.name || "全部"}`, icon: <LuLayers />, group: "环境", run: () => setUi({ env: e.name }), keywords: "env " + e.name,
      })),
      { id: "theme-light", label: "浅色主题", icon: <LuSun />, group: "外观", run: () => setUi({ theme: "light" }), keywords: "theme light" },
      { id: "theme-dark", label: "深色主题", icon: <LuMoon />, group: "外观", run: () => setUi({ theme: "dark" }), keywords: "theme dark" },
    ];
  }, [envs]);

  const items: Cmd[] = useMemo(() => {
    const term = q.trim().toLowerCase();
    const cmds = term ? commands.filter((c) => (String(c.label) + " " + (c.keywords ?? "")).toLowerCase().includes(term)) : commands.slice(0, 9);
    const results = hits.map((h) => ({ id: h.type + h.id, label: h.title, hint: h.subtitle, icon: HIT_ICON[h.type], group: HIT_GROUP[h.type], run: () => navigate(h.href) }));
    return [...results, ...cmds];
  }, [commands, hits, q]);

  useEffect(() => setSel(0), [items.length]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const exec = (c: Cmd | undefined) => { if (!c) return; setOpen(false); c.run(); };

  let lastGroup = "";
  return (
    <Dialog open={isOpen} onClose={() => setOpen(false)} className="relative z-[60]">
      <div className="fixed inset-0 bg-black/25 dark:bg-black/55" />
      <div className="fixed inset-0 flex justify-center p-4 pt-[14vh]">
        <DialogPanel className="flex h-fit max-h-[60vh] w-full max-w-[600px] animate-pop flex-col overflow-hidden rounded-xl border border-line bg-raised shadow-[var(--shadow-pop)]">
          <div className="flex items-center gap-2.5 border-b border-line px-4">
            {loading ? <Spinner /> : <LuSearch className="size-4 text-fg-3" />}
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索或输入命令…"
              className="h-12 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-fg-3"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
                else if (e.key === "Enter") { e.preventDefault(); exec(items[sel]); }
              }} />
            <Kbd>Esc</Kbd>
          </div>
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {items.length === 0 && <div className="px-3 py-8 text-center text-[13px] text-fg-3">没有匹配的结果</div>}
            {items.map((c, i) => {
              const header = c.group !== lastGroup ? (lastGroup = c.group) : null;
              return (
                <div key={c.id}>
                  {header && <div className="px-2.5 pb-1 pt-2.5 text-[11px] font-semibold text-fg-3">{header}</div>}
                  <button type="button" data-idx={i} onMouseMove={() => setSel(i)} onClick={() => exec(c)}
                    className={cn("flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] [&_svg]:size-4", i === sel ? "bg-hover text-fg" : "text-fg-2")}>
                    <span className="text-fg-3">{c.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    {c.hint && <span className="max-w-[45%] truncate text-xs text-fg-3">{c.hint}</span>}
                    {i === sel && <LuCornerDownLeft className="!size-3.5 text-fg-3" />}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11.5px] text-fg-3">
            <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd>选择</span>
            <span className="flex items-center gap-1"><Kbd>↵</Kbd>打开</span>
            <span className="ml-auto">⌘K 随时唤起</span>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
