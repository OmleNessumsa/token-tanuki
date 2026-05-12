#!/bin/bash
# Install the Coinbase paper-trader launchd jobs.
#   - com.cryptotrader.scan-coinbase   → every 30 min, fires LONG signals to tenant log
#   - com.cryptotrader.paper-coinbase  → every 5 min, ticks open paper positions
#
# Both jobs run with CRYPTOTRADER_STATE_DIR=~/.cryptotrader-elmo so they
# operate on the elmo tenant book independently of any MEXC paper runs.
# Logs land in ~/Library/Logs/cryptotrader-elmo/.
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$DIR/../.." && pwd )"
TARGET="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/cryptotrader-elmo"
STATE_DIR="$HOME/.cryptotrader-elmo"

mkdir -p "$TARGET" "$LOG_DIR" "$STATE_DIR"

# Initialize the tenant book if missing. Default starting cash $1000 (matches
# src/paper-portfolio.ts createEmpty). Override with CRYPTOTRADER_INITIAL_CASH
# at install time, e.g. `CRYPTOTRADER_INITIAL_CASH=228 bash install-coinbase.sh`.
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
  echo "  ✓ initialized paper portfolio at \$$INITIAL_CASH USDC"
fi

JOBS=("com.cryptotrader.scan-coinbase" "com.cryptotrader.paper-coinbase")

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
