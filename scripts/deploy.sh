#!/usr/bin/env bash
# Ships the current working tree to an always-on host and restarts the container there.
#   ./scripts/deploy.sh user@host [remote-dir]
set -euo pipefail

TARGET="${1:-}"
REMOTE_DIR="${2:-/opt/task-notif}"

if [ -z "$TARGET" ]; then
  echo "usage: ./scripts/deploy.sh user@host [remote-dir]" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Preparing $TARGET:$REMOTE_DIR"
ssh "$TARGET" "mkdir -p '$REMOTE_DIR/data'"

echo "==> Syncing source (excluding secrets, build output and local state)"
rsync -az --delete \
  --exclude node_modules --exclude dashboard/node_modules \
  --exclude dist --exclude dashboard/dist \
  --exclude data --exclude logs --exclude .git --exclude .env \
  "$ROOT/" "$TARGET:$REMOTE_DIR/"

# .env is copied separately and never deleted by --delete, so a bad sync cannot
# wipe the credentials on the server.
echo "==> Syncing .env (0600)"
scp -q "$ROOT/.env" "$TARGET:$REMOTE_DIR/.env"
ssh "$TARGET" "chmod 600 '$REMOTE_DIR/.env'"

echo "==> Building and restarting"
ssh "$TARGET" "cd '$REMOTE_DIR' && docker compose up -d --build"

echo "==> Waiting for health"
ssh "$TARGET" "cd '$REMOTE_DIR' && for i in \$(seq 1 30); do
  status=\$(docker inspect --format '{{.State.Health.Status}}' task-notif 2>/dev/null || echo starting)
  [ \"\$status\" = healthy ] && echo '    healthy' && exit 0
  [ \"\$status\" = unhealthy ] && echo '    UNHEALTHY' && docker compose logs --tail 40 && exit 1
  sleep 3
done; echo '    timed out waiting for health'; docker compose logs --tail 40; exit 1"

echo "==> Scheduled runs"
ssh "$TARGET" "cd '$REMOTE_DIR' && docker compose logs --tail 20 | grep -E 'scheduler|slack-socket' || true"

cat <<TIP

Done. The dashboard is bound to loopback on the server, so reach it with:

    ssh -N -L 4310:127.0.0.1:4310 $TARGET

then open http://localhost:4310
TIP
