#!/bin/bash
#
# Daily paper-trading run for the beta harvester (Fase 3).
# Idempotent: the runner rebalances at most once per closed UTC day, so
# extra fires (RunAtLoad, post-sleep catch-up) just mark NAV without
# re-trading. State lives in the default ~/.cryptotrader/harvester-paper.json.
#
# Loaded via ~/Library/LaunchAgents/com.cryptotrader.harvester-paper.plist.

set -euo pipefail

cd /Users/elmo.asmussen/Projects/Crypto

LOGDIR="$HOME/Library/Logs/cryptotrader-harvester"
mkdir -p "$LOGDIR"

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) harvester paper run ===" >> "$LOGDIR/run.log"
/opt/homebrew/bin/npx tsx scripts/paper-harvester-run.ts >> "$LOGDIR/run.log" 2>&1
echo "" >> "$LOGDIR/run.log"
