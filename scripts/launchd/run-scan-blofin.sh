#!/usr/bin/env bash
# launchd runner for the Blofin top-10 perp scanner (--fire).
# Cwd is set by the plist's WorkingDirectory. PATH and CRYPTOTRADER_STATE_DIR
# are set by EnvironmentVariables.
set -euo pipefail
exec npx tsx scripts/scan-blofin.ts --fire
