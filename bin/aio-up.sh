#!/usr/bin/env bash
# =====================================================================
# RustDesk Console — All-in-One 一键启动
#
# 自动完成：
#   1. 生成随机 JWT_SECRET（如果 secrets.env 不存在）
#   2. 生成随机 SERVER_MANAGEMENT_TOKEN（Console + hbbs + hbbr 共用）
#   3. 启动后端 + 前端 + hbbs + hbbr 四服务
#
# 使用：
#   bash bin/aio-up.sh             # 后台启动
#   bash bin/aio-up.sh --build     # 重建 backend 镜像
#   bash bin/aio-up.sh -d --force-recreate
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

SECRETS_DIR="./data/secrets"
SECRETS_FILE="$SECRETS_DIR/secrets.env"
mkdir -p "$SECRETS_DIR"

# ------------- 1. 生成 secrets（只做一次，后续重启复用）-------------
if [ ! -s "$SECRETS_FILE" ]; then
  if command -v openssl >/dev/null 2>&1; then
    rand48() { openssl rand -base64 48 | tr -d '\n'; }
    rand32hex() { openssl rand -hex 32; }
  else
    rand48() { head -c 48 /dev/urandom | base64 -w0 2>/dev/null || head -c 48 /dev/urandom | base64 | tr -d '\n'; }
    rand32hex() { head -c 32 /dev/urandom | od -A n -t x1 | tr -d ' \n'; }
  fi

  {
    echo "# ====================================================================="
    echo "# Auto-generated secrets for RustDesk Console All-in-One"
    echo "# 不要手动编辑这个文件，除非你知道自己在做什么。"
    echo "# 删除此文件后重新执行 aio-up.sh 会生成全新的密钥 —— 旧 JWT 会全部失效！"
    echo "# ====================================================================="
    echo ""
    echo "# JWT 签发密钥 — Console 所有登录 token 的根"
    echo "JWT_SECRET=$(rand48)"
    echo ""
    echo "# Console ↔ RustDesk Server 管理 API 的共享 token"
    echo "# hbbs/hbbr 和 Console 后端同时读取这个值"
    echo "SERVER_MANAGEMENT_TOKEN=$(rand32hex)"
    echo ""
    echo "# Console 对接 hbbs 的管理 API 地址（Compose 内部 DNS）"
    echo "SERVER_MANAGEMENT_URL=http://hbbs:21120"
    echo "SERVER_MANAGEMENT_NODE_ID=rustdesk"
    echo "SERVER_MANAGEMENT_NODE_NAME=RustDesk"
    echo ""
    echo "# 管理员账户（Console 首次启动时创建）"
    echo "ADMIN_USERNAME=admin"
    echo "ADMIN_PASSWORD=admin"
  } > "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
  echo "✓ 首次启动 → 自动生成密钥到 $SECRETS_FILE"
else
  echo "• 复用已有密钥 $SECRETS_FILE"
fi

# ------------- 2. 把 secrets 导入当前 shell 环境 -------------
# compose 的 `${VAR:-}` 会优先读当前 shell 的环境变量；
# 这样 hbbs/hbbr 的 RD_MANAGEMENT_TOKEN 就能拿到 SERVER_MANAGEMENT_TOKEN 真实值。
set -a
# shellcheck disable=SC1090
. "$SECRETS_FILE"
set +a

# ------------- 3. 启动 Compose（透传所有参数）-------------
exec docker compose -f docker-compose.all-in-one.yml up -d "$@"
