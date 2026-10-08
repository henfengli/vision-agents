#!/usr/bin/env bash
# agent-platform 安装脚本：一套代码，按需启动（无容器、默认不部署多套服务）
#
# 模型变更（v4.2）：prod/test/dev 几乎只有配置文件不同，不再各部署一套
# systemd 服务。装一份代码，要哪个环境就起哪个：
#
#   /opt/agent-platform/venv/bin/python3 -m agent_platform.envrun test
#
# envrun 用 bwrap 遮蔽其他环境的配置文件，且 --die-with-parent——
# 启动它的会话结束，服务自动结束。常驻 prod（可选）见脚本末尾提示。
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# 1. 低权限用户（常驻模式与 temporal 用；按需模式下 envrun 以操作者身份跑）
id agent-svc &>/dev/null || useradd -r -s /usr/sbin/nologin agent-svc

# 2. 代码包与运行目录（只装一份）
mkdir -p /opt/agent-platform
cp -r "$PKG_DIR"/src "$PKG_DIR"/conf "$PKG_DIR"/pyproject.toml /opt/agent-platform/
mkdir -p /var/lib/agent-platform/scratch /var/log/agent-platform /etc/agent-platform
mkdir -p /var/lib/temporal                       # temporal-server.service 的 SQLite 目录
chown -R agent-svc:agent-svc /var/lib/agent-platform /var/log/agent-platform /var/lib/temporal
chown -R root:root /opt/agent-platform          # 代码包 root 所有，运行方只读

# 3. 依赖
python3 -m venv /opt/agent-platform/venv
/opt/agent-platform/venv/bin/pip install /opt/agent-platform

# 4. 环境 secrets：每环境一份 /etc/agent-platform/secrets.<env>.env
#    （640 root:agent-svc；envrun 进程只能读到本环境那份——其余被 bwrap 遮蔽）
ls /etc/agent-platform/secrets.*.env /etc/agent-platform/secrets.env 2>/dev/null || {
    echo "!! 请放置 /etc/agent-platform/secrets.<env>.env"
    echo "   （MODEL_TOKEN_A/AGENT_DB_PASSWORD/DINGTALK_ACCESS_TOKEN/AGENT_BEARER_TOKEN）"
}

# 5. Temporal 是唯一需要常驻的共享基建（与 env 无关）
cp "$PKG_DIR/deploy/temporal-server.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now temporal-server

cat <<'EOF'

安装完成。使用方式：

  按需启动（推荐，test/dev/临时 prod 调试）：
    /opt/agent-platform/venv/bin/python3 -m agent_platform.envrun <env>
    前台运行；启动它的会话结束，服务自动结束。
    先看将执行什么：... envrun <env> --print

  常驻 prod（可选，需要 7×24 才做）：
    cp deploy/agent-platform.service /etc/systemd/system/
    systemctl enable --now agent-platform
EOF
