/**
 * 浮层：对话框、侧滑抽屉、下拉菜单、气泡、提示、确认框、toast。
 * 全部基于 Headless UI（焦点圈定、Esc、外点关闭、无障碍属性开箱即用）。
 */
import {
  Dialog as HDialog, DialogBackdrop, DialogPanel, DialogTitle, Menu as HMenu, MenuButton, MenuItem, MenuItems,
  MenuSeparator, Popover as HPopover, PopoverButton, PopoverPanel,
} from "@headlessui/react";
import { autoUpdate, flip, offset, shift, useFloating, useHover, useInteractions } from "@floating-ui/react";
import { useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { LuCircleAlert, LuCircleCheck, LuInfo, LuX } from "react-icons/lu";

import { cn } from "@/lib/cn";
import { Button } from "./button";

// ———————— Dialog ————————

export function Dialog({ open, onClose, title, description, children, footer, size = "md", className }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl"; className?: string;
}) {
  const w = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size];
  return (
    <HDialog open={open} onClose={onClose} className="relative z-50">
      <DialogBackdrop transition className="fixed inset-0 bg-black/30 backdrop-blur-[1px] transition duration-150 data-[closed]:opacity-0 dark:bg-black/60" />
      {/* 面板限高：内容长时只滚动中间，标题与底部按钮始终可见 */}
      <div className="fixed inset-0 flex items-start justify-center p-4 pt-[8vh]">
        <DialogPanel transition className={cn("flex max-h-[calc(92dvh-2rem)] w-full flex-col rounded-xl border border-line bg-raised shadow-[var(--shadow-pop)] transition duration-150 data-[closed]:scale-[0.98] data-[closed]:opacity-0", w, className)}>
          <div className="flex items-start gap-3 px-5 pt-4">
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-[15px] font-semibold text-fg">{title}</DialogTitle>
              {description && <div className="mt-1 text-[12.5px] text-fg-3">{description}</div>}
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭"><LuX /></Button>
          </div>
          {children && <div className="min-h-0 overflow-y-auto px-5 py-4">{children}</div>}
          {footer && <div className="flex items-center justify-end gap-2 rounded-b-xl border-t border-line bg-sunken/60 px-5 py-3">{footer}</div>}
        </DialogPanel>
      </div>
    </HDialog>
  );
}

// ———————— Drawer（右侧滑出） ————————

export function Drawer({ open, onClose, title, subtitle, children, actions, width = "w-[560px]" }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; actions?: ReactNode; width?: string;
}) {
  return (
    <HDialog open={open} onClose={onClose} className="relative z-50">
      <DialogBackdrop transition className="fixed inset-0 bg-black/20 transition duration-150 data-[closed]:opacity-0 dark:bg-black/50" />
      <div className="fixed inset-y-0 right-0 flex max-w-full">
        <DialogPanel transition className={cn("flex h-full max-w-[100vw] flex-col border-l border-line bg-panel shadow-[var(--shadow-pop)] transition duration-200 ease-out data-[closed]:translate-x-6 data-[closed]:opacity-0", width)}>
          <div className="flex items-start gap-3 border-b border-line px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-[14px] font-semibold text-fg">{title}</DialogTitle>
              {subtitle && <div className="mt-0.5 truncate text-xs text-fg-3">{subtitle}</div>}
            </div>
            {actions}
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭"><LuX /></Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </DialogPanel>
      </div>
    </HDialog>
  );
}

// ———————— Menu ————————

export interface MenuEntry {
  label: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
  separator?: boolean;
}

export function Menu({ trigger, items, align = "end" }: { trigger: ReactElement; items: MenuEntry[]; align?: "start" | "end" }) {
  return (
    <HMenu>
      <MenuButton as="div" className="inline-flex">{trigger}</MenuButton>
      <MenuItems anchor={{ to: `bottom ${align}`, gap: 4 }} transition
        className="z-50 min-w-44 rounded-lg border border-line bg-raised p-1 shadow-[var(--shadow-pop)] outline-none transition duration-100 data-[closed]:opacity-0 data-[closed]:-translate-y-0.5">
        {items.map((it, i) => it.separator ? <MenuSeparator key={i} className="my-1 h-px bg-line" /> : (
          <MenuItem key={i} disabled={it.disabled}>
            <button type="button" onClick={it.onClick}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] data-[focus]:bg-hover data-[disabled]:opacity-50 [&_svg]:size-3.5",
                it.danger ? "text-bad" : "text-fg")}>
              {it.icon && <span className={cn(it.danger ? "text-bad" : "text-fg-3")}>{it.icon}</span>}
              <span className="flex-1">{it.label}</span>
              {it.hint && <span className="text-xs text-fg-3">{it.hint}</span>}
            </button>
          </MenuItem>
        ))}
      </MenuItems>
    </HMenu>
  );
}

// ———————— Popover ————————

export function Popover({ trigger, children, className, align = "start" }: { trigger: ReactNode; children: ReactNode | ((close: () => void) => ReactNode); className?: string; align?: "start" | "end" }) {
  return (
    <HPopover>
      <PopoverButton as="div" className="inline-flex">{trigger}</PopoverButton>
      <PopoverPanel anchor={{ to: `bottom ${align}`, gap: 6 }} transition
        className={cn("z-50 rounded-lg border border-line bg-raised shadow-[var(--shadow-pop)] outline-none transition duration-100 data-[closed]:opacity-0", className)}>
        {({ close }) => (typeof children === "function" ? children(close) : children)}
      </PopoverPanel>
    </HPopover>
  );
}

// ———————— Tooltip ————————

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactElement; side?: "top" | "bottom" | "right" | "left" }) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open, onOpenChange: setOpen, placement: side, whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  });
  const hover = useHover(context, { delay: { open: 350, close: 0 } });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover]);
  if (!content) return children;
  return (
    <>
      <span ref={refs.setReference} className="inline-flex max-w-full" {...getReferenceProps()}>{children}</span>
      {open && (
        <div ref={refs.setFloating} style={floatingStyles} {...getFloatingProps()}
          className="pointer-events-none z-[60] max-w-xs animate-in rounded-md bg-[#111318] px-2 py-1 text-xs leading-snug text-white shadow-lg dark:bg-[#2a2c33]">
          {content}
        </div>
      )}
    </>
  );
}

// ———————— 确认框（命令式：await confirm({...})） ————————

export function confirm(opts: { title: ReactNode; description?: ReactNode; confirmText?: string; danger?: boolean; requireText?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: boolean) => {
      resolve(v);
      setTimeout(() => { root.unmount(); host.remove(); }, 200);
    };
    function Confirm() {
      const [open, setOpen] = useState(true);
      const [typed, setTyped] = useState("");
      const close = (v: boolean) => { setOpen(false); done(v); };
      return (
        <Dialog open={open} onClose={() => close(false)} size="sm" title={opts.title} description={opts.description}
          footer={<>
            <Button onClick={() => close(false)}>取消</Button>
            <Button variant={opts.danger ? "danger" : "primary"} disabled={!!opts.requireText && typed !== opts.requireText} onClick={() => close(true)}>
              {opts.confirmText ?? "确定"}
            </Button>
          </>}>
          {opts.requireText ? (
            <div className="text-[12.5px] text-fg-2">
              输入 <code className="rounded bg-sunken px-1 font-mono text-fg">{opts.requireText}</code> 以确认
              <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)}
                className="mt-2 h-8 w-full rounded-md border border-line bg-panel px-2.5 font-mono text-[13px] outline-none focus:border-accent" />
            </div>
          ) : undefined}
        </Dialog>
      );
    }
    root.render(<Confirm />);
  });
}

// ———————— Toast ————————

interface ToastItem { id: number; tone: "ok" | "bad" | "info"; title: ReactNode; description?: ReactNode; action?: { label: string; onClick: () => void } }
let toasts: ToastItem[] = [];
const toastListeners = new Set<() => void>();
let seq = 0;
const emitToasts = () => toastListeners.forEach((l) => l());

export function toast(title: ReactNode, opts: { tone?: ToastItem["tone"]; description?: ReactNode; action?: ToastItem["action"]; duration?: number } = {}) {
  const id = ++seq;
  toasts = [...toasts, { id, tone: opts.tone ?? "ok", title, description: opts.description, action: opts.action }];
  emitToasts();
  setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); emitToasts(); }, opts.duration ?? 4200);
}
toast.error = (title: ReactNode, description?: ReactNode) => toast(title, { tone: "bad", description, duration: 6000 });
toast.info = (title: ReactNode, description?: ReactNode) => toast(title, { tone: "info", description });

export function Toaster() {
  const list = useSyncExternalStore((l) => { toastListeners.add(l); return () => toastListeners.delete(l); }, () => toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[360px] flex-col gap-2">
      {list.map((t) => (
        <div key={t.id} className="pointer-events-auto flex animate-pop gap-2.5 rounded-lg border border-line bg-raised px-3.5 py-3 shadow-[var(--shadow-pop)]">
          <div className={cn("mt-0.5 [&_svg]:size-4", { ok: "text-ok", bad: "text-bad", info: "text-info" }[t.tone])}>
            {t.tone === "ok" ? <LuCircleCheck /> : t.tone === "bad" ? <LuCircleAlert /> : <LuInfo />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-fg">{t.title}</div>
            {t.description && <div className="mt-0.5 break-words text-xs text-fg-3">{t.description}</div>}
          </div>
          {t.action && <Button size="xs" variant="ghost" className="text-accent" onClick={t.action.onClick}>{t.action.label}</Button>}
        </div>
      ))}
    </div>
  );
}
