#!/bin/bash
# Wrapper for scheduled scanner run. Logs go to ~/Library/Logs/cryptotrader/.
set -e
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
cd "$HOME/code/cryptotrader"
exec npx tsx scripts/scanner-alerts.ts --top 30 --min 75
