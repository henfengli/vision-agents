import { useEffect } from "react";

import { AppShell } from "./components/layout/shell";
import { CommandPalette } from "./components/layout/palette";
import { Toaster } from "./components/ui/overlay";
import { Empty } from "./components/ui/primitives";
import { LinkButton } from "./components/ui/button";
import { ChatPage } from "./features/chat/chat";
import { LoginPage } from "./features/login";
import { MemoryPage } from "./features/memory/memory";
import { OverviewPage } from "./features/overview/overview";
import { ReplayDetailPage, ReplaysRedirect } from "./features/runs/replays";
import { RunDetailPage } from "./features/runs/run-detail";
import { RunsPage } from "./features/runs/runs";
import { ServiceDetailPage } from "./features/services/service-detail";
import { ServicesPage } from "./features/services/services";
import { ApiKeysPage } from "./features/settings/api-keys";
import {
  EnvsSettingsPage, MemorySettingsPage, NotificationsSettingsPage, ProcessesSettingsPage, PromptsSettingsPage,
} from "./features/settings/platform";
import { PreferencesPage } from "./features/settings/preferences";
import { RoleDetailPage, RolesPage } from "./features/settings/roles";
import { TaskDetailPage } from "./features/tasks/task-detail";
import { TasksPage } from "./features/tasks/tasks";
import { navigate, Routes, useLocation, type RouteDef } from "./lib/router";
import { getUi } from "./lib/store";

const routes: RouteDef[] = [
  { path: "/", component: OverviewPage },
  { path: "/services", component: ServicesPage },
  { path: "/services/:name", component: ServiceDetailPage },
  { path: "/tasks", component: TasksPage },
  { path: "/tasks/:name", component: TaskDetailPage },
  { path: "/runs", component: RunsPage },
  { path: "/runs/:id", component: RunDetailPage },
  { path: "/replays", component: ReplaysRedirect },
  { path: "/replays/:id", component: ReplayDetailPage },
  { path: "/chat", component: ChatPage },
  { path: "/chat/:session", component: ChatPage },
  { path: "/memory", component: MemoryPage },
  { path: "/settings", component: PreferencesPage },
  { path: "/settings/preferences", component: PreferencesPage },
  { path: "/settings/envs", component: EnvsSettingsPage },
  { path: "/settings/notifications", component: NotificationsSettingsPage },
  { path: "/settings/memory", component: MemorySettingsPage },
  { path: "/settings/processes", component: ProcessesSettingsPage },
  { path: "/settings/prompts", component: PromptsSettingsPage },
  { path: "/settings/roles", component: RolesPage },
  { path: "/settings/roles/:name", component: RoleDetailPage },
  { path: "/settings/api-keys", component: ApiKeysPage },
];

function NotFound() {
  return <Empty className="py-32" title="页面不存在" description="链接可能已失效" action={<LinkButton to="/">回到概览</LinkButton>} />;
}

export function App() {
  const { path } = useLocation();
  useEffect(() => {
    // 个人偏好"打开控制台时进入"：只在刚打开、落在根路径时跳一次
    if (path === "/" && getUi().landing !== "/") navigate(getUi().landing, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onUnauthorized = () => navigate("/login?next=" + encodeURIComponent(window.location.pathname + window.location.search), { replace: true, force: true });
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
