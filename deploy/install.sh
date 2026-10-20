#!/usr/bin/env bash
# agent-platform 安装（主机 + systemd，无容器）。在仓库根目录的 deploy/ 下执行：
#   sudo deploy/install.sh            # 生产主机（AGENT_ENV=prod）
#   sudo deploy/install.sh dev        # 开发机
set -euo pipefail

PROFILE="${1:-prod}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/agent-platform
DATA=/var/lib/agent-platform

# 1. 用户：平台自己（agent-svc）与它启动的业务进程（svc-runner）分开
id agent-svc &>/dev/null || useradd -r -s /usr/sbin/nologin agent-svc
id svc-runner &>/dev/null || useradd -r -s /usr/sbin/nologin svc-runner

# 2. 代码与数据目录（代码 root 所有、平台只读；数据目录平台可写）
mkdir -p "$APP" "$DATA"/{scratch,assets,instances} /etc/agent-platform /var/lib/temporal
cp -r "$REPO"/src "$REPO"/conf "$REPO"/mcp_servers "$REPO"/pyproject.toml "$APP"/
chown -R root:root "$APP"
chown -R agent-svc:agent-svc "$DATA" /var/lib/temporal
chmod 755 "$DATA" "$DATA/instances"          # svc-runner 要读启动规格

# 3. 控制台前端：仓库里有构建好的 dist 就直接用；没有且装了 node 就现场构建
if [ ! -f "$APP/src/agent_platform/webui/dist/index.html" ] && command -v npm >/dev/null; then
  (cd "$REPO/web" && npm ci && npm run build) && cp -r "$REPO/src/agent_platform/webui/dist" "$APP/src/agent_platform/webui/"
fi

# 4. Python 依赖
python3 -m venv "$APP/venv"
"$APP/venv/bin/pip" install -q "$APP"
command -v bwrap >/dev/null || echo "!! 缺少 bubblewrap（apt-get install -y bubblewrap）：沙箱与按环境起服务都依赖它"

# 5. 密钥（提前手工放置，640 root:agent-svc）
[ -f /etc/agent-platform/secrets.env ] || \
  echo "!! 请创建 /etc/agent-platform/secrets.env：AGENT_ROOT_TOKEN、AGENT_DB_PASSWORD、MODEL_TOKEN_A、DINGTALK_ACCESS_TOKEN …"

# 6. systemd 与 polkit
cp "$REPO"/deploy/agent-platform.service "$REPO"/deploy/agent-svc@.service "$REPO"/deploy/temporal-server.service \
   /etc/systemd/system/
sed -i "s/AGENT_ENV=prod/AGENT_ENV=${PROFILE}/" /etc/systemd/system/agent-platform.service
install -m 644 "$REPO"/deploy/50-agent-svc.rules /etc/polkit-1/rules.d/50-agent-svc.rules
systemctl daemon-reload
systemctl enable --now temporal-server
systemctl enable --now agent-platform
systemctl --no-pager status agent-platform
