"""agent-chat：终端里和某个服务的 agent 对话（过程实时可见）。

    agent-chat board                    # 默认环境
    agent-chat board --env prod
    agent-chat board --resume <会话 id>
    agent-chat board --task data-qa

AGENT_URL / AGENT_KEY 从环境变量读。会话在服务端持久化，跨天、跨机器可续。
"""

from __future__ import annotations

import argparse
import sys

from .client import AgentClient, AgentError


def _progress(ev: dict) -> None:
    if ev["type"] == "tool_call":
        print(f"  ⚙ {ev.get('tool', '?')}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(prog="agent-chat", description="和服务的 agent 对话")
    ap.add_argument("service", help="服务名，如 board")
    ap.add_argument("--env", help="环境，缺省为平台默认环境")
    ap.add_argument("--task", help="对话任务，缺省为该服务的对话任务")
    ap.add_argument("--resume", help="续一个已有会话")
    args = ap.parse_args()

    agent = AgentClient(service=args.service, env=args.env)
    agent.session_id = args.resume
    print(f"[{args.service}@{args.env or '默认环境'}] 输入问题开始对话，Ctrl+C 退出")
    while True:
        try:
            question = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not question:
            continue
        try:
            print(agent.ask(question, task=args.task, on_event=_progress))
        except AgentError as e:
            print(f"[错误] {e}", file=sys.stderr)
        if agent.session_id:
            print(f"  （会话 {agent.session_id}）", file=sys.stderr)


if __name__ == "__main__":
    main()
