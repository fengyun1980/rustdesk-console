#!/usr/bin/env bash
# =====================================================================
# fix-caddy.sh — 一键修复 Caddy HTTPS 问题（ERR_SSL_PROTOCOL_ERROR 等）
#
# 场景：aio-up.sh 后 Caddy 在 4443 端口没正确提供 HTTPS
# 原因可能是：证书丢失 / Caddyfile 错误 / 容器没正确挂载
#
# 用法：
#   cd rustdesk-console && bash bin/fix-caddy.sh
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

COMPOSE="docker compose -f docker-compose.all-in-one.yml"

echo "═══════════════════════════════════════════════"
echo " RustDesk Console — Caddy HTTPS 诊断 + 修复"
echo "═══════════════════════════════════════════════"

# ------------ Step 1: 停掉 Caddy + 清理旧证书 ------------
echo ""
echo "【1/6】停 Caddy 容器..."
$COMPOSE stop caddy 2>/dev/null || true

# ------------ Step 2: 强制重新生成 openssl 自签证书 ------------
echo ""
echo "【2/6】检查/重建自签证书..."
CERTS_DIR="./data/certs"
CERT="$CERTS_DIR/server.crt"
KEY="$CERTS_DIR/server.key"
mkdir -p "$CERTS_DIR"

# 不管有没有，都强制重新生成（避免旧证书过期/损坏）
rm -f "$CERT" "$KEY"

PUB_HOST=$(hostname -I 2>/dev/null | awk '{print $1; exit}' || echo "")
if [ -z "$PUB_HOST" ]; then
  # 从 secrets.env 里读
  if [ -f "./data/secrets/secrets.env" ]; then
    # shellcheck disable=SC1090
    set -a; . ./data/secrets/secrets.env; set +a
    PUB_HOST="${PUBLIC_HOST:-}"
  fi
fi

SAN="DNS:localhost"
if [ -n "$PUB_HOST" ]; then
  SAN="IP:${PUB_HOST},DNS:localhost"
fi

openssl req -x509 -newkey rsa:2048 \
  -keyout "$KEY" -out "$CERT" \
  -days 3650 -nodes \
  -subj "/CN=RustDesk Console" \
  -addext "subjectAltName=$SAN" 2>/dev/null

echo "  ✓ 证书：$CERT"
openssl x509 -in "$CERT" -noout -subject -dates -ext subjectAltName 2>/dev/null || true

# ------------ Step 3: 生成正确的 Caddyfile ------------
echo ""
echo "【3/6】生成 Caddyfile..."
export CADDY_DOMAIN=""
export CADDY_IP="${PUB_HOST:-}"
export CADDY_HTTP_PORT="${CADDY_HTTP_PORT:-880}"
export CADDY_HTTPS_PORT="${CADDY_HTTPS_PORT:-4443}"

# 清理 Caddyfile.generated 旧文件
rm -f ./deploy/Caddyfile.generated

bash "$SCRIPT_DIR/generate-caddyfile.sh"

echo ""
echo "  —— Caddyfile 内容预览 ——"
cat ./deploy/Caddyfile.generated
echo "  ————————————————————"

# ------------ Step 4: 验证 Caddyfile 语法 ------------
echo ""
echo "【4/6】验证 Caddyfile 语法..."
docker run --rm \
  -v "$PROJECT_DIR/deploy/Caddyfile.generated:/etc/caddy/Caddyfile:ro" \
  -v "$PROJECT_DIR/data/certs:/etc/certs:ro" \
  caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile 2>&1 || {
  echo "❌ Caddyfile 语法错误！上面是报错信息，请检查。"
  exit 1
}
echo "  ✓ Caddyfile 语法 OK"

# ------------ Step 5: 启动 Caddy（force-recreate 确保干净）------------
echo ""
echo "【5/6】启动 Caddy..."
$COMPOSE up -d --force-recreate caddy

echo "  等 Caddy 就绪..."
sleep 3

# ------------ Step 6: 验证 HTTPS 可访问 ------------
echo ""
echo "【6/6】验证 HTTPS..."
HTTPS_PORT="${CADDY_HTTPS_PORT:-4443}"

# 用 curl 跳过自签证书校验测试
if curl -sk -o /dev/null -w "%{http_code}" "https://localhost:${HTTPS_PORT}/" 2>/dev/null | grep -qE '^[0-9]'; then
  STATUS=$(curl -sk -o /dev/null -w "%{http_code}" "https://localhost:${HTTPS_PORT}/" 2>/dev/null)
  echo "  ✓ HTTPS 端口 ${HTTPS_PORT} 返回 HTTP ${STATUS}"
else
  echo "  ❌ HTTPS 端口 ${HTTPS_PORT} 不通！"
  echo ""
  echo "  Caddy 日志："
  $COMPOSE logs caddy --tail 30 2>&1
  echo ""
  echo "  端口监听："
  ss -tlnp | grep -E "${HTTPS_PORT}|${CADDY_HTTP_PORT:-880}" || netstat -tlnp 2>/dev/null | grep -E "${HTTPS_PORT}|${CADDY_HTTP_PORT:-880}" || true
  exit 1
fi

# 额外检查：Caddy 是否真的在用自签证书
echo ""
echo "  检查证书指纹："
openssl s_client -connect "localhost:${HTTPS_PORT}" -servername localhost </dev/null 2>/dev/null | \
  openssl x509 -noout -subject -issuer -dates 2>/dev/null || true

echo ""
echo "═══════════════════════════════════════════════"
echo " ✅ Caddy HTTPS 修复完成！"
if [ -n "$PUB_HOST" ]; then
  echo "  访问：https://${PUB_HOST}:${HTTPS_PORT}"
else
  echo "  访问：https://<服务器IP>:${HTTPS_PORT}"
fi
echo "  浏览器提示不安全是正常的（自签证书），点「高级」→「继续访问」即可"
echo "═══════════════════════════════════════════════"
