#!/usr/bin/env bash
# agent-platform 安装脚本（主机 + systemd 部署，无容器）
set -euo pipefail

ENV="${1:?用法: install.sh <prod|test|dev>}"
PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# 1. 低权限用户
id agent-svc &>/dev/null || useradd -r -s /usr/sbin/nologin agent-svc

# 2. 代码包与运行目录
mkdir -p /opt/agent-platform
cp -r "$PKG_DIR"/src "$PKG_DIR"/conf "$PKG_DIR"/pyproject.toml /opt/agent-platform/
# 控制台 SPA：优先用随包构建产物 web/dist；没有则本机有 node 时现场构建
mkdir -p /opt/agent-platform/web
if [ -d "$PKG_DIR/web/dist" ]; then
    cp -r "$PKG_DIR/web/dist" /opt/agent-platform/web/
elif command -v npm >/dev/null && [ -f "$PKG_DIR/web/package.json" ]; then
    cp -r "$PKG_DIR"/web /opt/agent-platform/web-src-tmp
    (cd /opt/agent-platform/web-src-tmp && npm ci && npm run build)
    cp -r /opt/agent-platform/web-src-tmp/dist /opt/agent-platform/web/dist
    rm -rf /opt/agent-platform/web-src-tmp
else
    echo "!! web/dist 缺失且本机无 npm：控制台不可用（API 不受影响）。"
    echo "   在有 node 的机器上执行 cd web && npm ci && npm run build 后重跑本脚本。"
fi
mkdir -p /var/lib/agent-platform/scratch /var/log/agent-platform /etc/agent-platform
mkdir -p /var/lib/temporal                       # temporal-server.service 的 SQLite 目录
chown -R agent-svc:agent-svc /var/lib/agent-platform /var/log/agent-platform /var/lib/temporal
chown -R root:root /opt/agent-platform          # 代码包 root 所有，agent-svc 只读

# 3. 依赖
python3 -m venv /opt/agent-platform/venv
/opt/agent-platform/venv/bin/pip install /opt/agent-platform

# 4. 环境配置（secrets.env 需提前手工放置，权限 640 root:agent-svc）
[ -f /etc/agent-platform/secrets.env ] || {
    echo "!! 请先创建 /etc/agent-platform/secrets.env（MODEL_TOKEN_A/AGENT_DB_PASSWORD/DINGTALK_ACCESS_TOKEN/AGENT_BEARER_TOKEN）"
}

# 5. systemd（temporal-server 仅需在 temporal 未独立部署的主机上启用）
cp "$PKG_DIR/deploy/agent-platform.service" "$PKG_DIR/deploy/temporal-server.service" \
   /etc/systemd/system/
sed -i "s/AGENT_ENV=prod/AGENT_ENV=${ENV}/" /etc/systemd/system/agent-platform.service
systemctl daemon-reload
systemctl enable --now temporal-server
systemctl enable --now agent-platform
systemctl status agent-platform --no-pager
