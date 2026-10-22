/**
 * 未保存修改的浮动条：所有"编辑整份定义 / 配置"的页面共用。
 */
import { Button } from "./ui/button";

export function SaveBar({ visible, onSave, onDiscard, saving, label = "保存" }: {
  visible: boolean; onSave: () => void; onDiscard: () => void; saving?: boolean; label?: string;
}) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex animate-pop items-center gap-3 rounded-xl border border-line bg-raised py-2 pl-4 pr-2 shadow-[var(--shadow-pop)]">
        <span className="size-2 rounded-full bg-warn" /><span className="text-[13px] text-fg">有未保存的修改</span>
        <Button size="sm" variant="ghost" onClick={onDiscard}>放弃</Button>
        <Button size="sm" variant="primary" loading={saving} onClick={onSave}>{label}</Button>
      </div>
    </div>
  );
}
