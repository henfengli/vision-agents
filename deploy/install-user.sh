#!/usr/bin/env bash
# agent-platform 安装：平台跑在当前用户的 systemd --user 里，不需要 root。用部署 agent 的那个用户，
# 经 ssh 登录后在仓库根目录执行（sudo -u / su 拿不到该用户的 systemd 会话）：
#   bash deploy/install-user.sh
# 平台自己的 Python 要 ≥ 3.11：自动找 python3.13/3.12/3.11、~/miniforge3/bin/python3；也可以 PYTHON=/path/to/python3 指定。
# 部署配置用 conf/env/prod.yaml（AGENT_ENV=prod），说明见 docs/部署指南.md。
set -euo pipefail

[ "$(id -u)" -ne 0 ] || { echo "请用普通用户执行（平台跑在该用户的 systemd --user 里）"; exit 1; }
[ -n "${XDG_RUNTIME_DIR:-}" ] || { echo "没有用户的 systemd 会话：请用 ssh 登录该用户后再执行"; exit 1; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/agent-platform"
DATA="$HOME/.local/share/agent-platform"
SECRETS_DIR="$HOME/.config/agent-platform"
UNITS="$HOME/.config/systemd/user"
export PATH="$HOME/.local/bin:$PATH"          # 和用户单元的 PATH 一致：自己放的 bwrap / git 在这里

ok_python() { "$1" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; }

# 0. 平台用的 Python（RHEL / Rocky 9 自带的 python3 是 3.9，不够）
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3.13 python3.12 python3.11 "$HOME/miniforge3/bin/python3" python3; do
    if command -v "$c" >/dev/null && ok_python "$(command -v "$c")"; then PY="$(command -v "$c")"; break; fi
  done
fi
[ -n "$PY" ] && ok_python "$PY" || {
  echo "找不到 Python ≥ 3.11。装 Miniforge 到 ~/miniforge3（不需要 root，见 docs/部署指南.md §3.0）后重跑，"
  echo "或用 PYTHON=/path/to/python3 指定"; exit 1; }

# 1. 代码与数据目录；业务项目的代码与配置放 ~/svc（种子里的路径）
mkdir -p "$APP" "$DATA"/{scratch,assets,instances} "$SECRETS_DIR" "$UNITS" "$HOME/svc" "$HOME/.local/bin"
chmod 700 "$SECRETS_DIR"
cp -r "$REPO"/src "$REPO"/conf "$REPO"/mcp_servers "$REPO"/pyproject.toml "$APP"/

# 2. 控制台前端：仓库里有构建好的 dist 就直接用；没有且装了 node 就现场构建
if [ ! -f "$APP/src/agent_platform/webui/dist/index.html" ] && command -v npm >/dev/null; then
  (cd "$REPO/web" && npm ci && npm run build) && cp -r "$REPO/src/agent_platform/webui/dist" "$APP/src/agent_platform/webui/"
fi

# 3. Python 依赖（之前用旧 Python 建过的 venv 重建）
if [ -x "$APP/venv/bin/python" ] && ! ok_python "$APP/venv/bin/python"; then rm -rf "$APP/venv"; fi
[ -x "$APP/venv/bin/python" ] || "$PY" -m venv "$APP/venv"
"$APP/venv/bin/pip" install -q "$APP"

# 4. 前置检查（只提示，不中断）
if ! command -v bwrap >/dev/null; then
  echo "!! 缺少 bubblewrap（bwrap）：agent 沙箱、项目内核、同步步骤、按环境起服务都依赖它。"
  echo "   请管理员装（RHEL / Rocky：dnf install -y bubblewrap），或自己从系统包里取出 bwrap 放进 ~/.local/bin（部署指南 §3.0）"
elif ! bwrap --ro-bind / / --unshare-pid --as-pid-1 --unshare-net true 2>/dev/null; then
  echo "!! bwrap 不能以普通用户建命名空间："
  echo "   RHEL / Rocky：/proc/sys/user/max_user_namespaces 是 $(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo ?)，为 0 时请管理员调大（写进 /etc/sysctl.d/）"
  echo "   Ubuntu 24.04+：请管理员设 kernel.apparmor_restrict_unprivileged_userns=0，或给 bwrap 配 AppArmor profile"
fi
command -v git >/dev/null || \
  echo "!! 缺少 git：请管理员 dnf install -y git，或 ~/miniforge3/bin/conda install -y git 后 ln -s ~/miniforge3/bin/git ~/.local/bin/git"
if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q '=yes'; then
  loginctl enable-linger "$USER" 2>/dev/null && echo "已开启 linger（退出登录后服务照常运行）" || \
    echo "!! 开不了 linger（本机策略不允许自己开）：退出登录后 systemd --user 会停。请管理员执行一次：loginctl enable-linger $USER"
fi
[ -f "$SECRETS_DIR/secrets.env" ] || \
  echo "!! 请创建 $SECRETS_DIR/secrets.env（chmod 600）：AGENT_ROOT_TOKEN、AGENT_DB_PASSWORD、MODEL_TOKEN_A、DINGTALK_ACCESS_TOKEN …"
for p in vision-board vision-web vision-dagster; do
  [ -x "$HOME/miniforge3/envs/$p/bin/python" ] || \
    echo "!! 没有 conda 环境 ~/miniforge3/envs/$p（种子里的解释器）：建好它，或在控制台把服务的 python 改到实际位置"
done

# 5. systemd 用户单元（AGENT_ENV=prod）
cp "$REPO/deploy/user/agent-platform.service" "$REPO/deploy/user/agent-svc@.service" "$UNITS"/
systemctl --user daemon-reload
systemctl --user enable agent-platform
systemctl --user restart agent-platform          # 首次即启动；重装时让新代码生效
systemctl --user --no-pager status agent-platform || true
