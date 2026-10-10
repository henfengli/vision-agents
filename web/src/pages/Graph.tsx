// 引擎拓扑页：Agent 静态结构（与具体 run 无关），首次构建约 30s。

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { TraceGraph } from "@/lib/api";
import { PageHead } from "@/components/common";
import CyGraph from "@/components/CyGraph";
import { Card, CardContent } from "@/components/ui/card";

export default function GraphPage() {
  const [g, setG] = useState<TraceGraph | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.graphTopology().then(setG).catch((e) => setErr(String(e)));
  }, []);

  return (
    <div>
      <PageHead eyebrow="TOPOLOGY" title="Agent 图拓扑"
                meta="引擎静态结构 · 拖拽平移 · 滚轮缩放 · 点击节点高亮" />
      <Card><CardContent className="pt-4">
        {err && <p className="text-sm text-destructive">加载失败:{err}</p>}
        {!g && !err && (
          <p className="text-sm text-muted-foreground py-16 text-center">
            引擎构建中，首次约需 30s…</p>)}
        {g && <CyGraph graph={g} className="h-[70vh] w-full" />}
      </CardContent></Card>
    </div>
  );
}
