#!/usr/bin/env bash
# Phase 4 real-AWS exit (part 16, WP-D2): spot reclaim, fallback and smoke with a live hold. Its stack is Spot
# (DZ_PURCHASE=spot) because the spot drill needs a Spot instance. See warm.sh.
set -euo pipefail
# Each phase has its own stack (box drill-p<N>, dozebox:test=dz-test-p<N>, TF_VAR_network picks its zone), so the
# phases run in parallel; the stack is destroyed and swept on exit, and the JSON line lists anything left.
: "${DZ_WARM_BOX:=drill-p4}" "${DZ_WARM_TAG:=dz-test-p4}"
export DZ_WARM_BOX DZ_WARM_TAG
. "$(dirname "$0")/warm.sh"
ok=false
finish() {
  local left
  [ "${DZ_NO_DESTROY:-0}" = 1 ] && { echo "{\"phase\":4,\"ok\":$ok,\"box\":\"$WARM_BOX\",\"kept\":true}"; return; }
  left="$(warm_destroy 2> /dev/null | jq -R . | jq -sc 'map(select(. != ""))' || echo '["destroy failed"]')"
  echo "{\"phase\":4,\"ok\":$ok,\"box\":\"$WARM_BOX\",\"reports\":$(ls drills/phase4*.json 2> /dev/null | jq -R . | jq -sc .),\"leftovers\":$left}"
}
trap finish EXIT
warm_spend_ok
warm_prepare
dz drill spot --stack "$WARM" "${DELIVER[@]}" --report drills/phase4-spot.json || true
dz drill fallback --stack "$WARM" "${DELIVER[@]}" --report drills/phase4-fallback.json || true
dz drill smoke --stack "$WARM" --skip upgrade --with-hold --keep "${DELIVER[@]}" --report drills/phase4-smoke.json || true
ok=true
for r in drills/phase4-spot.json drills/phase4-fallback.json drills/phase4-smoke.json; do jq -e '.ok' "$r" > /dev/null || ok=false; done
