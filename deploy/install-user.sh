#!/usr/bin/env bash
# agent-platform 安装：平台跑在当前用户的 systemd --user 里，不需要 root。用部署 agent 的那个用户，
# 经 ssh 或 machinectl shell 登录后在仓库根目录执行（sudo -u 拿不到该用户的 systemd 会话）：
#   bash deploy/install-user.sh
# 部署配置用 conf/env/prod.yaml（AGENT_ENV=prod），说明见 docs/部署指南.md。
set -euo pipefail

[ "$(id -u)" -ne 0 ] || { echo "请用普通用户执行（平台跑在该用户的 systemd --user 里）"; exit 1; }
[ -n "${XDG_RUNTIME_DIR:-}" ] || { echo "没有用户的 systemd 会话：请用 ssh 或 machinectl shell 登录该用户后再执行"; exit 1; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/agent-platform"
DATA="$HOME/.local/share/agent-platform"
SECRETS_DIR="$HOME/.config/agent-platform"
UNITS="$HOME/.config/systemd/user"

# 1. 代码与数据目录
mkdir -p "$APP" "$DATA"/{scratch,assets,instances} "$SECRETS_DIR" "$UNITS"
chmod 700 "$SECRETS_DIR"
cp -r "$REPO"/src "$REPO"/conf "$REPO"/mcp_servers "$REPO"/pyproject.toml "$APP"/

# 2. 控制台前端：仓库里有构建好的 dist 就直接用；没有且装了 node 就现场构建
if [ ! -f "$APP/src/agent_platform/webui/dist/index.html" ] && command -v npm >/dev/null; then
  (cd "$REPO/web" && npm ci && npm run build) && cp -r "$REPO/src/agent_platform/webui/dist" "$APP/src/agent_platform/webui/"
fi

# 3. Python 依赖
[ -x "$APP/venv/bin/python" ] || python3 -m venv "$APP/venv"
"$APP/venv/bin/pip" install -q "$APP"

# 4. 前置检查（只提示，不中断）
if ! command -v bwrap >/dev/null; then
  echo "!! 缺少 bubblewrap：请管理员安装（apt-get install -y bubblewrap）。agent 沙箱与按环境起服务都依赖它"
elif ! bwrap --ro-bind / / --unshare-pid --as-pid-1 --unshare-net true 2>/dev/null; then
  echo "!! bwrap 不能以普通用户建命名空间（Ubuntu 24.04+ 默认限制）。请管理员二选一："
  echo "   sysctl -w kernel.apparmor_restrict_unprivileged_userns=0（并写进 /etc/sysctl.d/），或给 /usr/bin/bwrap 配 AppArmor profile"
fi
loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q '=yes' || \
  echo "!! 未开启 linger：退出登录后 systemd --user 会停。请管理员执行一次：loginctl enable-linger $USER"
[ -f "$SECRETS_DIR/secrets.env" ] || \
  echo "!! 请创建 $SECRETS_DIR/secrets.env（chmod 600）：AGENT_ROOT_TOKEN、AGENT_DB_PASSWORD、MODEL_TOKEN_A、DINGTALK_ACCESS_TOKEN …"
{ [ -d /srv/svc ] && [ -w /srv/svc ]; } || \
  echo "!! 种子里的服务目录在 /srv/svc：请管理员执行一次 install -d -o $USER -m 750 /srv/svc，或在控制台把服务路径改到你可写的目录"

# 5. systemd 用户单元（AGENT_ENV=prod）
cp "$REPO/deploy/user/agent-platform.service" "$REPO/deploy/user/agent-svc@.service" "$UNITS"/
systemctl --user daemon-reload
systemctl --user enable --now agent-platform
systemctl --user --no-pager status agent-platform || true
