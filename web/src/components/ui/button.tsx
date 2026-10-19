import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { LuLoaderCircle } from "react-icons/lu";

import { cn } from "@/lib/cn";
import { Link } from "@/lib/router";

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
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading, icon, children, disabled, type = "button", ...props }, ref,
) {
  return (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {loading ? <LuLoaderCircle className="animate-spin" /> : icon}
      {children}
    </button>
  );
});

export function LinkButton({ to, className, variant, size, icon, children, ...rest }: { to: string; icon?: ReactNode; children?: ReactNode; className?: string; target?: string } & Variants) {
  return (
    <Link to={to} className={cn(buttonVariants({ variant, size }), className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
