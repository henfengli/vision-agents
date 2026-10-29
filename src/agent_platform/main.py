"""命令行入口。

    agent-platform serve [--host H] [--port P]   接口 + 控制台 + worker（执行队列、定时、维护循环）；监听默认取部署配置 listen
    agent-platform check                         读配置、连库、播种，然后退出
"""

from __future__ import annotations

import argparse
import asyncio
import logging

from .config import load_settings


def _serve(args) -> None:
    import os

    import uvicorn

    from .api import create_app
    settings = load_settings()
    listen = settings.listen
    tls = {}
    if listen.tls_cert and listen.tls_key:      # 没有反代时直接 HTTPS
        tls = {"ssl_certfile": os.path.expanduser(listen.tls_cert), "ssl_keyfile": os.path.expanduser(listen.tls_key)}
    uvicorn.run(create_app(settings), host=args.host or listen.host, port=args.port or listen.port,
                log_level="info", proxy_headers=True, **tls)


def _check(_args) -> None:
    from .registry import Registry
    from .store import db
    from .store.definitions import DefinitionStore

    async def run() -> None:
        settings = load_settings()
        await db.open_db(settings.db_dsn)
        registry = Registry(DefinitionStore())
        await registry.seed(settings.seeds_dir)
        envs = await registry.envs()
        print(f"配置 {settings.profile} 正常；环境 {'、'.join(envs.names)}（默认 {envs.default}）；"
              f"服务 {len(await registry.services())} 个，任务 {len(await registry.tasks())} 个；"
              f"模型 {settings.model.name}"
              f"{'，备用 ' + fb.name if (fb := settings.model.fallback_config()) else '，没有备用'}；"
              f"这台负责 {settings.env or '所有环境'}{'（' + '、'.join(settings.services) + '）' if settings.services else ''}")
        await db.close_db()

    asyncio.run(run())


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(prog="agent-platform")
    sub = ap.add_subparsers(dest="cmd", required=True)
    serve = sub.add_parser("serve", help="接口 + 控制台 + worker")
    serve.add_argument("--host", help="默认取部署配置 listen.host（127.0.0.1）")
    serve.add_argument("--port", type=int, help="默认取部署配置 listen.port（8100）")
    serve.set_defaults(fn=_serve)
    sub.add_parser("check", help="检查配置与数据库并播种").set_defaults(fn=_check)
    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
