#!/usr/bin/env bash
# Phase 5 real-AWS exit (part 16, WP-D3): restore and kill drills, then the full smoke (with the control upgrade) with
# a hold, on the warm drill stack (see warm.sh). The front-door drill needs CloudFront and WAF; where the account
# cannot create them its report says `blocked` and the exit lists it instead of failing (DZ_FRONT_DOOR=1 requires it).
set -euo pipefail
. "$(dirname "$0")/warm.sh"
warm_spend_ok
warm_prepare
dz drill front-door --stack "$WARM" --report drills/phase5-front-door.json || true
dz drill restore --stack "$WARM" "${DELIVER[@]}" --report drills/phase5-restore.json || true
dz drill kill --stack "$WARM" "${DELIVER[@]}" --report drills/phase5-kill.json || true
dz drill smoke --stack "$WARM" --with-hold --keep "${DELIVER[@]}" --report drills/phase5-smoke.json || true
blocked=()
for r in drills/phase5-*.json; do
  if [ "${DZ_FRONT_DOOR:-0}" != 1 ] && jq -e '.blocked' "$r" > /dev/null; then blocked+=("$(jq -r .drill "$r")"); continue; fi
  jq -e '.ok' "$r" > /dev/null
done
echo "{\"phase\":5,\"ok\":true,\"box\":\"$WARM_BOX\",\"blocked\":$(printf '%s\n' "${blocked[@]}" | jq -R . | jq -sc 'map(select(. != ""))')}"
