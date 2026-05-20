#!/bin/bash
# Stop and remove the Blofin paper-trader launchd jobs. Tenant state at
# ~/.cryptotrader-elmo-blofin/ is left in place — wipe it manually if a
# clean slate is desired.
set -e

TARGET="$HOME/Library/LaunchAgents"
JOBS=("com.cryptotrader.scan-blofin" "com.cryptotrader.paper-blofin")

for JOB in "${JOBS[@]}"; do
  if launchctl list | grep -q "$JOB"; then
    launchctl bootout "gui/$(id -u)/$JOB" 2>/dev/null || true
    echo "  ✓ stopped $JOB"
  fi
  rm -f "$TARGET/${JOB}.plist"
done

echo ""
echo "Blofin jobs uninstalled. Tenant state preserved at ~/.cryptotrader-elmo-blofin/."
