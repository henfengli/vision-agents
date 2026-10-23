"""命令行入口。

    agent-platform serve [--host H] [--port P] [--no-worker]   接口 + 控制台（默认同进程跑 worker；监听默认取部署配置 listen）
    agent-platform worker                                                  只跑 worker：执行队列、定时、维护循环
    agent-platform check                                                   读配置、连库、播种，然后退出

uvicorn 直接起：uvicorn --factory agent_platform.main:app
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal

from .config import load_settings


def app():
    """uvicorn --factory 入口：读 AGENT_ENV 对应的部署配置。"""
    from .api import create_app
    return create_app(load_settings())


def _serve(args) -> None:
    import os

    import uvicorn

    from .api import create_app
    settings = load_settings()
    listen = settings.listen
    tls = {}
    if listen.tls_cert and listen.tls_key:      # 没有反代时直接 HTTPS
        tls = {"ssl_certfile": os.path.expanduser(listen.tls_cert), "ssl_keyfile": os.path.expanduser(listen.tls_key)}
    uvicorn.run(create_app(settings, worker=not args.no_worker), host=args.host or listen.host,
                port=args.port or listen.port, log_level="info", proxy_headers=True, **tls)


def _worker(_args) -> None:
    from .runtime import assemble

    async def run() -> None:
        rt = await assemble(load_settings())
        await rt.start_worker()
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:          # Windows 的事件循环不支持：Ctrl+C 走 KeyboardInterrupt
                pass
        await stop.wait()
        await rt.close()

    asyncio.run(run())


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
              f"服务 {len(await registry.services())} 个，任务 {len(await registry.tasks())} 个")
        await db.close_db()

    asyncio.run(run())


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(prog="agent-platform")
    sub = ap.add_subparsers(dest="cmd", required=True)
    serve = sub.add_parser("serve", help="接口 + 控制台")
    serve.add_argument("--host", help="默认取部署配置 listen.host（127.0.0.1）")
    serve.add_argument("--port", type=int, help="默认取部署配置 listen.port（8100）")
    serve.add_argument("--no-worker", action="store_true", help="worker 单独部署时用")
    serve.set_defaults(fn=_serve)
    sub.add_parser("worker", help="只跑 worker").set_defaults(fn=_worker)
    sub.add_parser("check", help="检查配置与数据库并播种").set_defaults(fn=_check)
    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
