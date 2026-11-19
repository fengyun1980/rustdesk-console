#!/usr/bin/env bash
# =====================================================================
# generate-caddyfile.sh — 根据部署场景自动生成 Caddyfile
#
# 输入（全部通过环境变量，可选）：
#   CADDY_DOMAIN       反代域名（如 rustdesk.example.com）→ 自动 Let's Encrypt
#                      空 / 占位符 → 裸 IP 场景，走 openssl 自签证书
#   CADDY_IP           服务器 IP（裸 IP 自签证书时用来写 SAN）
#   CADDY_HTTP_PORT    HTTP 端口（默认 880）
#   CADDY_HTTPS_PORT   HTTPS 端口（默认 4443）
#   CONSOLE_WEB        前端容器（默认 rustdesk-console-web:80）
#   CONSOLE_API        后端容器（默认 rustdesk-console:3000）
#   CADDY_OUT          Caddyfile 输出路径（默认 ./deploy/Caddyfile.generated）
#   CERTS_DIR          证书目录（默认 ./data/certs）
#
# Caddy 反代策略（路径优先级）：
#   1. /api/*  → 后端 NestJS（API）
#   2. /ws/*   → 后端 NestJS Gateway（WebSocket 网页远控）
#   3. 其他    → 前端静态文件（Vue SPA fallback）
# =====================================================================
set -euo pipefail

# —— 默认值 ——
CADDY_DOMAIN="${CADDY_DOMAIN:-}"
CADDY_IP="${CADDY_IP:-}"
CADDY_HTTP_PORT="${CADDY_HTTP_PORT:-880}"
CADDY_HTTPS_PORT="${CADDY_HTTPS_PORT:-4443}"
CONSOLE_WEB="${CONSOLE_WEB:-rustdesk-console-web:80}"
CONSOLE_API="${CONSOLE_API:-rustdesk-console:3000}"
CADDY_OUT="${CADDY_OUT:-deploy/Caddyfile.generated}"
CERTS_DIR="${CERTS_DIR:-./data/certs}"

mkdir -p "$(dirname "$CADDY_OUT")"

# —— CADDY_DOMAIN 占位符清洗 ——
if [ -n "$CADDY_DOMAIN" ]; then
  case "$CADDY_DOMAIN" in
    *.example.com|example.com|localhost|127.0.0.1|\
      *placeholder*|*example*|*未设置*|*undefined*|`*`)
      echo "⚠ CADDY_DOMAIN='$CADDY_DOMAIN' 被识别为占位符，忽略"
      CADDY_DOMAIN=""
      ;;
  esac
fi

# —— 裸 IP 场景：用 openssl 生成自签证书 ——
# （tls internal 在裸 IP + auto_https 下会报 TLS alert internal error 592）
if [ -z "$CADDY_DOMAIN" ]; then
  mkdir -p "$CERTS_DIR"
  CERT="$CERTS_DIR/server.crt"
  KEY="$CERTS_DIR/server.key"

  if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
    echo "✓ 生成 openssl 自签证书（裸 IP 场景）..."
    SAN="DNS:localhost"
    [ -n "$CADDY_IP" ] && SAN="IP:$CADDY_IP,DNS:localhost"
    openssl req -x509 -newkey rsa:2048 \
      -keyout "$KEY" -out "$CERT" \
      -days 3650 -nodes \
      -subj "/CN=RustDesk Console" \
      -addext "subjectAltName=$SAN" 2>/dev/null
    echo "  证书：$CERT"
  else
    echo "✓ 复用已有自签证书：$CERT"
  fi
fi

# —— 写 Caddyfile（关 auto_https，避免裸 IP 场景冲突）——
if [ -n "$CADDY_DOMAIN" ]; then
  echo "✓ 有域名场景：$CADDY_DOMAIN → Let's Encrypt"
  cat > "$CADDY_OUT" <<EOF
{
    admin off
}

$CADDY_DOMAIN {
    # Let's Encrypt 自动证书（有域名时 Caddy 默认行为）

    # —— 后端 API（NestJS）——
    @api path /api/*
    handle @api {
        reverse_proxy $CONSOLE_API
    }

    # —— WebSocket Gateway ——
    @ws path /ws/*
    handle @ws {
        reverse_proxy $CONSOLE_API
    }

    # —— 前端（所有其他路径）——
    reverse_proxy $CONSOLE_WEB
}

:$CADDY_HTTP_PORT {
    redir https://$CADDY_DOMAIN{uri} 301
}
EOF
else
  echo "✓ 无域名 / 裸 IP 场景 → openssl 自签 :$CADDY_HTTPS_PORT"
  cat > "$CADDY_OUT" <<EOF
{
    auto_https off
    admin off
}

:$CADDY_HTTPS_PORT {
    tls /etc/certs/server.crt /etc/certs/server.key

    # —— 后端 API（NestJS）——
    @api path /api/*
    handle @api {
        reverse_proxy $CONSOLE_API
    }

    # —— WebSocket Gateway ——
    @ws path /ws/*
    handle @ws {
        reverse_proxy $CONSOLE_API
    }

    # —— 前端（所有其他路径）——
    reverse_proxy $CONSOLE_WEB
}

:$CADDY_HTTP_PORT {
    redir https://{host}:$CADDY_HTTPS_PORT{uri} 301
}
EOF
fi

echo "✓ Caddyfile 已生成：$CADDY_OUT"
if [ -n "$CADDY_DOMAIN" ]; then
  echo "  访问：https://$CADDY_DOMAIN  （Let's Encrypt）"
else
  echo "  访问：https://<服务器IP>:$CADDY_HTTPS_PORT  （自签证书，点「继续访问」）"
fi
