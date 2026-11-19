#!/bin/sh
set -eu

case "${1:-}" in
  --system-update-mode=*) set -- node /app/dist/main.js "$@" ;;
esac
if [ "${SYSTEM_UPDATE_ROLE:-}" = updater ]; then
  umask 077
  state=$(dirname -- "$SYSTEM_UPDATE_INSTALLATION")
  ipc=$(dirname -- "$SYSTEM_UPDATE_SOCKET")
  maintenance=$(dirname -- "$SYSTEM_UPDATE_MAINTENANCE_FILE")
  mkdir -p "$state" "$ipc" "$maintenance"
  chmod 700 "$state"
  chown "0:${SYSTEM_UPDATE_SOCKET_GID:-1000}" "$ipc"
  chmod 750 "$ipc"
  chmod 755 "$maintenance"
  exec "$@"
fi
case " $* " in
  *" --system-update-mode=updater "*|*" --system-update-mode=worker "*|*" --system-update-mode=recover "*)
    umask 077
    # Workers inherit only verified mount paths from their installation record.
    exec "$@"
    ;;
esac

# ---------- AIO 自生成（仅 Console 后端正常启动路径）----------
# 如果 aio-up.sh 预先生成了 secrets.env，当前 shell 里会有 JWT_SECRET / SERVER_MANAGEMENT_TOKEN。
# 如果用户直接 `docker compose up -d` 绕过了 aio-up.sh，secrets.env 里可能也有值。
# 两种情况都不走这个自生成块；只有两个值都空时才自动生成，写入 secrets.env，
# 让"零配置启容器"也能正常起 Console。hbbs/hbbr 侧仍建议用 aio-up.sh 预生成。
if [ -z "${JWT_SECRET:-}" ] || [ -z "${SERVER_MANAGEMENT_TOKEN:-}" ]; then
  SECRETS_DIR="${DATA_DIR:-/data}/secrets"
  SECRETS_FILE="$SECRETS_DIR/secrets.env"
  mkdir -p "$SECRETS_DIR"

  # 读已有 secrets.env（如果有），避免重复覆盖
  if [ -s "$SECRETS_FILE" ]; then
    # shellcheck disable=SC1090
    . "$SECRETS_FILE"
  fi

  # 自动生成 JWT_SECRET
  if [ -z "${JWT_SECRET:-}" ]; then
    JWT_SECRET=$(cat /dev/urandom | head -c 48 | base64 -w0 2>/dev/null || cat /dev/urandom | head -c 48 | base64)
    {
      echo "# Auto-generated JWT secret"
      echo "JWT_SECRET=$JWT_SECRET"
    } >> "$SECRETS_FILE"
    echo "[aio] 自动生成 JWT_SECRET" >&2
  fi

  # 自动生成 SERVER_MANAGEMENT_TOKEN
  if [ -z "${SERVER_MANAGEMENT_TOKEN:-}" ]; then
    SERVER_MANAGEMENT_TOKEN=$(cat /dev/urandom | head -c 32 | od -A n -t x1 | tr -d ' \n')
    {
      echo "# Auto-generated Console ↔ RustDesk Server token"
      echo "SERVER_MANAGEMENT_TOKEN=$SERVER_MANAGEMENT_TOKEN"
      echo "SERVER_MANAGEMENT_URL=${SERVER_MANAGEMENT_URL:-http://hbbs:21120}"
      echo "SERVER_MANAGEMENT_NODE_ID=${SERVER_MANAGEMENT_NODE_ID:-rustdesk}"
      echo "SERVER_MANAGEMENT_NODE_NAME=${SERVER_MANAGEMENT_NODE_NAME:-RustDesk}"
    } >> "$SECRETS_FILE"
    echo "[aio] 自动生成 SERVER_MANAGEMENT_TOKEN" >&2
    echo "[aio] 提示：直接跑 compose up 时 hbbs/hbbr 拿不到这个 token，" >&2
    echo "[aio]       建议用 'bash bin/aio-up.sh' 预生成后再启动。" >&2
  fi

  export JWT_SECRET
  [ -n "${SERVER_MANAGEMENT_TOKEN:-}" ] && export SERVER_MANAGEMENT_TOKEN
  chmod 600 "$SECRETS_FILE"
fi
# -------------------------------------------------------------

if [ "$(id -u)" = 0 ]; then
  mkdir -p "${DATA_DIR:-/data}"
  find "${DATA_DIR:-/data}" -xdev \( \! -user 1000 -o \! -group 1000 \) \
    -exec chown -h 1000:1000 {} +
  runtime_gid=1000
  if [ "${SERVER_MANAGEMENT_LOCAL:-0}" = 1 ]; then
    socket=${DOCKER_SOCKET:-/var/run/docker.sock}
    if [ ! -S "$socket" ]; then
      echo "Local server management requires a mounted Docker socket" >&2
      exit 1
    fi
    # su-exec clears supplementary groups; retain only the explicitly mounted socket group.
    runtime_gid=$(stat -c '%g' "$socket")
  fi
  exec su-exec "1000:$runtime_gid" "$@"
fi
exec "$@"
