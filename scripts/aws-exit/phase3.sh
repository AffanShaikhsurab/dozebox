#!/usr/bin/env bash
# Phase 3 real-AWS exit (part 16, WP-D1): the smoke drill (part 10 §10.1.2 steps 1 to 11 and 13) on the warm drill
# stack, kept parked afterwards for the next phase (`--keep`; `phase6.sh --destroy` tears it down). See warm.sh.
set -euo pipefail
. "$(dirname "$0")/warm.sh"
warm_spend_ok
warm_prepare
dz drill smoke --stack "$WARM" --skip upgrade --keep "${DELIVER[@]}" --report drills/phase3.json || true
jq -e '.ok and ([.steps[] | select(.ok|not)] | length == 0)' drills/phase3.json > /dev/null
echo "{\"phase\":3,\"ok\":true,\"box\":\"$WARM_BOX\",\"estimatedUsd\":$(jq '.estimateUsd' drills/phase3.json)}"
