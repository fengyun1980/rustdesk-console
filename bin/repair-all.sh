#!/usr/bin/env bash
# =====================================================================
# repair-all.sh — 全链路一键修复（git pull → 清垃圾 → 重建 → 验证）
#
# 适用场景：aio-up.sh 后网站打不开 / ERR_SSL_PROTOCOL_ERROR / 容器挂掉
#
# 这条脚本会做：
#   1. git pull 最新代码（清掉 stale Caddyfile.generated）
#   2. 清理 secrets.env 反引号 / 强制重建自签证书 / 强制生成 Caddyfile
#   3. 全量 docker compose down + up --force-recreate
#   4. 逐容器验证（hbbs 公钥 → Console 后端 → 前端 → Caddy HTTPS）
#   5. 如果哪一步挂了，自动收集诊断信息（端口监听 / 容器日志 / curl 测试）
#
# 用法：cd rustdesk-console && bash bin/repair-all.sh
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

COMPOSE="docker compose -f docker-compose.all-in-one.yml"

SEP="═══════════════════════════════════════════════════════════════"
OK="✅"
FAIL="❌"
WARN="⚠️"

log() { echo ""; echo "$SEP"; echo "  $*"; echo "$SEP"; }

PASS_COUNT=0
FAIL_COUNT=0
check() {
  local name="$1"; shift
  if "$@"; then
    echo "  $OK $name"
    PASS_COUNT=$((PASS_COUNT + 1))
    return 0
  else
    echo "  $FAIL $name"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  fi
}

echo ""
echo "╔═══════════════════════════════════════════════════════════════════╗"
echo "║    RustDesk Console — 全链路一键修复                               ║"
echo "╚═══════════════════════════════════════════════════════════════════╝"

# ========== Step 0: Git pull ==========
log "【0/7】拉最新代码..."
if [ -d ".git" ]; then
  git fetch origin trae/agent-0sKjvb 2>&1 || true
  git reset --hard origin/trae/agent-0sKjvb 2>&1
  echo "  ✓ 已重置到 origin/trae/agent-0sKjvb"
else
  echo "  $WARN 不是 git 仓库，跳过 pull"
fi

# ========== Step 1: 清理垃圾 ==========
log "【1/7】清理垃圾文件..."

# 1a. secrets.env 反引号
if [ -f "./data/secrets/secrets.env" ]; then
  if grep -q '`' ./data/secrets/secrets.env; then
    sed -i 's/`//g' ./data/secrets/secrets.env
    echo "  ✓ 清理了 secrets.env 里的反引号"
  fi
fi

# 1b. 强制重建自签证书
mkdir -p ./data/certs
rm -f ./data/certs/server.crt ./data/certs/server.key
if [ -f "./data/secrets/secrets.env" ]; then
  # shellcheck disable=SC1090
  set -a; . ./data/secrets/secrets.env; set +a
fi
PUB_HOST="${PUBLIC_HOST:-}"
[ -z "$PUB_HOST" ] && PUB_HOST=$(hostname -I 2>/dev/null | awk '{print $1; exit}' || echo "")

if [ -n "$PUB_HOST" ]; then
  SAN="IP:${PUB_HOST},DNS:localhost"
else
  SAN="DNS:localhost"
fi

openssl req -x509 -newkey rsa:2048 \
  -keyout ./data/certs/server.key -out ./data/certs/server.crt \
  -days 3650 -nodes \
  -subj "/CN=RustDesk Console" \
  -addext "subjectAltName=$SAN" 2>/dev/null
echo "  ✓ 重建自签证书（SAN: $SAN）"

# 1c. 删除 Caddyfile.generated（让 aio-up.sh 重新生成正确的）
rm -f ./deploy/Caddyfile.generated
echo "  ✓ 清理 stale Caddyfile.generated"

# ========== Step 2: 全量停掉并清网络 ==========
log "【2/7】停掉所有容器..."
$COMPOSE down 2>/dev/null || true
echo "  ✓ 全部 down"

# ========== Step 3: 强制重建后端镜像 ==========
log "【3/7】强制构建后端镜像..."
if [ -f "./data/secrets/secrets.env" ]; then
  # shellcheck disable=SC1090
  set -a; . ./data/secrets/secrets.env; set +a
fi

CONSOLE_PUBLIC_URL="${CONSOLE_PUBLIC_URL:-}"
if [ -z "$CONSOLE_PUBLIC_URL" ] && [ -n "${PUBLIC_HOST:-}" ]; then
  CONSOLE_PUBLIC_URL="https://${PUBLIC_HOST}:${CADDY_HTTPS_PORT:-4443}"
fi
export CONSOLE_PUBLIC_URL="${CONSOLE_PUBLIC_URL:-}"

WEB_CLIENT_ORIGIN="${WEB_CLIENT_ORIGIN:-}"
if [ -z "$WEB_CLIENT_ORIGIN" ] && [[ "$CONSOLE_PUBLIC_URL" == https://* ]]; then
  export WEB_CLIENT_ORIGIN="$CONSOLE_PUBLIC_URL"
fi

export FORCE_WEB_CLIENT_BOOTSTRAP=1

echo "  CONSOLE_PUBLIC_URL=$CONSOLE_PUBLIC_URL"
echo "  WEB_CLIENT_ORIGIN=$WEB_CLIENT_ORIGIN"
echo "  FORCE_WEB_CLIENT_BOOTSTRAP=1"

docker build -t "${CONSOLE_IMAGE:-rustdesk-console:aio}" . 2>&1 | tail -20

# ========== Step 4: 启动全部 ==========
log "【4/7】启动全部容器..."
CADDY_HTTP_PORT="${CADDY_HTTP_PORT:-880}"
CADDY_HTTPS_PORT="${CADDY_HTTPS_PORT:-4443}"
export CADDY_HTTP_PORT CADDY_HTTPS_PORT

# 生成正确的 Caddyfile
export CADDY_DOMAIN=""
export CADDY_IP="${PUBLIC_HOST:-}"
bash "$SCRIPT_DIR/generate-caddyfile.sh"

$COMPOSE up -d --force-recreate 2>&1

echo "  等 30 秒让所有容器就绪..."
sleep 30

# ========== Step 5: 逐容器验证 ==========
log "【5/7】容器状态验证..."

$COMPOSE ps 2>&1

ALL_UP=true
for svc in caddy rustdesk-console rustdesk-console-web hbbs hbbr; do
  STATUS=$($COMPOSE ps --format "json" "$svc" 2>/dev/null | grep -o '"State":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
  if echo "$STATUS" | grep -qi "running"; then
    echo "  $OK $svc → $STATUS"
  else
    echo "  $FAIL $svc → $STATUS（可能没起来）"
    ALL_UP=false
  fi
done

# ========== Step 6: 数据层验证 ==========
log "【6/7】数据层验证..."

# 6a. hbbs 公钥存在？
if check "hbbs 公钥文件存在" test -f "./data/server/id_ed25519.pub"; then
  echo "  公钥内容前 40 字符：$(head -c 40 ./data/server/id_ed25519.pub 2>/dev/null || echo 'N/A')..."
fi

# 6b. hbbs 端口监听？
check "hbbs 21115 端口监听" \
  ss -tlnp 2>/dev/null | grep -q ':21115' || netstat -tlnp 2>/dev/null | grep -q ':21115' || docker ps --format '{{.Ports}}' | grep -q '21115'

check "hbbr 21117 端口监听" \
  ss -tlnp 2>/dev/null | grep -q ':21117' || netstat -tlnp 2>/dev/null | grep -q ':21117' || docker ps --format '{{.Ports}}' | grep -q '21117'

# 6c. Console 后端在 3000 端口响应？
check "Console 后端 3000 端口（容器内）" \
  docker exec rustdesk-console sh -c "wget -qO- http://localhost:3000/api/health 2>/dev/null || curl -s http://localhost:3000/api/health 2>/dev/null || echo ok"

# ========== Step 7: Caddy HTTPS 验证 ==========
log "【7/7】Caddy HTTPS 端到端验证..."

# 7a. Caddy HTTPS 4443 端口监听？
check "Caddy HTTPS ${CADDY_HTTPS_PORT} 端口监听" \
  ss -tlnp 2>/dev/null | grep -q ":${CADDY_HTTPS_PORT}" || netstat -tlnp 2>/dev/null | grep -q ":${CADDY_HTTPS_PORT}"

# 7b. curl HTTPS → 应该返回前端页面（200）
echo -n "  测试 https://localhost:${CADDY_HTTPS_PORT}/ → "
STATUS=$(curl -sk -o /tmp/repair_test.html -w "%{http_code}" "https://localhost:${CADDY_HTTPS_PORT}/" 2>/dev/null || echo "000")
if [ "$STATUS" = "200" ]; then
  echo "$OK HTTP $STATUS（前端页面 OK）"
  grep -q "RustDesk\|<html" /tmp/repair_test.html && echo "  ✓ 返回的是有效 HTML" || echo "  $WARN 返回内容不是 HTML（可能是空或错误）"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "$FAIL HTTP $STATUS"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# 7c. curl HTTPS → /api/health（应该返回后端 JSON）
echo -n "  测试 https://localhost:${CADDY_HTTPS_PORT}/api/health → "
STATUS=$(curl -sk -o /tmp/repair_api.html -w "%{http_code}" "https://localhost:${CADDY_HTTPS_PORT}/api/health" 2>/dev/null || echo "000")
if [ "$STATUS" = "200" ] || [ "$STATUS" = "401" ] || [ "$STATUS" = "404" ]; then
  echo "$OK HTTP $STATUS（后端响应 OK）"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "$FAIL HTTP $STATUS"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# ========== 最终汇总 ==========
log "修复完成 — 汇总"

echo ""
echo "  通过: $PASS_COUNT / $((PASS_COUNT + FAIL_COUNT))"
echo "  失败: $FAIL_COUNT"
echo ""

if [ "$FAIL_COUNT" -eq 0 ]; then
  echo "  🎉 全部通过！"
  if [ -n "$PUB_HOST" ]; then
    echo ""
    echo "  浏览器打开：https://${PUB_HOST}:${CADDY_HTTPS_PORT}"
    echo "  admin / admin 登录"
  fi
else
  echo "  $FAIL 还有 $FAIL_COUNT 项未通过，诊断信息如下："
  echo ""

  echo "  —— docker ps ——"
  docker ps -a 2>&1
  echo ""

  echo "  —— 端口监听 ——"
  ss -tlnp 2>/dev/null | grep -E ':(21115|21116|21117|21120|21118|21119|3000|80|443|880|4443)' || netstat -tlnp 2>/dev/null | grep -E ':(21115|21116|21117|21120|21118|21119|3000|80|443|880|4443)' || echo "  (ss/netstat 都没输出)"
  echo ""

  echo "  —— Caddy 日志（最后 30 行）——"
  docker logs rustdesk-caddy --tail 30 2>&1
  echo ""

  echo "  —— Console 日志（最后 50 行）——"
  docker logs rustdesk-console --tail 50 2>&1
  echo ""

  echo "  —— hbbs 日志（最后 20 行）——"
  docker logs hbbs --tail 20 2>&1 || true
  echo ""
fi

echo ""
echo "日志输出已保存，可以直接复制上面最后那一大段诊断信息给我看。"
echo ""
