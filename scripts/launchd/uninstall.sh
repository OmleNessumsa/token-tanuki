#!/bin/bash
# Uninstall the cryptotrader launchd jobs.
set -e
TARGET="$HOME/Library/LaunchAgents"
JOBS=("com.cryptotrader.bot" "com.cryptotrader.scanner")
for JOB in "${JOBS[@]}"; do
  if [ -f "$TARGET/${JOB}.plist" ]; then
    launchctl bootout "gui/$(id -u)/$JOB" 2>/dev/null || true
    rm -v "$TARGET/${JOB}.plist"
  fi
done
echo "✓ all cryptotrader jobs removed"
