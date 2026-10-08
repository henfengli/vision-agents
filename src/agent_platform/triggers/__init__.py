"""触发层：外部事件 → run。

- dagster_sensor  Dagster 报错回调（规则先行分类，疑难才建 run）
- gitlab_webhook  部署完成 → 冒烟任务
- chat            CLI/Web 对话（含 SSE 流式）
"""
