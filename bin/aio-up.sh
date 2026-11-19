#!/usr/bin/env bash
# =====================================================================
# RustDesk Console — All-in-One 一键启动（零配置全自动）
#
# 用法 — 永远只有一条命令：
#   bash bin/aio-up.sh                              # 裸 IP + 自签 HTTPS + 网页远控全自动
#   bash bin/aio-up.sh -d rustdesk.example.com      # 带域名 → 自动 Let's Encrypt 证书
#   bash bin/aio-up.sh -d rustdesk.example.com --build
#   bash bin/aio-up.sh -d rustdesk.example.com --force-recreate
#
# 启动后浏览器打开：
#   无域名：  https://<服务器IP>:4443             （自签证书，点「继续访问」）
#   有域名：  https://rustdesk.example.com        （自动 LE 证书，绿色锁）
#   admin / admin 登录
#
# 自动完成的事（客户什么都不用干）：
#   ✓ 生成 JWT_SECRET + SERVER_MANAGEMENT_TOKEN + admin/admin
#   ✓ 探测 PUBLIC_HOST（hostname -I 取第一个 IPv4）
#   ✓ 生成 Caddyfile + openssl 自签证书（裸 IP 场景）
#   ✓ Caddy 起在 880/4443，分路径反代（/api/*→后端，其他→前端）
#   ✓ Console bootstrap 自动等 hbbs 起来 → 读公钥 → 配置 Web Client
#   ✓ 自动启用网页远控（有域名→wss；无域名→ws，按场景降级）
#   ✓ Server Management 自动对接 hbbs/hbbr（同 compose 网络）
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

SECRETS_DIR="./data/secrets"
SECRETS_FILE="$SECRETS_DIR/secrets.env"
mkdir -p "$SECRETS_DIR"

# ------------- 0. 解析 --domain / -d 参数 -------------
CLI_DOMAIN=""
COMPOSE_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -d|--domain)
      CLI_DOMAIN="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
    *)
      COMPOSE_ARGS+=("$1"); shift ;;
  esac
done

# ------------- 1. 探测 PUBLIC_HOST -------------
detect_public_host() {
  if [ -n "${PUBLIC_HOST:-}" ]; then echo "$PUBLIC_HOST"; return; fi
  if command -v hostname >/dev/null 2>&1; then
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1; exit}')
    if [ -n "$ip" ] && [ "$ip" != "127.0.0.1" ]; then echo "$ip"; return; fi
  fi
  echo ""
}

# ------------- 2. 首次启动：生成密钥 -------------
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
    echo "# 不要手动编辑此文件 — 删除后重新 aio-up.sh 会重新生成全部密钥"
    echo "# ====================================================================="
    echo ""
    echo "JWT_SECRET=$(rand48)"
    echo ""
    echo "# Console ↔ RustDesk Server 管理 API 共享 token"
    echo "SERVER_MANAGEMENT_TOKEN=$(rand32hex)"
    echo "SERVER_MANAGEMENT_URL=http://hbbs:21120"
    echo "SERVER_MANAGEMENT_NODE_ID=rustdesk"
    echo "SERVER_MANAGEMENT_NODE_NAME=RustDesk"
    echo ""
    if [ -n "$PUB_HOST" ]; then
      echo "# 自动探测到的服务器 IP"
      echo "PUBLIC_HOST=$PUB_HOST"
      echo ""
    fi
    echo "# 管理员账户"
    echo "ADMIN_USERNAME=admin"
    echo "ADMIN_PASSWORD=admin"
  } > "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"

  echo "✓ 首次启动 → 自动生成密钥到 $SECRETS_FILE"
  if [ -n "$PUB_HOST" ]; then
    echo "  探测到主机 IP: $PUB_HOST"
  fi
else
  echo "• 复用已有密钥 $SECRETS_FILE"
fi

# ------------- 3. --domain 写入 secrets.env -------------
if [ -n "$CLI_DOMAIN" ]; then
  CLEAN_DOMAIN="${CLI_DOMAIN#https://}"
  CLEAN_DOMAIN="${CLEAN_DOMAIN#http://}"
  CLEAN_DOMAIN="${CLEAN_DOMAIN%%/*}"

  tmp=$(mktemp)
  grep -v '^CONSOLE_PUBLIC_URL=' "$SECRETS_FILE" | grep -v '^WEB_CLIENT_ORIGIN=' > "$tmp" || true
  {
    echo ""
    echo "# — 反代域名（aio-up.sh -d $CLEAN_DOMAIN 自动写入）—"
    echo "CONSOLE_PUBLIC_URL=https://$CLEAN_DOMAIN"
    echo "WEB_CLIENT_ORIGIN=https://$CLEAN_DOMAIN"
  } >> "$tmp"
  mv "$tmp" "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
  echo "✓ 反代域名: CONSOLE_PUBLIC_URL=https://$CLEAN_DOMAIN"
fi

# ------------- 4. 把 secrets 导入当前 shell 环境 -------------
set -a
# shellcheck disable=SC1090
. "$SECRETS_FILE"
set +a

# ------------- 5. 生成 Caddyfile（调用独立脚本）-------------
CADDY_DOMAIN="${CLI_DOMAIN:-}"
# 如果没传 -d 但 secrets.env 里已经有 CONSOLE_PUBLIC_URL 了，也拿出来用
if [ -z "$CADDY_DOMAIN" ] && [ -n "${CONSOLE_PUBLIC_URL:-}" ]; then
  CADDY_DOMAIN="${CONSOLE_PUBLIC_URL#https://}"
  CADDY_DOMAIN="${CADDY_DOMAIN#http://}"
  CADDY_DOMAIN="${CADDY_DOMAIN%%/*}"
  CADDY_DOMAIN="${CADDY_DOMAIN%%:*}"
fi
CADDY_IP="${PUBLIC_HOST:-}"

export CADDY_DOMAIN CADDY_IP CADDY_HTTP_PORT CADDY_HTTPS_PORT
bash "$SCRIPT_DIR/generate-caddyfile.sh"

# ------------- 6. 计算 CONSOLE_PUBLIC_URL（决定 Console bootstrap 用什么协议）-------------
# 这个值决定了 Console 后端生成什么地址给前端用
if [ -z "${CONSOLE_PUBLIC_URL:-}" ]; then
  if [ -n "$CLI_DOMAIN" ]; then
    CLEAN="${CLI_DOMAIN#https://}"; CLEAN="${CLEAN#http://}"; CLEAN="${CLEAN%%/*}"; CLEAN="${CLEAN%%:*}"
    CONSOLE_PUBLIC_URL="https://$CLEAN"
  elif [ -n "${PUBLIC_HOST:-}" ]; then
    # 裸 IP + Caddy 自签 HTTPS（443）
    CONSOLE_PUBLIC_URL="https://${PUBLIC_HOST}:${CADDY_HTTPS_PORT:-4443}"
  else
    CONSOLE_PUBLIC_URL="http://console.local:${CADDY_HTTP_PORT:-880}"
  fi
  export CONSOLE_PUBLIC_URL
  echo "✓ CONSOLE_PUBLIC_URL=$CONSOLE_PUBLIC_URL"
fi

# ------------- 7. 启动 Compose -------------
echo ""
echo "🚀 启动 All-in-One..."
exec docker compose -f docker-compose.all-in-one.yml up -d "${COMPOSE_ARGS[@]}"
