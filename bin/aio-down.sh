#!/usr/bin/env bash
# RustDesk Console — All-in-One 一键停止
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(cd "$SCRIPT_DIR/.." && pwd)"
exec docker compose -f docker-compose.all-in-one.yml down "$@"
