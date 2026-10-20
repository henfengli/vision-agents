"""事件触发：统一入口 POST /v1/events/{source}（events）+ 各系统的回调解析（sources）。

定时触发在 orchestration/scheduler.py；API / 对话直接走提交端。
"""
