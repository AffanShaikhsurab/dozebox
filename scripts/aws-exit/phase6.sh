#!/usr/bin/env bash
# Phase 6 real-AWS exit (part 16): smoke with a hold and the extras (jail escape suite on the box, tripwire page,
# agent rollback from a broken pre-release) on the warm drill stack (see warm.sh). `--destroy` then tears the warm
# stack down and fails when anything tagged with its dozebox:test value remains.
#   DZ_BROKEN_TARBALL  the deliberately broken agent release for agent-rollback
set -euo pipefail
. "$(dirname "$0")/warm.sh"
warm_spend_ok
warm_prepare
extra=(--extra jail,tripwire,agent-rollback)
[ -n "${DZ_BROKEN_TARBALL:-}" ] && extra+=(--broken "$DZ_BROKEN_TARBALL")
dz drill smoke --stack "$WARM" --skip upgrade --with-hold --keep "${extra[@]}" "${DELIVER[@]}" \
  --report drills/phase6-smoke.json || true
jq -e '.ok' drills/phase6-smoke.json > /dev/null
left="[]"
if [ "${1:-}" = "--destroy" ]; then
  left="$(warm_destroy | jq -R . | jq -sc 'map(select(. != ""))')"
  [ "$left" = "[]" ]
fi
echo "{\"phase\":6,\"ok\":true,\"box\":\"$WARM_BOX\",\"leftovers\":$left}"
