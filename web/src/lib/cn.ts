import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** class 合并：clsx 处理条件，twMerge 处理同类冲突（后者赢） */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
