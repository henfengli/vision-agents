/**
 * 个人偏好：只存在这台浏览器（localStorage），不影响别人。
 */
import { LuMonitor, LuMoon, LuRotateCcw, LuSun } from "react-icons/lu";

import { useEnvs, useServices, useTasks } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Select, Segmented, Switch } from "@/components/ui/form";
import { toast } from "@/components/ui/overlay";
import { Card, CardHeader } from "@/components/ui/primitives";
import { resetUi, setUi, useUi, type UiState } from "@/lib/store";
import { SettingRow, SettingsLayout } from "./layout";

export function PreferencesPage() {
  const ui = useUi();
  const { data: envs } = useEnvs();
  const { data: services } = useServices();
  const { data: tasks } = useTasks();
  const chatTasks = (tasks ?? []).filter((t) => !t.extends && t.triggers.some((tr) => tr.type === "chat"));
  const setChat = (patch: Partial<UiState["chat"]>) => setUi({ chat: { ...ui.chat, ...patch } });
  return (
    <SettingsLayout title="个人偏好" description="这些设置只保存在当前浏览器里，换台电脑或清缓存会回到默认值。"
      actions={<Button icon={<LuRotateCcw />} onClick={() => { resetUi(); toast("已恢复默认"); }}>恢复默认</Button>}>
      <div className="space-y-4">
        <Card>
          <CardHeader title="外观" />
          <div className="divide-y divide-line">
            <SettingRow title="主题">
              <Segmented value={ui.theme} onChange={(theme) => setUi({ theme })} options={[
                { value: "light", label: "浅色", icon: <LuSun /> }, { value: "dark", label: "深色", icon: <LuMoon /> }, { value: "system", label: "跟随系统", icon: <LuMonitor /> },
              ]} />
            </SettingRow>
            <SettingRow title="列表密度" hint="紧凑模式每行更矮，一屏看到更多">
              <Segmented value={ui.density} onChange={(density) => setUi({ density })} options={[{ value: "comfortable", label: "舒适" }, { value: "compact", label: "紧凑" }]} />
            </SettingRow>
            <SettingRow title="时间显示" hint="相对时间：3 分钟前；绝对时间：10-20 09:41">
              <Segmented value={ui.timeFormat} onChange={(timeFormat) => setUi({ timeFormat })} options={[{ value: "relative", label: "相对" }, { value: "absolute", label: "绝对" }]} />
            </SettingRow>
          </div>
        </Card>
        <Card>
          <CardHeader title="浏览" />
          <div className="divide-y divide-line">
            <SettingRow title="打开控制台时进入" hint="访问根路径时跳到这里">
              <Select className="w-44" value={ui.landing} onChange={(landing) => setUi({ landing })} options={[
                { value: "/", label: "概览" }, { value: "/services", label: "服务" }, { value: "/tasks", label: "任务" }, { value: "/runs", label: "运行" }, { value: "/chat", label: "对话" },
              ]} />
            </SettingRow>
            <SettingRow title="默认环境视角" hint="顶栏的环境切换；列表与统计默认按它过滤">
              <Select className="w-44" value={ui.env} onChange={(env) => setUi({ env })}
                options={[{ value: "", label: "全部环境" }, ...(envs ?? []).map((e) => ({ value: e.name, label: <span className="font-mono uppercase">{e.name}</span>, hint: e.title }))]} />
            </SettingRow>
            <SettingRow title="每页条数" hint="运行列表">
              <Segmented value={String(ui.pageSize) as "30"} onChange={(v) => setUi({ pageSize: Number(v) as UiState["pageSize"] })}
                options={[{ value: "30", label: "30" }, { value: "50", label: "50" }, { value: "100", label: "100" }]} />
            </SettingRow>
            <SettingRow title="列表自动刷新" hint="关掉后列表只在切回页面或手动刷新时更新；运行中的详情与对话始终实时">
              <Switch checked={ui.autoRefresh} onChange={(autoRefresh) => setUi({ autoRefresh })} />
            </SettingRow>
          </div>
        </Card>
        <Card>
          <CardHeader title="对话默认项" description="新开会话时预选的服务、环境与任务" />
          <div className="divide-y divide-line">
            <SettingRow title="服务">
              <Select className="w-52" value={ui.chat.service} onChange={(service) => setChat({ service })}
                options={[{ value: "", label: "第一个可用的服务" }, ...(services ?? []).map((s) => ({ value: s.name, label: s.name, hint: s.title }))]} />
            </SettingRow>
            <SettingRow title="环境">
              <Select className="w-52" value={ui.chat.env} onChange={(env) => setChat({ env })}
                options={[{ value: "", label: "跟随默认环境视角" }, ...(envs ?? []).map((e) => ({ value: e.name, label: <span className="font-mono uppercase">{e.name}</span>, hint: e.title }))]} />
            </SettingRow>
            <SettingRow title="任务" hint="不选则用服务专属的对话任务，没有就用通用入口「问一下」">
              <Select className="w-52" value={ui.chat.task} onChange={(task) => setChat({ task })}
                options={[{ value: "", label: "服务的对话任务" }, ...chatTasks.map((t) => ({ value: t.name, label: t.title || t.name, hint: t.name === "ask" ? "ask · 通用入口" : t.name }))]} />
            </SettingRow>
            <SettingRow title="召回记忆" hint="提问前先查记忆（事实、报错教训）与方法">
              <Switch checked={ui.chat.recall} onChange={(recall) => setChat({ recall })} />
            </SettingRow>
            <SettingRow title="沉淀记忆" hint="回答后把可复用的结论记成记忆">
              <Switch checked={ui.chat.save} onChange={(save) => setChat({ save })} />
            </SettingRow>
          </div>
        </Card>
      </div>
    </SettingsLayout>
  );
}
