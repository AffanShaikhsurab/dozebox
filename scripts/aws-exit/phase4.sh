#!/usr/bin/env bash
# Phase 4 real-AWS exit (part 16, WP-D2): spot reclaim, On-Demand fallback, and smoke with a live hold, on the warm
# drill stack (see warm.sh). The stack stays parked afterwards.
set -euo pipefail
. "$(dirname "$0")/warm.sh"
warm_spend_ok
warm_prepare
dz drill spot --stack "$WARM" "${DELIVER[@]}" --report drills/phase4-spot.json || true
dz drill fallback --stack "$WARM" "${DELIVER[@]}" --report drills/phase4-fallback.json || true
dz drill smoke --stack "$WARM" --skip upgrade --with-hold --keep "${DELIVER[@]}" --report drills/phase4-smoke.json || true
for r in drills/phase4-*.json; do jq -e '.ok' "$r" > /dev/null; done
echo "{\"phase\":4,\"ok\":true,\"box\":\"$WARM_BOX\"}"
