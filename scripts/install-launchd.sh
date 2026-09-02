#!/usr/bin/env bash
# Installs the reminder server as a launchd agent so it survives logout and restarts on crash.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# A launchd label can get wedged (bootstraps clean, exits 78 immediately, no output)
# while an identical plist under a new name runs fine. Bumping the suffix sidesteps it.
LABEL="com.tasknotif.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/dist/server/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ROOT/logs/server.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/server.err.log</string>
</dict>
</plist>
PLIST_EOF

echo "Building…"
(cd "$ROOT" && npm run build)

# Clear out any older label so two copies never race for the port.
for old in com.tasknotif.reminder; do
  launchctl bootout "gui/$UID/$old" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$old.plist"
done

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"

sleep 3
if launchctl list | grep -q "$LABEL"; then
  status=$(launchctl list | grep "$LABEL" | awk '{print $1}')
  if [ "$status" = "-" ]; then
    echo "WARNING: $LABEL registered but is not running. Check $ROOT/logs/server.err.log"
    exit 1
  fi
  echo "Loaded $LABEL (pid $status). Logs: $ROOT/logs/server.log"
else
  echo "ERROR: $LABEL did not register."
  exit 1
fi
echo "Stop with: launchctl bootout gui/$UID/$LABEL"
