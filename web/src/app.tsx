import { useEffect } from "react";

import { AppShell } from "./components/layout/shell";
import { CommandPalette } from "./components/layout/palette";
import { Toaster } from "./components/ui/overlay";
import { Empty } from "./components/ui/primitives";
import { LinkButton } from "./components/ui/button";
import { ApprovalsPage } from "./features/approvals/approvals";
import { ChatPage } from "./features/chat/chat";
import { LoginPage } from "./features/login";
import { MemoryPage } from "./features/memory/memory";
import { OverviewPage } from "./features/overview/overview";
import { RunDetailPage } from "./features/runs/run-detail";
import { RunsPage } from "./features/runs/runs";
import { ServiceDetailPage } from "./features/services/service-detail";
import { ServicesPage } from "./features/services/services";
import { EnvsPage } from "./features/settings/envs";
import { PoliciesPage } from "./features/settings/policies";
import { RoleDetailPage, RolesPage } from "./features/settings/roles";
import { TaskDetailPage } from "./features/tasks/task-detail";
import { TasksPage } from "./features/tasks/tasks";
import { navigate, Routes, useLocation, type RouteDef } from "./lib/router";

const routes: RouteDef[] = [
  { path: "/", component: OverviewPage },
  { path: "/services", component: ServicesPage },
  { path: "/services/:name", component: ServiceDetailPage },
  { path: "/tasks", component: TasksPage },
  { path: "/tasks/:name", component: TaskDetailPage },
  { path: "/runs", component: RunsPage },
  { path: "/runs/:id", component: RunDetailPage },
  { path: "/chat", component: ChatPage },
  { path: "/chat/:session", component: ChatPage },
  { path: "/approvals", component: ApprovalsPage },
  { path: "/memory", component: MemoryPage },
  { path: "/settings/roles", component: RolesPage },
  { path: "/settings/roles/:name", component: RoleDetailPage },
  { path: "/settings/policies", component: PoliciesPage },
  { path: "/settings/envs", component: EnvsPage },
];

function NotFound() {
  return <Empty className="py-32" title="页面不存在" description="链接可能已失效" action={<LinkButton to="/">回到概览</LinkButton>} />;
}

export function App() {
  const { path } = useLocation();
  useEffect(() => {
    const onUnauthorized = () => navigate("/login?next=" + encodeURIComponent(window.location.pathname + window.location.search), { replace: true });
    window.addEventListener("ap:unauthorized", onUnauthorized);
    return () => window.removeEventListener("ap:unauthorized", onUnauthorized);
  }, []);
  if (path === "/login") return <><LoginPage /><Toaster /></>;
  return (
    <>
      <AppShell>
        <Routes routes={routes} fallback={NotFound} />
      </AppShell>
      <CommandPalette />
      <Toaster />
    </>
  );
}
