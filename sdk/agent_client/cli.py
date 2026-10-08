"""agent-chat：交互式对话 CLI。

    agent-chat --server board --role data_searcher
    agent-chat --server board --role data_searcher --resume board-fee-a1b2

会话自动持久化在服务端（session_id 即 LangGraph thread），跨天、跨机器可续。
"""

from __future__ import annotations

import argparse
import sys
import uuid

from .client import AgentClient, AgentError


def main() -> None:
    parser = argparse.ArgumentParser(prog="agent-chat", description="Agent 平台交互式对话")
    parser.add_argument("--server", required=True, help="业务域，如 board")
    parser.add_argument("--role", required=True, help="角色，如 data_searcher")
    parser.add_argument("--resume", help="恢复指定 session_id 的会话")
    parser.add_argument("--env", help="目标业务环境（服务端配了 target_envs 时）")
    args = parser.parse_args()

    client = AgentClient(server=args.server, role=args.role, env=args.env)
    session_id = args.resume or uuid.uuid4().hex[:12]
    client.set_session(session_id)

    env_tip = f" env={args.env}" if args.env else ""
    print(f"[session: {session_id}{env_tip}] 输入问题开始对话，Ctrl+C 退出")
    while True:
        try:
            question = input(f"[{session_id}] > ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not question:
            continue
        try:
            answer = client.ask(question)
        except AgentError as e:
            print(f"[错误] {e}", file=sys.stderr)
            continue
        print(answer)


if __name__ == "__main__":
    main()
