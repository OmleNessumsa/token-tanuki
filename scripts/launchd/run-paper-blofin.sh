#!/usr/bin/env bash
# launchd runner for the paper-trader tick on the Blofin tenant. Reads signals
# from the blofin tenant log, opens new paper positions (LONG and SHORT),
# ticks TPs/stops/horizon on opens.
set -euo pipefail
exec npx tsx scripts/paper-trader.ts
