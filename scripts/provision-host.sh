#!/usr/bin/env bash
# Prepares a fresh Ubuntu host (Oracle Cloud Always Free, EC2, a VPS — anything)
# so ./scripts/deploy.sh can run against it.
#
#   ./scripts/provision-host.sh ubuntu@<public-ip>
#
# Installs Docker Engine + the compose plugin from Docker's own apt repo, puts the
# login user in the docker group, and verifies the daemon answers. Safe to re-run.
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "usage: ./scripts/provision-host.sh user@host" >&2
  exit 1
fi

echo "==> Checking SSH reaches $TARGET"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" 'echo "    connected: $(uname -srm)"'

echo "==> Installing Docker (idempotent)"
ssh "$TARGET" 'bash -se' <<'REMOTE'
set -euo pipefail

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "    already installed: $(docker --version)"
else
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -qq
  # rsync is what deploy.sh ships the source with, and Oracle's Ubuntu images do not
  # always include it.
  sudo apt-get install -y -qq ca-certificates curl gnupg rsync

  sudo install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.asc ]; then
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
  fi

  # dpkg --print-architecture keeps this correct on arm64 (Oracle's Ampere A1 shape)
  # as well as amd64, rather than hardcoding one.
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

command -v rsync >/dev/null 2>&1 || sudo apt-get install -y -qq rsync

sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

# The image build runs tsc and vite. Oracle's smallest free shapes ship with no swap,
# and an OOM there kills the build with an unhelpful "Killed" — 2G costs nothing on
# a boot volume that is 47G free.
if ! sudo swapon --show | grep -q .; then
  echo "    no swap found — adding 2G at /swapfile"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap -q /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
REMOTE

echo "==> Verifying docker runs without sudo"
# The group change only applies to new logins, so this is a fresh connection on purpose.
ssh "$TARGET" 'docker run --rm hello-world >/dev/null 2>&1 && echo "    docker ok (no sudo needed)"' || {
  echo "    docker needs a new login to pick up the group — reconnecting once more"
  ssh -O exit "$TARGET" 2>/dev/null || true
  ssh "$TARGET" 'docker run --rm hello-world >/dev/null && echo "    docker ok"'
}

cat <<TIP

Host is ready. Next:

    ./scripts/deploy.sh $TARGET
TIP
