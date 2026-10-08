#!/usr/bin/env bash
# agent-platform 安装脚本（主机 + systemd 部署，与现有服务方式一致）
set -euo pipefail

ENV="${1:?用法: install.sh <prod|test|dev>}"
PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# 1. 低权限用户
id agent-svc &>/dev/null || useradd -r -s /usr/sbin/nologin agent-svc

# 2. 代码包与运行目录
mkdir -p /opt/agent-platform
cp -r "$PKG_DIR"/src "$PKG_DIR"/conf "$PKG_DIR"/pyproject.toml /opt/agent-platform/
mkdir -p /var/lib/agent-platform/scratch /var/log/agent-platform /etc/agent-platform
chown -R agent-svc:agent-svc /var/lib/agent-platform /var/log/agent-platform
chown -R root:root /opt/agent-platform          # 代码包 root 所有，agent-svc 只读

# 3. 依赖
python3 -m venv /opt/agent-platform/venv
/opt/agent-platform/venv/bin/pip install /opt/agent-platform

# 4. 环境配置（secrets.env 需提前手工放置，权限 640 root:agent-svc）
ln -sf "/opt/agent-platform/conf/env/${ENV}.yaml" /etc/agent-platform/env.yaml
[ -f /etc/agent-platform/secrets.env ] || {
    echo "!! 请先创建 /etc/agent-platform/secrets.env（MODEL_TOKEN_A/AGENT_DB_PASSWORD/DINGTALK_ACCESS_TOKEN/AGENT_BEARER_TOKEN）"
}

# 5. systemd
cp "$PKG_DIR/deploy/agent-platform.service" /etc/systemd/system/
sed -i "s/AGENT_ENV=prod/AGENT_ENV=${ENV}/" /etc/systemd/system/agent-platform.service
systemctl daemon-reload
systemctl enable --now agent-platform
systemctl status agent-platform --no-pager
