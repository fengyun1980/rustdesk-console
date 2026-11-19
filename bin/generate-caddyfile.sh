#!/usr/bin/env bash
# =====================================================================
# generate-caddyfile.sh — 根据部署场景自动生成 Caddyfile
#
# 输入（全部通过环境变量，可选）：
#   CADDY_DOMAIN       反代域名（如 rustdesk.example.com）→ 自动 Let's Encrypt
#   CADDY_IP           服务器公网 IP（无域名时用）→ 自签 HTTPS
#   CADDY_HTTP_PORT    HTTP 监听端口（默认 80）
#   CADDY_HTTPS_PORT   HTTPS 监听端口（默认 443）
#   CONSOLE_INTERNAL   Console 后端内部地址（默认 console:21114）
#   CADDY_OUT          输出文件路径（默认 ./deploy/Caddyfile.generated）
#
# Caddy 特性：
#   · 有域名且 DNS 已指向服务器 → 自动申请 Let's Encrypt，HTTP 自动跳 HTTPS
#   · 无域名 / 只有 IP          → tls internal 自签，浏览器首次访问点「继续访问」
#   · WebSocket 自动支持         → 不需要任何额外 proxy_set_header
# =====================================================================
set -euo pipefail

CADDY_DOMAIN="${CADDY_DOMAIN:-}"
CADDY_IP="${CADDY_IP:-}"
CADDY_HTTP_PORT="${CADDY_HTTP_PORT:-80}"
CADDY_HTTPS_PORT="${CADDY_HTTPS_PORT:-443}"
CONSOLE_INTERNAL="${CONSOLE_INTERNAL:-console:21114}"
CADDY_OUT="${CADDY_OUT:-deploy/Caddyfile.generated}"
mkdir -p "$(dirname "$CADDY_OUT")"

# ---------------- 场景 A：有域名 → 自动 Let's Encrypt ----------------
if [ -n "$CADDY_DOMAIN" ]; then
  cat > "$CADDY_OUT" <<EOF
# =====================================================================
# Caddyfile — RustDesk Console All-in-One
# 自动生成于 $(date -u +%Y-%m-%dT%H:%M:%SZ)
# 有域名场景：Caddy 自动申请 Let's Encrypt，HTTP 自动跳 HTTPS
# =====================================================================

$CADDY_DOMAIN {
    # 反代到 Console 后端（NestJS 提供前端静态文件 + API + WebSocket Gateway）
    reverse_proxy $CONSOLE_INTERNAL
    # Caddy 自动处理：
    #   · HTTP → HTTPS 重定向
    #   · WebSocket upgrade（/ws/id, /ws/relay 等所有 /ws/* 路径）
    #   · 请求头 X-Forwarded-For / X-Forwarded-Proto 透传
    #   · 静态文件缓存
}
EOF
  echo "✓ Caddyfile 已生成：有域名 $CADDY_DOMAIN → 自动 Let's Encrypt"
  echo "  访问：https://$CADDY_DOMAIN"

# ---------------- 场景 B：无域名 / 裸 IP → 自签 HTTPS ----------------
else
  # 没域名就不可能自动 LE，用自签 internal CA 证书
  # Caddy 会把 IP 地址放进证书的 SAN，浏览器报"不安全"但功能正常
  # （内网 / 自部署场景完全可以接受；有域名的路径在场景 A）
  cat > "$CADDY_OUT" <<EOF
# =====================================================================
# Caddyfile — RustDesk Console All-in-One
# 自动生成于 $(date -u +%Y-%m-%dT%H:%M:%SZ)
# 无域名 / 裸 IP 场景：tls internal 自签证书
# 浏览器首次访问时点「继续访问」即可（证书里已包含 IP SAN）
# =====================================================================

https:// :$CADDY_HTTPS_PORT {
    tls internal
    reverse_proxy $CONSOLE_INTERNAL
}

http:// :$CADDY_HTTP_PORT {
    redir https://{host}:$CADDY_HTTPS_PORT{uri} 301
}
EOF
  if [ -n "$CADDY_IP" ]; then
    echo "✓ Caddyfile 已生成：裸 IP $CADDY_IP:$CADDY_HTTPS_PORT → 自签 HTTPS"
    echo "  访问：https://$CADDY_IP:$CADDY_HTTPS_PORT  （浏览器点「继续访问」）"
  else
    echo "✓ Caddyfile 已生成：自签 HTTPS :$CADDY_HTTPS_PORT"
    echo "  访问：https://<你的服务器IP>:$CADDY_HTTPS_PORT  （浏览器点「继续访问」）"
  fi
fi
echo "  输出文件：$CADDY_OUT"
