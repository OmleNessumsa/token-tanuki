#!/bin/bash
# Install the Blofin paper-trader launchd jobs.
#   - com.cryptotrader.scan-blofin   → every 30 min, fires LONG+SHORT signals
#   - com.cryptotrader.paper-blofin  → every 5 min, ticks open paper positions
#
# Both jobs run with CRYPTOTRADER_STATE_DIR=~/.cryptotrader-elmo-blofin so they
# operate on a tenant book separate from the Coinbase elmo tenant. Logs land
# in ~/Library/Logs/cryptotrader-elmo-blofin/.
#
# Default starting paper cash is $1000. Override with
# `CRYPTOTRADER_INITIAL_CASH=500 bash install-blofin.sh`.
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$DIR/../.." && pwd )"
TARGET="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/cryptotrader-elmo-blofin"
STATE_DIR="$HOME/.cryptotrader-elmo-blofin"

mkdir -p "$TARGET" "$LOG_DIR" "$STATE_DIR"

# Initialize the tenant book if missing.
INITIAL_CASH="${CRYPTOTRADER_INITIAL_CASH:-1000}"
if [ ! -f "$STATE_DIR/paper-portfolio.json" ]; then
  cat > "$STATE_DIR/paper-portfolio.json" <<JSON
{
  "startedAt": $(($(date +%s) * 1000)),
  "initialCash": $INITIAL_CASH,
  "cash": $INITIAL_CASH,
  "openPositions": [],
  "closedTrades": [],
  "alreadyTradedSignalIds": [],
  "lastDailySummary": null
}
JSON
  echo "  ✓ initialized Blofin paper portfolio at \$$INITIAL_CASH USDT"
fi

JOBS=("com.cryptotrader.scan-blofin" "com.cryptotrader.paper-blofin")

for JOB in "${JOBS[@]}"; do
  TPL="$DIR/${JOB}.plist"
  DST="$TARGET/${JOB}.plist"
  if [ ! -f "$TPL" ]; then
    echo "  skip: $TPL not found"
    continue
  fi
  sed -e "s|__HOME__|$HOME|g" -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" "$TPL" > "$DST"
  echo "  wrote: $DST"
  if launchctl list | grep -q "$JOB"; then
    echo "    reloading $JOB..."
    launchctl bootout "gui/$(id -u)/$JOB" 2>/dev/null || true
  fi
  launchctl bootstrap "gui/$(id -u)" "$DST" && echo "  ✓ loaded $JOB"
done

echo ""
echo "Status:"
launchctl list | grep cryptotrader || echo "  (no jobs running yet — give launchd a few seconds)"

echo ""
echo "Logs:"
echo "  $LOG_DIR/scan.{out,err}.log"
echo "  $LOG_DIR/paper.{out,err}.log"
echo ""
echo "Tail live:"
echo "  tail -f $LOG_DIR/{scan,paper}.{out,err}.log"
