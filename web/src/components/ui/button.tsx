import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { LuLoaderCircle } from "react-icons/lu";

import { cn } from "@/lib/cn";
import { Link } from "@/lib/router";
import { Tooltip } from "./overlay";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background,color,border,box-shadow] select-none disabled:opacity-50 disabled:pointer-events-none [&_svg]:size-[15px] [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg shadow-sm hover:bg-[color-mix(in_oklab,var(--color-accent)_88%,black)]",
        secondary: "bg-panel text-fg border border-line shadow-[var(--shadow-card)] hover:bg-hover hover:border-line-strong",
        ghost: "text-fg-2 hover:bg-hover hover:text-fg",
        danger: "bg-bad text-white shadow-sm hover:bg-[color-mix(in_oklab,var(--color-bad)_88%,black)]",
        "danger-ghost": "text-bad hover:bg-bad-soft",
        link: "text-accent hover:underline underline-offset-2 px-0 h-auto",
      },
      size: {
        xs: "h-6 px-2 text-xs [&_svg]:size-[13px]",
        sm: "h-7 px-2.5 text-[12.5px]",
        md: "h-8 px-3 text-[13px]",
        lg: "h-9 px-4 text-sm",
        icon: "size-8",
        "icon-sm": "size-7",
        "icon-xs": "size-6 [&_svg]:size-[13px]",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

type Variants = VariantProps<typeof buttonVariants>;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, Variants {
  loading?: boolean;
  icon?: ReactNode;
  /**
   * 现在不能用的原因：给了就禁用，悬停显示原因（按钮留在原位，不随状态消失）。
   * 禁用按钮带 pointer-events-none，原生 title 不会出现，所以原因一律走这里，不要写在 title 上。
   */
  reason?: ReactNode;
  /** 能用时的悬停说明（和 reason 同一个提示框） */
  tip?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading, icon, children, disabled, reason, tip, type = "button", ...props }, ref,
) {
  const btn = (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading || !!reason}
      aria-disabled={reason ? true : undefined} {...props}>
      {loading ? <LuLoaderCircle className="animate-spin" /> : icon}
      {children}
    </button>
  );
  const hint = reason || tip;
  // 禁用的按钮收不到鼠标事件：Tooltip 的悬停挂在它外面那层 span 上
  return hint ? <Tooltip content={hint}>{btn}</Tooltip> : btn;
});

export function LinkButton({ to, className, variant, size, icon, children, ...rest }: { to: string; icon?: ReactNode; children?: ReactNode; className?: string; target?: string } & Variants) {
  return (
    <Link to={to} className={cn(buttonVariants({ variant, size }), className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
