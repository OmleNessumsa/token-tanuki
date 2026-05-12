#!/usr/bin/env bash
# launchd runner for the paper-trader tick. Reads signals from the elmo
# tenant log, opens new paper positions, ticks TPs/stops/horizon on opens.
set -euo pipefail
exec npx tsx scripts/paper-trader.ts
