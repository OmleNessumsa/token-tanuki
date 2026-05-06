#!/bin/bash
# Wrapper for scheduled position report run.
set -e
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
cd "$HOME/code/cryptotrader"
exec npx tsx scripts/positions-report.ts
