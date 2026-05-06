#!/bin/bash
# Install the cryptotrader launchd jobs into ~/Library/LaunchAgents/
# Usage: ./install.sh
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
TARGET="$HOME/Library/LaunchAgents"
mkdir -p "$TARGET"
mkdir -p "$HOME/Library/Logs/cryptotrader"

JOBS=("com.cryptotrader.bot" "com.cryptotrader.scanner")

for JOB in "${JOBS[@]}"; do
  TPL="$DIR/${JOB}.plist"
  DST="$TARGET/${JOB}.plist"
  if [ ! -f "$TPL" ]; then
    echo "skip: $TPL not found"
    continue
  fi
  # Substitute __HOME__ placeholder with actual $HOME
  sed "s|__HOME__|$HOME|g" "$TPL" > "$DST"
  echo "wrote: $DST"
  # Bootstrap the job
  if launchctl list | grep -q "$JOB"; then
    echo "  reloading $JOB..."
    launchctl bootout "gui/$(id -u)/$JOB" 2>/dev/null || true
  fi
  launchctl bootstrap "gui/$(id -u)" "$DST" && echo "  ✓ loaded $JOB"
done

echo ""
echo "Done. Status:"
launchctl list | grep cryptotrader || echo "(no jobs running yet — give it a few seconds)"
echo ""
echo "Logs:"
echo "  ~/Library/Logs/cryptotrader/bot.{out,err}.log"
echo "  ~/Library/Logs/cryptotrader/scanner.{out,err}.log"
