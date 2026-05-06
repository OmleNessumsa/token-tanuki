#!/bin/bash
# Wrapper that launchd calls. Loads NVM + runs the bot.
set -e
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
cd "$HOME/code/cryptotrader"
exec npx tsx scripts/bot.ts
