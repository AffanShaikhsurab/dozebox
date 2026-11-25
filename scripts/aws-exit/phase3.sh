#!/usr/bin/env bash
# Phase 3 real-AWS exit (part 16, WP-D1): the smoke drill (part 10 §10.1.2 steps 1 to 11 and 13). See warm.sh.
set -euo pipefail
# Each phase has its own stack (box drill-p<N>, dozebox:test=dz-test-p<N>, TF_VAR_network picks its zone), so the
# phases run in parallel; the stack is destroyed and swept on exit, and the JSON line lists anything left.
: "${DZ_WARM_BOX:=drill-p3}" "${DZ_WARM_TAG:=dz-test-p3}"
export DZ_WARM_BOX DZ_WARM_TAG
. "$(dirname "$0")/warm.sh"
ok=false
finish() {
  local left
  [ "${DZ_NO_DESTROY:-0}" = 1 ] && { echo "{\"phase\":3,\"ok\":$ok,\"box\":\"$WARM_BOX\",\"kept\":true}"; return; }
  left="$(warm_destroy 2> /dev/null | jq -R . | jq -sc 'map(select(. != ""))' || echo '["destroy failed"]')"
  echo "{\"phase\":3,\"ok\":$ok,\"box\":\"$WARM_BOX\",\"reports\":$(ls drills/phase3*.json 2> /dev/null | jq -R . | jq -sc .),\"leftovers\":$left}"
}
trap finish EXIT
warm_spend_ok
warm_prepare
dz drill smoke --stack "$WARM" --skip upgrade --keep "${DELIVER[@]}" --report drills/phase3.json || true
jq -e '.ok and ([.steps[] | select(.ok|not)] | length == 0)' drills/phase3.json > /dev/null && ok=true
