#!/usr/bin/env bash
# Phase 6 real-AWS exit (part 16): smoke with a hold and the extras (jail escape suite on the box, tripwire page,
# agent rollback from a broken pre-release, DZ_BROKEN_TARBALL). See warm.sh.
set -euo pipefail
# Each phase has its own stack (box drill-p<N>, dozebox:test=dz-test-p<N>, TF_VAR_network picks its zone), so the
# phases run in parallel; the stack is destroyed and swept on exit, and the JSON line lists anything left.
: "${DZ_WARM_BOX:=drill-p6}" "${DZ_WARM_TAG:=dz-test-p6}"
export DZ_WARM_BOX DZ_WARM_TAG
. "$(dirname "$0")/warm.sh"
ok=false
finish() {
  local left
  left="$(warm_destroy 2> /dev/null | jq -R . | jq -sc 'map(select(. != ""))' || echo '["destroy failed"]')"
  echo "{\"phase\":6,\"ok\":$ok,\"box\":\"$WARM_BOX\",\"reports\":$(ls drills/phase6*.json 2> /dev/null | jq -R . | jq -sc .),\"leftovers\":$left}"
}
trap finish EXIT
warm_spend_ok
warm_prepare
extra=(--extra jail,tripwire,agent-rollback)
[ -n "${DZ_BROKEN_TARBALL:-}" ] && extra+=(--broken "$DZ_BROKEN_TARBALL")
dz drill smoke --stack "$WARM" --skip upgrade --with-hold --keep "${extra[@]}" "${DELIVER[@]}" \
  --report drills/phase6-smoke.json || true
jq -e '.ok' drills/phase6-smoke.json > /dev/null && ok=true
