#!/usr/bin/env bash
# =====================================================================
# RustDesk Console — All-in-One 一键安装器（极简版）
#
# 用法（在主分支仓库根目录下）：
#   bash install-all-in-one.sh
#
# 做完：git fetch + checkout trae/agent 分支 → 直接运行
# 更简单的替代：
#   git clone -b trae/agent-0sKjvb https://github.com/fengyun1980/rustdesk-console.git
#   cd rustdesk-console && bash bin/aio-up.sh
# =====================================================================
set -euo pipefail
cd "$(pwd)"

echo "=== RustDesk Console All-in-One 安装器 ==="

if [ ! -f package.json ]; then
  echo "✗ 请在仓库根目录运行此脚本"
  exit 1
fi

if [ -f bin/aio-up.sh ] && [ -f docker-compose.all-in-one.yml ]; then
  echo "✓ 已是 All-in-One 版本 —— 直接运行：bash bin/aio-up.sh"
  exit 0
fi

echo "→ 切换到 trae/agent-0sKjvb 分支（预构建镜像）..."
if git fetch origin trae/agent-0sKjvb --depth=1 2>/dev/null && \
   git checkout trae/agent-0sKjvb 2>/dev/null; then
  echo "✓ 已切换到 trae/agent-0sKjvb 分支"
elif git checkout origin/trae/agent-0sKjvb 2>/dev/null; then
  echo "✓ 已 checkout 到 origin/trae/agent-0sKjvb"
else
  echo "✗ 无法切换分支 —— 请手动："
  echo "    git clone -b trae/agent-0sKjvb https://github.com/fengyun1980/rustdesk-console.git"
  exit 1
fi

echo ""
echo "══════════════════════════════════════════════════════"
echo "  切分支完成！"
echo ""
echo "  首次启动（自动生成密钥 + pull 预构建镜像 + 起容器）："
echo "    bash bin/aio-up.sh"
echo ""
echo "  带 HTTPS 域名："
echo "    bash bin/aio-up.sh -d rustdesk.example.com"
echo ""
echo "  启动后浏览器访问："
echo "    裸 IP:   https://<服务器IP>    admin / admin"
echo "    有域名:  https://rustdesk.example.com"
echo "══════════════════════════════════════════════════════"
