"""环境服务入口：由 envrun 在 bwrap 沙箱内 exec，也可独立 `python -m` 运行。

存在理由：host/port 从 Settings 读——配置是唯一事实源，
不再在 systemd unit / 启动脚本里各抄一份端口号。
"""

from __future__ import annotations


def main() -> None:
    import uvicorn

    from . import config
    settings = config.load_settings()   # AGENT_ENV 由启动环境注入
    uvicorn.run("agent_platform.main:build_app", factory=True,
                host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
