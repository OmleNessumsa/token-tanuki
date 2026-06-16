#!/bin/bash
#
# Daily paper-trading run for the BTC-only allocator (CB-026).
# Idempotent: the runner rebalances at most once per closed UTC day, so extra
# fires (RunAtLoad, post-sleep catch-up) just mark NAV without re-trading.
# State lives in the default ~/.cryptotrader/paper-allocator-state.json
# (distinct from the harvester's harvester-paper.json — no collision).
#
# Loaded via ~/Library/LaunchAgents/com.cryptotrader.allocator-paper.plist
# (copied from the .plist.template — Elmo loads it manually; see template).

set -euo pipefail

cd /Users/elmo.asmussen/Projects/TokenTanuki

LOGDIR="$HOME/Library/Logs/cryptotrader-allocator"
mkdir -p "$LOGDIR"

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) allocator paper run ===" >> "$LOGDIR/run.log"
/opt/homebrew/bin/npx tsx scripts/paper-allocator-run.ts >> "$LOGDIR/run.log" 2>&1
echo "" >> "$LOGDIR/run.log"
