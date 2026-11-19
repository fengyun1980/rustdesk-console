#!/usr/bin/env bash
# =====================================================================
# RustDesk Console — All-in-One 一键启动
#
# 自动完成：
#   1. 生成随机 JWT_SECRET + SERVER_MANAGEMENT_TOKEN
#   2. 探测主机 PUBLIC_HOST（hostname -I 取第一个 IPv4）
#   3. 可选：--domain 一键配置 HTTPS 反代域名 → 自动启用网页远控
#   4. 启动后 Console 会自动等 hbbs 起来读公钥、配置 Web Client
#
# 使用：
#   bash bin/aio-up.sh                        # 后台启动（纯内网 HTTP，自动启用网页远控）
#   bash bin/aio-up.sh -d rustdesk.example.com # 带 HTTPS 域名，自动启用 WSS 网页远控
#   bash bin/aio-up.sh --http                 # 强制 HTTP（虽然默认就是 HTTP，显式写更清楚）
#   bash bin/aio-up.sh --build                # 重建 backend 镜像
#   bash bin/aio-up.sh -d rustdesk.example.com --force-recreate
#
# 首次启动后：浏览器访问 http://<IP>:21114，admin / admin 登录
# 配好 Lucky 反代 + TLS 后：浏览器访问 https://<域名>，网页远控自动启用 WSS
# 没配反代也没关系：直接裸 IP 访问 HTTP，网页远控用 ws:// 明文（内网安全）
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
      if [ -z "${2:-}" ]; then
        echo "✗ --domain / -d 需要一个域名参数" >&2
        exit 1
      fi
      CLI_DOMAIN="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      COMPOSE_ARGS+=("$1")
      shift
      ;;
  esac
done

# ------------- 1. 探测 PUBLIC_HOST -------------
detect_public_host() {
  if [ -n "${PUBLIC_HOST:-}" ]; then
    echo "$PUBLIC_HOST"
    return
  fi
  if command -v hostname >/dev/null 2>&1; then
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1; exit}')
    if [ -n "$ip" ] && [ "$ip" != "127.0.0.1" ]; then
      echo "$ip"
      return
    fi
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
    if [ -n "$PUB_HOST" ]; then
      echo "# 公网主机（或公网 IP）—— 用于构造 WSS / allowedOrigin"
      echo "PUBLIC_HOST=$PUB_HOST"
      echo ""
    fi
    echo "# 反代 HTTPS 域名（Lucky / Caddy / Nginx 都可以）："
    echo "#   bash bin/aio-up.sh -d rustdesk.example.com"
    echo "#   bash bin/aio-up.sh --domain rustdesk.example.com"
    echo "# 自动设置以下两行，启用网页远控："
    echo "# CONSOLE_PUBLIC_URL=https://rustdesk.example.com"
    echo "# WEB_CLIENT_ORIGIN=https://rustdesk.example.com"
    echo ""
    echo "# 管理员账户（Console 首次启动时创建）"
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

# ------------- 3. --domain 写入 secrets.env（追加或覆盖已有值）-------------
if [ -n "$CLI_DOMAIN" ]; then
  # 规范化：用户可能传 https://xxx 或 xxx
  CLEAN_DOMAIN="${CLI_DOMAIN#https://}"
  CLEAN_DOMAIN="${CLEAN_DOMAIN#http://}"
  CLEAN_DOMAIN="${CLEAN_DOMAIN%%/*}"

  # 删掉旧的两行（如果有），再在末尾追加 —— 首次和非首次启动都能用
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
  echo "✓ 反代域名已写入: CONSOLE_PUBLIC_URL=https://$CLEAN_DOMAIN"
  echo "                    WEB_CLIENT_ORIGIN=https://$CLEAN_DOMAIN"
fi

# ------------- 4. 把 secrets 导入当前 shell 环境 -------------
# compose 的 `${VAR:-}` 优先读当前 shell 环境变量 ——
# 这样 hbbs/hbbr 的 RD_MANAGEMENT_TOKEN / 域名 / 反代配置都能拿到真实值。
set -a
# shellcheck disable=SC1090
. "$SECRETS_FILE"
set +a

# ------------- 5. 启动 Compose（透传剩余参数）-------------
exec docker compose -f docker-compose.all-in-one.yml up -d "${COMPOSE_ARGS[@]}"
