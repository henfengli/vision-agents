#!/usr/bin/env bash
# agent-platform 安装（同机部署）：装在线上项目所在的主机上，用部署项目的那个用户（平台和项目是同一个用户），
# 跑在该用户的 systemd --user 里，不需要 root。每台主机装一次，经 ssh 登录该用户后在仓库根目录执行
# （sudo -u / su 拿不到该用户的 systemd 会话）：
#   bash deploy/install-user.sh
# 平台自己的 Python 要 ≥ 3.11：自动找 python3.13/3.12/3.11、~/miniforge3 ~/miniconda3 ~/anaconda3 的 python3；
# 也可以 PYTHON=/path/to/python3 指定。部署配置用 conf/env/prod.yaml（AGENT_ENV=prod）+ 本机的
# ~/.config/agent-platform/local.yaml（这台负责哪个环境等），说明见 docs/部署指南.md。
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
  for c in python3.13 python3.12 python3.11 "$HOME/miniforge3/bin/python3" "$HOME/miniconda3/bin/python3" \
           "$HOME/anaconda3/bin/python3" python3; do
    if command -v "$c" >/dev/null && ok_python "$(command -v "$c")"; then PY="$(command -v "$c")"; break; fi
  done
fi
[ -n "$PY" ] && ok_python "$PY" || {
  echo "找不到 Python ≥ 3.11。用已有的 conda 建一个（conda create -n agent-platform python=3.12），"
  echo "或装 Miniforge 到 ~/miniforge3（不需要 root），然后 PYTHON=/path/to/python3 重跑"; exit 1; }

# 1. 代码与数据目录
mkdir -p "$APP" "$DATA"/{scratch,assets,agent-conf} "$SECRETS_DIR" "$UNITS" "$HOME/.local/bin"
chmod 700 "$SECRETS_DIR" "$DATA/agent-conf"
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
  echo "!! 缺少 bubblewrap（bwrap）：没有它平台不执行模型写的代码（require_sandbox）。"
  echo "   请管理员装（RHEL / Rocky：dnf install -y bubblewrap），或自己从系统包里取出 bwrap 放进 ~/.local/bin（部署指南 §3.0）"
elif ! bwrap --ro-bind / / --unshare-pid --as-pid-1 --unshare-net true 2>/dev/null; then
  echo "!! bwrap 不能以普通用户建命名空间："
  echo "   RHEL / Rocky：/proc/sys/user/max_user_namespaces 是 $(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo ?)，为 0 时请管理员调大（写进 /etc/sysctl.d/）"
  echo "   Ubuntu 24.04+：请管理员设 kernel.apparmor_restrict_unprivileged_userns=0，或给 bwrap 配 AppArmor profile"
fi
command -v git >/dev/null || echo "!! 缺少 git：看不到代码目录的提交、记忆的代码引用没法核对新鲜度"
CG="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers"
if [ -r "$CG" ] && ! grep -qw memory "$CG"; then
  echo "!! systemd 没有把 memory 控制器委派给用户：内核与 bash 的内存上限不生效。"
  echo "   请管理员加 /etc/systemd/system/user@.service.d/delegate.conf：[Service] Delegate=memory pids cpu，然后 systemctl daemon-reload"
fi
command -v systemd-run >/dev/null || echo "!! 没有 systemd-run：资源上限（limits）用不了，在 local.yaml 里设 limits.enabled: false"
if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q '=yes'; then
  loginctl enable-linger "$USER" 2>/dev/null && echo "已开启 linger（退出登录后服务照常运行）" || \
    echo "!! 开不了 linger（本机策略不允许自己开）：退出登录后 systemd --user 会停。请管理员执行一次：loginctl enable-linger $USER"
fi
[ -f "$SECRETS_DIR/secrets.env" ] || \
  echo "!! 请创建 $SECRETS_DIR/secrets.env（chmod 600）：AGENT_ROOT_TOKEN、AGENT_DB_HOST、AGENT_DB_PASSWORD、MODEL_TOKEN_A …"
grep -qs '^env:' "$SECRETS_DIR/local.yaml" || \
  echo "!! 请在 $SECRETS_DIR/local.yaml 写这台负责的环境（env: prod 或 env: test；测试机再写 services: [本机部署的服务]）"
command -v docker >/dev/null && ! docker ps >/dev/null 2>&1 && \
  echo "!! 本用户用不了 docker：服务定义里 docker:<容器> 的日志读不到"

# 5. systemd 用户单元（AGENT_ENV=prod）
cp "$REPO/deploy/user/agent-platform.service" "$REPO/deploy/user/agent.slice" "$UNITS"/
rm -f "$UNITS/agent-svc@.service"            # 旧版的业务进程模板单元（同机部署不再起业务进程）
systemctl --user daemon-reload
systemctl --user enable agent-platform
systemctl --user restart agent-platform          # 首次即启动；重装时让新代码生效
systemctl --user --no-pager status agent-platform || true
