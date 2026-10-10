// 路由：HashRouter（静态托管无服务端 rewrite，hash 路由免配置）。
import { Route, Routes } from "react-router";
import Layout from "@/components/Layout";
import AdminPage from "@/pages/Admin";
import ApprovalsPage from "@/pages/Approvals";
import ChatPage from "@/pages/Chat";
import GraphPage from "@/pages/Graph";
import MemoryPage from "@/pages/Memory";
import OverviewPage from "@/pages/Overview";
import RunDetailPage from "@/pages/RunDetail";
import RunsPage from "@/pages/Runs";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:runId" element={<RunDetailPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="approvals/:runId" element={<ApprovalsPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="memory" element={<MemoryPage />} />
        <Route path="graph" element={<GraphPage />} />
      </Route>
    </Routes>
  );
}
