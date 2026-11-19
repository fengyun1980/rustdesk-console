#!/usr/bin/env bash
# =====================================================================
# generate-caddyfile.sh — 根据部署场景自动生成 Caddyfile
#
# 输入（全部通过环境变量，可选）：
#   CADDY_DOMAIN       反代域名（如 rustdesk.example.com）→ 自动 Let's Encrypt
#                      注意：空字符串 / 包含 "example.com" / "localhost" 等
#                      占位符会被视为"无域名"场景，走 tls internal 自签
#   CADDY_IP           服务器公网 IP（无域名时用）→ 自签 HTTPS
#   CADDY_HTTP_PORT    HTTP 监听端口（默认 880）
#   CADDY_HTTPS_PORT   HTTPS 监听端口（默认 4443）
#   CONSOLE_WEB        前端容器（默认 rustdesk-console-web:80）
#   CONSOLE_API        后端容器（默认 rustdesk-console:3000）
#   CADDY_OUT          输出文件路径（默认 ./deploy/Caddyfile.generated）
#
# Caddy 特性：
#   · 有域名且 DNS 已指向服务器 → 自动申请 Let's Encrypt，HTTP 自动跳 HTTPS
#   · 无域名 / 只有 IP          → tls internal 自签，浏览器首次访问点「继续访问」
#   · /api/* /ws/* 单独反代到后端  → 后端处理 API + WebSocket Gateway
#   · 其他所有请求反代到前端       → 前端处理静态文件 + SPA fallback
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
mkdir -p "$(dirname "$CADDY_OUT")"

# —— CADDY_DOMAIN 设成占位符的话视为没域名 ——
# （aio-up.sh 可能会把 secrets.env 里的旧值带进来，这里兜底）
if [ -n "$CADDY_DOMAIN" ]; then
  case "$CADDY_DOMAIN" in
    *.example.com|example.com|localhost|127.0.0.1|\
      *placeholder*|*example*|*未设置*|*undefined*)
      echo "⚠ CADDY_DOMAIN='$CADDY_DOMAIN' 被识别为占位符，忽略，改用自签证书"
      CADDY_DOMAIN=""
      ;;
  esac
fi

# —— 统一写一个站点块：不管域名还是裸 IP ——
#  路径优先级：/api/*  → /ws/*  → 其他（前端）
if [ -n "$CADDY_DOMAIN" ]; then
  echo "✓ 有域名场景：$CADDY_DOMAIN → Let's Encrypt"
  SITE_BLOCK="$CADDY_DOMAIN"
else
  if [ -z "$CADDY_IP" ]; then
    # 没传 IP 的话，让 Caddy 监听所有 IP:端口
    SITE_BLOCK=":$CADDY_HTTPS_PORT"
    echo "✓ 无域名场景 → 自签 HTTPS :$CADDY_HTTPS_PORT"
  else
    SITE_BLOCK="$CADDY_IP:$CADDY_HTTPS_PORT"
    echo "✓ 无域名场景 → 自签 HTTPS $CADDY_IP:$CADDY_HTTPS_PORT"
  fi
fi

cat > "$CADDY_OUT" <<EOF
# =====================================================================
# Caddyfile — RustDesk Console All-in-One
# 自动生成于 $(date -u +%Y-%m-%dT%H:%M:%SZ)
# 场景：$( [ -n "$CADDY_DOMAIN" ] && echo "有域名 $CADDY_DOMAIN → Let's Encrypt" || echo "无域名 / 裸 IP → tls internal 自签" )
# =====================================================================

$SITE_BLOCK {
$( [ -z "$CADDY_DOMAIN" ] && echo "    tls internal" || true )

    # —— 后端 API（NestJS）——
    /api/* {
        reverse_proxy $CONSOLE_API
    }

    # —— WebSocket Gateway（网页远控 / 中继 / ID）——
    /ws/* {
        reverse_proxy $CONSOLE_API
    }

    # —— 前端静态文件 + SPA（所有其他路径）——
    # 前端会处理 404 fallback 到 index.html
    reverse_proxy $CONSOLE_WEB
}

$( [ -n "$CADDY_DOMAIN" ] && cat <<EOF2
# 有域名场景下 HTTP 端口（CADDY_HTTP_PORT）自动跳 HTTPS
http:// :$CADDY_HTTP_PORT {
    redir https://$CADDY_DOMAIN:{uri} 301
}
EOF2
EOF
)

echo "✓ Caddyfile 已生成：$CADDY_OUT"
if [ -n "$CADDY_DOMAIN" ]; then
  echo "  访问：https://$CADDY_DOMAIN  （Let's Encrypt，需 DNS 已解析）"
else
  echo "  访问：https://<服务器IP>:$CADDY_HTTPS_PORT  （自签证书，浏览器点「继续访问」）"
fi
echo ""
