#!/bin/bash
# Remove the Coinbase paper-trader launchd jobs.
# Does NOT delete the tenant state dir or logs — those persist until you rm them.
set -e

TARGET="$HOME/Library/LaunchAgents"
JOBS=("com.cryptotrader.scan-coinbase" "com.cryptotrader.paper-coinbase")

for JOB in "${JOBS[@]}"; do
  launchctl bootout "gui/$(id -u)/$JOB" 2>/dev/null && echo "  ✓ unloaded $JOB" || echo "  not loaded: $JOB"
  if [ -f "$TARGET/${JOB}.plist" ]; then
    rm "$TARGET/${JOB}.plist"
    echo "  ✓ removed plist: $TARGET/${JOB}.plist"
  fi
done

echo ""
echo "Tenant state preserved at ~/.cryptotrader-elmo/"
echo "Logs preserved at ~/Library/Logs/cryptotrader-elmo/"
echo "Remove manually if no longer needed."
