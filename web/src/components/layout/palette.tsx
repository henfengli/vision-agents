/**
 * 命令面板（⌘K / Ctrl K）：页面跳转、切换环境/主题、全局搜索（服务/任务/运行/角色/记忆/方法）。
 * 键盘：↑↓ 选择、Enter 执行、Esc 关闭。
 */
import { Dialog, DialogPanel } from "@headlessui/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  LuActivity, LuBell, LuBot, LuBrain, LuCornerDownLeft, LuFlaskConical, LuKeyRound, LuLayers, LuLayoutDashboard, LuListTodo, LuMessageSquare,
  LuMessageSquareText, LuMessageSquareWarning, LuMonitor, LuMoon, LuPlay, LuSearch, LuServer, LuSettings, LuSun, LuWrench,
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
/** 唤起面板的快捷键（显示用） */
export const PALETTE_HOTKEY = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen(!open); }
});

interface Cmd { id: string; label: ReactNode; hint?: ReactNode; icon: ReactNode; group: string; run: () => void; keywords?: string }

const HIT_ICON: Record<SearchHit["type"], ReactNode> = {
  service: <LuServer />, task: <LuListTodo />, run: <LuActivity />, role: <LuBot />, knowledge: <LuBrain />, asset: <LuWrench />, session: <LuMessageSquare />,
};
const HIT_GROUP: Record<SearchHit["type"], string> = { service: "服务", task: "任务", run: "运行", role: "角色", knowledge: "记忆", asset: "方法", session: "会话" };

/** 旧后端的教训标题是 lesson:<指纹>：换成副标题里能读的部分（新后端已经给结论第一行） */
const hitTitle = (h: SearchHit) => (h.type === "knowledge" && /^lesson:[0-9a-f]+$/i.test(h.title) ? "教训" : h.title);

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
    if (!q.trim()) { setHits([]); setLoading(false); return; }
    setLoading(true);
    let stale = false;
    const id = setTimeout(() => {
      api.search(q.trim()).then((h) => { if (!stale) setHits(h); }).catch(() => { if (!stale) setHits([]); })
        .finally(() => { if (!stale) setLoading(false); });
    }, 160);
    return () => { stale = true; clearTimeout(id); };
  }, [q]);

  const commands: Cmd[] = useMemo(() => {
    const go = (to: string) => () => navigate(to);
    return [
      { id: "nav-home", label: "概览", icon: <LuLayoutDashboard />, group: "跳转", run: go("/"), keywords: "overview dashboard" },
      { id: "nav-services", label: "服务", icon: <LuServer />, group: "跳转", run: go("/services"), keywords: "services" },
      { id: "nav-tasks", label: "任务", icon: <LuListTodo />, group: "跳转", run: go("/tasks"), keywords: "tasks" },
      { id: "nav-runs", label: "运行", icon: <LuActivity />, group: "跳转", run: go("/runs"), keywords: "runs" },
      { id: "nav-failed", label: "失败的运行", hint: "近 24h", icon: <LuActivity />, group: "跳转", run: go("/runs?status=failed&hours=24"), keywords: "failed" },
      { id: "nav-feedback", label: "反馈", hint: "👎 收件箱", icon: <LuMessageSquareWarning />, group: "跳转", run: go("/runs?view=feedback"), keywords: "feedback thumbs" },
      { id: "nav-replays", label: "回归重放", hint: "用当前定义重跑被 👎 的运行", icon: <LuFlaskConical />, group: "跳转", run: go("/runs?view=replays"), keywords: "replay regression eval" },
      { id: "nav-chat", label: "对话", icon: <LuMessageSquare />, group: "跳转", run: go("/chat"), keywords: "chat session 会话" },
      { id: "nav-memory", label: "记忆", hint: "记忆 · 方法 · 可升格", icon: <LuBrain />, group: "跳转", run: go("/memory"), keywords: "memory knowledge asset 方法" },
      { id: "nav-roles", label: "角色", icon: <LuBot />, group: "跳转", run: go("/settings/roles"), keywords: "roles" },
      { id: "nav-settings", label: "设置", icon: <LuSettings />, group: "跳转", run: go("/settings"), keywords: "settings" },
      { id: "nav-envs", label: "环境设置", icon: <LuLayers />, group: "跳转", run: go("/settings/envs"), keywords: "envs" },
      { id: "nav-notify", label: "通知设置", icon: <LuBell />, group: "跳转", run: go("/settings/notifications"), keywords: "notifications dingtalk 钉钉" },
      { id: "nav-mem-settings", label: "记忆设置", icon: <LuBrain />, group: "跳转", run: go("/settings/memory"), keywords: "memory recall" },
      { id: "nav-prompts", label: "提示词", hint: "平台基础约定", icon: <LuMessageSquareText />, group: "跳转", run: go("/settings/prompts"), keywords: "prompts system" },
      { id: "nav-keys", label: "API 密钥", icon: <LuKeyRound />, group: "跳转", run: go("/settings/api-keys"), keywords: "api key token" },
      { id: "act-run", label: "运行一个任务…", icon: <LuPlay />, group: "操作", run: go("/tasks?run=1"), keywords: "run start" },
      { id: "act-new-chat", label: "新对话", icon: <LuMessageSquare />, group: "操作", run: go("/chat"), keywords: "new chat ask" },
      ...[{ name: "", title: "全部环境" }, ...(envs ?? [])].map((e) => ({
        id: "env-" + e.name, label: `环境视角：${e.name ? `${e.name}（${e.title}）` : "全部环境"}`, icon: <LuLayers />, group: "环境", run: () => setUi({ env: e.name }), keywords: "env " + e.name + " " + e.title,
      })),
      { id: "theme-light", label: "浅色主题", icon: <LuSun />, group: "外观", run: () => setUi({ theme: "light" }), keywords: "theme light" },
      { id: "theme-dark", label: "深色主题", icon: <LuMoon />, group: "外观", run: () => setUi({ theme: "dark" }), keywords: "theme dark" },
      { id: "theme-system", label: "主题跟随系统", icon: <LuMonitor />, group: "外观", run: () => setUi({ theme: "system" }), keywords: "theme system auto" },
    ];
  }, [envs]);

  const items: Cmd[] = useMemo(() => {
    const term = q.trim().toLowerCase();
    const cmds = term ? commands.filter((c) => (String(c.label) + " " + (c.keywords ?? "")).toLowerCase().includes(term)) : commands.slice(0, 9);
    const results = hits.map((h) => ({ id: h.type + h.id, label: hitTitle(h), hint: h.subtitle, icon: HIT_ICON[h.type] ?? <LuSearch />, group: HIT_GROUP[h.type] ?? "其他", run: () => navigate(h.href) }));
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
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索或输入命令…" aria-label="搜索或输入命令"
              className="h-12 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-fg-3"
              onKeyDown={(e) => {
                // 中文输入法选字时的回车 / 方向键属于输入法，不是选命令
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
                else if (e.key === "Enter") { e.preventDefault(); exec(items[sel]); }
              }} />
            <Kbd>Esc</Kbd>
          </div>
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {items.length === 0 && <div className="px-3 py-8 text-center text-[13px] text-fg-3">{loading ? "搜索中…" : "没有符合条件的结果"}</div>}
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
            <span className="ml-auto">{PALETTE_HOTKEY} 随时唤起</span>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
