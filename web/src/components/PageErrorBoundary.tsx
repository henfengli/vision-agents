// 页面级错误边界：单页渲染异常只降级本页，不拖垮整个 SPA
// （hash 路由不整页刷新，没有边界时一个页崩溃会让后续所有页白屏）。

import { Component, type ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";

export class PageErrorBoundary extends Component<
  { children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <Card><CardContent className="pt-4">
          <p className="text-sm text-red-400 font-mono">
            页面渲染出错：{String(this.state.err)}
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            切换左侧导航到其他页可恢复；若反复出现请截图反馈。
          </p>
        </CardContent></Card>
      );
    }
    return this.props.children;
  }
}
