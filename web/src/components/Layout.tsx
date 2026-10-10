// 应用骨架：左侧导航 + 顶栏（LIVE 指示 + 审批角标 + 版本 + 退出）。
// 所有页面共享；登录未通过时整树替换为登录卡。

import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";
import {
  Activity, Bot, Brain, CircleDot, GitBranch, LayoutDashboard,
  MessagesSquare, ShieldCheck, LogOut,
} from "lucide-react";
import { api, clearToken, getToken, setToken, Unauthorized, isDemo } from "@/lib/api";
import type { Meta } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageErrorBoundary } from "@/components/PageErrorBoundary";

const NAV = [
  { to: "/", label: "总览", icon: LayoutDashboard },
  { to: "/chat", label: "对话", icon: MessagesSquare },
  { to: "/runs", label: "Runs", icon: Activity },
  { to: "/approvals", label: "审批", icon: ShieldCheck },
  { to: "/admin", label: "管理", icon: Bot },
  { to: "/memory", label: "记忆", icon: Brain },
  { to: "/graph", label: "拓扑", icon: GitBranch },
];

export default function Layout() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    api.meta()
      .then(setMeta)
      .catch((e) => { if (e instanceof Unauthorized) setNeedLogin(true); });
    api.approvals().then((a) => setPending(a.count)).catch(() => {});
  }, []);

  if (needLogin && !isDemo) {
    return <LoginCard onOk={() => setNeedLogin(false)} />;
  }

  return (
    <div className="dark min-h-screen bg-background text-foreground flex">
      <aside className="w-48 shrink-0 border-r border-border flex flex-col">
        <div className="px-4 py-4 flex items-center gap-2 font-mono text-sm">
          <CircleDot className="size-4 text-cyan-400" />
          agent-platform
        </div>
        <nav className="flex-1 px-2 space-y-0.5">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive ? "bg-accent text-accent-foreground"
                           : "text-muted-foreground hover:bg-accent/50"}`}>
              <Icon className="size-4" />
              {label}
              {label === "审批" && pending > 0 && (
                <Badge variant="destructive"
                       className="ml-auto px-1.5 py-0 text-[10px]">
                  {pending}
                </Badge>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 py-3 text-xs text-muted-foreground font-mono space-y-1">
          <div>env: {meta?.env ?? "…"}</div>
          <div>v{meta?.version ?? "…"}</div>
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        <header className="h-12 border-b border-border flex items-center justify-end px-6 gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
            LIVE
          </span>
          {!isDemo && (
            <button className="flex items-center gap-1 hover:text-foreground"
                    onClick={() => { clearToken(); location.reload(); }}>
              <LogOut className="size-3.5" /> 退出
            </button>
          )}
        </header>
        <div className="p-6 max-w-6xl mx-auto">
          <PageErrorBoundary><Outlet /></PageErrorBoundary>
        </div>
      </main>
    </div>
  );
}

function LoginCard({ onOk }: { onOk: () => void }) {
  const [token, setTokenInput] = useState(getToken());
  const [err, setErr] = useState("");
  return (
    <div className="dark min-h-screen bg-background flex items-center justify-center">
      <Card className="w-96">
        <CardHeader>
          <CardTitle className="font-mono text-base">agent-platform</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input type="password" placeholder="访问令牌"
                 value={token}
                 onChange={(e) => setTokenInput(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" &&
                   document.getElementById("login-btn")?.click()} />
          {err && <p className="text-xs text-destructive">{err}</p>}
          <Button id="login-btn" className="w-full" onClick={async () => {
            setToken(token);
            try {
              await api.meta();
              onOk();
            } catch {
              clearToken();
              setErr("令牌不正确");
            }
          }}>登录</Button>
          <p className="text-xs text-muted-foreground">
            令牌即服务的 bearer token，仅存本浏览器 localStorage。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
