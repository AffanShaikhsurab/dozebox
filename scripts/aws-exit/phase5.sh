#!/usr/bin/env bash
# Phase 5 real-AWS exit (part 16, WP-D3): restore, kill, the full smoke (with the control upgrade) with a hold, then
# front-door last (CloudFront deploys and deletes take 5 to 15 minutes each). See warm.sh.
set -euo pipefail
# Each phase has its own stack (box drill-p<N>, dozebox:test=dz-test-p<N>, TF_VAR_network picks its zone), so the
# phases run in parallel; the stack is destroyed and swept on exit, and the JSON line lists anything left.
: "${DZ_WARM_BOX:=drill-p5}" "${DZ_WARM_TAG:=dz-test-p5}"
export DZ_WARM_BOX DZ_WARM_TAG
. "$(dirname "$0")/warm.sh"
ok=false
finish() {
  local left
  [ "${DZ_NO_DESTROY:-0}" = 1 ] && { echo "{\"phase\":5,\"ok\":$ok,\"box\":\"$WARM_BOX\",\"kept\":true}"; return; }
  left="$(warm_destroy 2> /dev/null | jq -R . | jq -sc 'map(select(. != ""))' || echo '["destroy failed"]')"
  echo "{\"phase\":5,\"ok\":$ok,\"box\":\"$WARM_BOX\",\"reports\":$(ls drills/phase5*.json 2> /dev/null | jq -R . | jq -sc .),\"leftovers\":$left}"
}
trap finish EXIT
warm_spend_ok
warm_prepare
# Smoke first: it writes the marker data and parks the box, so the snapshot the restore drill needs has content.
dz drill smoke --stack "$WARM" --with-hold --keep "${DELIVER[@]}" --report drills/phase5-smoke.json || true
dz snapshots create --stack "$WARM" --label drill-restore --json > /dev/null || true
dz drill restore --stack "$WARM" "${DELIVER[@]}" --report drills/phase5-restore.json || true
dz drill kill --stack "$WARM" "${DELIVER[@]}" --report drills/phase5-kill.json || true
dz drill front-door --stack "$WARM" --report drills/phase5-front-door.json || true
ok=true
for r in drills/phase5-restore.json drills/phase5-kill.json drills/phase5-smoke.json drills/phase5-front-door.json; do
  jq -e '.ok' "$r" > /dev/null || ok=false
done
