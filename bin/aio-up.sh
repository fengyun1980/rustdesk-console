#!/usr/bin/env bash
# =====================================================================
# RustDesk Console — All-in-One 一键启动
#
# 自动完成：
#   1. 生成随机 JWT_SECRET + SERVER_MANAGEMENT_TOKEN
#   2. 探测主机 PUBLIC_HOST（hostname -I 取第一个 IPv4）
#   3. 启动后 Console 会自动等 hbbs 起来读公钥、配置 Web Client
#
# 使用：
#   bash bin/aio-up.sh             # 后台启动
#   bash bin/aio-up.sh --build     # 重建 backend 镜像
#   bash bin/aio-up.sh -d --force-recreate
#
# 首次启动后：浏览器访问 http://<IP>:21114，admin / admin 登录
#
# 可选环境变量（覆盖自动探测）：
#   PUBLIC_HOST=your.domain.com           公网 IP 或域名（自动探测失败时用）
#   WEB_CLIENT_ORIGIN=https://your.domain.com  提供 HTTPS origin 会自动启用网页远控
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

SECRETS_DIR="./data/secrets"
SECRETS_FILE="$SECRETS_DIR/secrets.env"
mkdir -p "$SECRETS_DIR"

# ------------- 0. 探测 PUBLIC_HOST（如未显式提供）-------------
detect_public_host() {
  # 1) 优先读用户已设置的环境变量 / secrets.env
  if [ -n "${PUBLIC_HOST:-}" ]; then
    echo "$PUBLIC_HOST"
    return
  fi
  # 2) hostname -I 取第一个 IPv4（最常见的单网卡场景）
  if command -v hostname >/dev/null 2>&1; then
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1; exit}')
    if [ -n "$ip" ] && [ "$ip" != "127.0.0.1" ]; then
      echo "$ip"
      return
    fi
  fi
  # 3) 没探测到 — 留空，后续 bootstrapWebClientFromEnv 会用 relay 地址兜底
  echo ""
}

if [ ! -s "$SECRETS_FILE" ]; then
  if command -v openssl >/dev/null 2>&1; then
    rand48() { openssl rand -base64 48 | tr -d '\n'; }
    rand32hex() { openssl rand -hex 32; }
  else
    rand48() { head -c 48 /dev/urandom | base64 -w0 2>/dev/null || head -c 48 /dev/urandom | base64 | tr -d '\n'; }
    rand32hex() { head -c 32 /dev/urandom | od -A n -t x1 | tr -d ' \n'; }
  fi

  PUB_HOST=$(detect_public_host)

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
    echo "# 公网主机（或公网 IP）—— 用于构造 WSS / allowedOrigin"
    if [ -n "$PUB_HOST" ]; then
      echo "PUBLIC_HOST=$PUB_HOST"
      echo "# RUSTDESK_RELAY_ADDRESS=$PUB_HOST:21117"
    fi
    echo "# 如果要启用网页远控，提供 HTTPS 域名："
    echo "# WEB_CLIENT_ORIGIN=https://your.domain.com"
    echo ""
    echo "# 管理员账户（Console 首次启动时创建）"
    echo "ADMIN_USERNAME=admin"
    echo "ADMIN_PASSWORD=admin"
  } > "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"

  echo "✓ 首次启动 → 自动生成密钥到 $SECRETS_FILE"
  if [ -n "$PUB_HOST" ]; then
    echo "  探测到主机 IP: $PUB_HOST"
  else
    echo "  未自动探测到 PUBLIC_HOST — 如需网页远控请手动设置"
  fi
else
  echo "• 复用已有密钥 $SECRETS_FILE"
fi

# ------------- 把 secrets 导入当前 shell 环境 -------------
# compose 的 `${VAR:-}` 优先读当前 shell 环境变量 ——
# 这样 hbbs/hbbr 的 RD_MANAGEMENT_TOKEN 和 PUBLIC_HOST 都能拿到真实值。
set -a
# shellcheck disable=SC1090
. "$SECRETS_FILE"
set +a

# ------------- 启动 Compose（透传所有参数）-------------
exec docker compose -f docker-compose.all-in-one.yml up -d "$@"
