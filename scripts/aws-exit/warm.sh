#!/usr/bin/env bash
# Shared by phase3.sh .. phase6.sh: the warm drill stack. One stack (box `drill-warm`, tag dozebox:test=dz-test-warm)
# serves every drill of a session: it is applied once, re-applied only when Terraform changed (the smoke drill's
# deploy step plans first), and parked between drills (`--keep`). `warm_destroy` tears it down and sweeps the tag.
# Source it from the repo root with credentials for the test account and `pnpm install` done.
#   DZ_WARM_DIR        stack dir outside the repo checkout (default ~/.dozebox-warm), so a re-sync keeps the state
#   DZ_AGENT_VERSION   agent release version (default none: no agent)
#   DZ_AGENT_TARBALL   the release tarball to push through SSM (--deliver) when the box cannot download it
#   DZ_AGENT_BASE_URL  https base of the release assets; DZ_AGENT_SHA256 the aarch64 tarball's SHA-256
#   TF_VAR_network     the module's network input (accounts that may not create a VPC)
set -euo pipefail
repo="$(pwd)"
WARM="${DZ_WARM_DIR:-$HOME/.dozebox-warm}"
WARM_TAG="${DZ_WARM_TAG:-dz-test-warm}"
WARM_BOX="${DZ_WARM_BOX:-drill-warm}"
DELIVER=()
[ -n "${DZ_AGENT_TARBALL:-}" ] && DELIVER=(--deliver "$DZ_AGENT_TARBALL")

dz() { node --conditions=@dozebox/source "$repo/packages/cli/src/bin.ts" "$@"; }

warm_prepare() {
  mkdir -p "$WARM" "$repo/drills"
  pnpm --filter @dozebox/control build > /dev/null
  cp -f "$repo/packages/control/dist/control.zip" "$WARM/control.zip"
  sed -e "s#\.\./\.\./terraform#$repo/terraform#" -e "s#\${path.module}/\.\./payloads#$repo/examples/payloads#" \
    "$repo/examples/drill/main.tf" > "$WARM/main.tf"
  [ -f "$WARM/nonce" ] || openssl rand -hex 8 > "$WARM/nonce"
  local sha="null"
  [ -n "${DZ_AGENT_SHA256:-}" ] && sha="{\"arm64\":\"$DZ_AGENT_SHA256\"}"
  local base="null"
  [ -n "${DZ_AGENT_BASE_URL:-}" ] && base="\"$DZ_AGENT_BASE_URL\""
  cat > "$WARM/warm.auto.tfvars.json" <<EOF
{
  "box_id": "$WARM_BOX",
  "test_tag": "$WARM_TAG",
  "agent_version": "${DZ_AGENT_VERSION:-none}",
  "agent_artifact_base_url": $base,
  "agent_sha256": $sha,
  "control_bundle_path": "$WARM/control.zip",
  "marker_nonce": "$(cat "$WARM/nonce")"
}
EOF
  terraform -chdir="$WARM" init -input=false > /dev/null
  if [ -z "$(terraform -chdir="$WARM" state list 2> /dev/null)" ]; then
    dz deploy --stack "$WARM" --json > /dev/null
  fi
  local param
  param="$(terraform -chdir="$WARM" output -raw wake_token_parameter)"
  if ! aws ssm get-parameter --name "$param" > /dev/null 2>&1; then
    aws ssm put-parameter --name "$param" --type SecureString --value "$(openssl rand -hex 24)" \
      --tags "Key=dozebox:test,Value=$WARM_TAG" "Key=dozebox:owner,Value=orchestrator" > /dev/null
  fi
}

# Month-to-date spend on dozebox:test must stay under USD 6 (the drill also refuses on its own).
warm_spend_ok() {
  local start usd
  start="$(date -u +%Y-%m-01)"
  usd="$(aws ce get-cost-and-usage --time-period "Start=$start,End=$(date -u -d tomorrow +%Y-%m-%d)" \
    --granularity MONTHLY --metrics UnblendedCost --filter '{"Tags":{"Key":"dozebox:test","MatchOptions":["PRESENT"]}}' \
    --query 'ResultsByTime[0].Total.UnblendedCost.Amount' --output text 2> /dev/null || echo 0)"
  echo "month-to-date dozebox:test USD $usd" >&2
  awk -v u="$usd" 'BEGIN { exit !(u + 0 <= 6) }'
}

# Destroy the warm stack and list anything still tagged dozebox:test=$WARM_TAG that describe calls still find.
warm_destroy() {
  local param
  param="$(terraform -chdir="$WARM" output -raw wake_token_parameter 2> /dev/null || true)"
  dz destroy --stack "$WARM" --yes --json > /dev/null || terraform -chdir="$WARM" destroy -auto-approve > /dev/null || true
  # The test user may not delete the schedule group (STATUS.md); forget it so destroy completes.
  for r in $(terraform -chdir="$WARM" state list 2> /dev/null | grep aws_scheduler_schedule_group || true); do
    terraform -chdir="$WARM" state rm "$r" > /dev/null
  done
  terraform -chdir="$WARM" destroy -auto-approve > /dev/null
  [ -n "$param" ] && aws ssm delete-parameter --name "$param" > /dev/null 2>&1 || true
  for s in $(aws ec2 describe-snapshots --owner-ids self --filters "Name=tag:dozebox:test,Values=$WARM_TAG" \
    --query 'Snapshots[].SnapshotId' --output text); do
    aws ec2 delete-snapshot --snapshot-id "$s" || true
  done
  warm_leftovers
}

warm_leftovers() {
  local left=()
  local i v s
  i="$(aws ec2 describe-instances --filters "Name=tag:dozebox:test,Values=$WARM_TAG" \
    "Name=instance-state-name,Values=pending,running,stopping,stopped" --query 'Reservations[].Instances[].InstanceId' --output text)"
  v="$(aws ec2 describe-volumes --filters "Name=tag:dozebox:test,Values=$WARM_TAG" --query 'Volumes[].VolumeId' --output text)"
  s="$(aws ec2 describe-snapshots --owner-ids self --filters "Name=tag:dozebox:test,Values=$WARM_TAG" \
    --query 'Snapshots[].SnapshotId' --output text)"
  for x in $i $v $s; do left+=("$x"); done
  for arn in $(aws resourcegroupstaggingapi get-resources --tag-filters "Key=dozebox:test,Values=$WARM_TAG" \
    --query 'ResourceTagMappingList[].ResourceARN' --output text); do
    case "$arn" in
      *:instance/* | *:volume/* | *:snapshot/* | *:spot-instances-request/* | *:network-interface/*) ;; # stale; checked by describe
      *) left+=("$arn") ;;
    esac
  done
  printf '%s\n' "${left[@]}"
}
