#!/bin/sh
# A mounted volume arrives with the host's ownership, which overrides whatever the
# image chowned at build time. Start as root, fix the data directory, then drop
# privileges — so the app never runs as root but can still write its store.
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || \
    echo "[entrypoint] could not chown $DATA_DIR — continuing; the app will report if it cannot write"
  exec su-exec node "$@"
fi

# Already unprivileged (some platforms pin the uid); just run.
exec "$@"
