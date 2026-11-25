#!/usr/bin/env bash
# Phase 2 real-AWS exit (part 16, owned by WP-C3): apply examples/drill with the built control bundle
# (control_bundle_path), no agent and no front door, then drive the instance through the control API: wake (twice with
# one Idempotency-Key), the tick starts it, park, the tick stops it and it stays stopped for three ticks, a wrong token
# is 401, and the reconcile lease has been granted more than once. Tears everything down on exit and checks that
# nothing tagged with this run's dozebox:test value remains. Run from the repo root with credentials for the test
# account and `pnpm install` done. TF_VAR_network passes an existing VPC where the account may not create one.
set -euo pipefail
run="p2-$(date +%s | tail -c 7)"
box="$(printf 'drill-%s-zzzzzzzzzzzz' "$run" | cut -c1-20)"
export TF_VAR_test_tag="${TF_VAR_test_tag:-$run}"   # per run, so the leftover check sees only this run
started="$(date +%s)"
tf() { terraform -chdir=examples/drill "$@"; }
bundle="$PWD/packages/control/dist/control.zip"
vars=(-var "box_id=$box" -var agent_version=none -var front_door=false -var "control_bundle_path=$bundle")
param=""
ok=false
leftovers="[]"

# Destroy, then list what still carries this run's tag. The tagging API lists terminated instances, deleted volumes
# and cancelled Spot requests for a while, so those are checked with describe calls.
teardown() {
  [ -n "$param" ] && aws ssm delete-parameter --name "$param" > /dev/null 2>&1 || true
  if ! tf destroy -auto-approve "${vars[@]}" > /tmp/"$run"-destroy.log 2>&1; then
    # The test user may not delete schedule groups (STATUS.md): drop it from state and destroy the rest.
    tf state list 2>/dev/null | grep -E 'aws_scheduler_schedule_group' | xargs -r -n1 terraform -chdir=examples/drill state rm > /dev/null || true
    tf destroy -auto-approve "${vars[@]}" >> /tmp/"$run"-destroy.log 2>&1 || echo "destroy failed: /tmp/$run-destroy.log" >&2
  fi
  local arn left=()
  for arn in $(aws resourcegroupstaggingapi get-resources --tag-filters "Key=dozebox:test,Values=$TF_VAR_test_tag" \
    --query 'ResourceTagMappingList[].ResourceARN' --output text || echo tagging-api-failed); do
    case "$arn" in
      *:instance/*)
        [ "$(aws ec2 describe-instances --instance-ids "${arn##*/}" --query 'Reservations[0].Instances[0].State.Name' \
          --output text 2> /dev/null || echo terminated)" = terminated ] && continue ;;
      *:volume/*) aws ec2 describe-volumes --volume-ids "${arn##*/}" > /dev/null 2>&1 || continue ;;
      *:spot-instances-request/*)
        case "$(aws ec2 describe-spot-instance-requests --spot-instance-request-ids "${arn##*/}" \
          --query 'SpotInstanceRequests[0].State' --output text 2> /dev/null || echo cancelled)" in
          cancelled | closed) continue ;;
        esac ;;
    esac
    left+=("$arn")
  done
  leftovers="$(printf '%s\n' "${left[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
  [ "$leftovers" = "[]" ] || ok=false
  minutes=$(( ($(date +%s) - started) / 60 ))
  echo "{\"phase\":2,\"ok\":$ok,\"box\":\"$box\",\"minutes\":$minutes,\"estimatedUsd\":0.05,\"leftovers\":$leftovers}"
  [ "$ok" = true ]
}
trap teardown EXIT

pnpm --filter @dozebox/control build > /dev/null
tf init -input=false > /dev/null
tf apply -auto-approve "${vars[@]}" > /tmp/"$run"-apply.log
id="$(tf output -raw persistent_instance_id)"
url="$(tf output -raw control_url)"; url="${url%/}"

param="$(tf output -raw wake_token_parameter)"
token="$(openssl rand -hex 24)"
aws ssm put-parameter --name "$param" --type SecureString --value "$token" \
  --tags "Key=dozebox:test,Value=$TF_VAR_test_tag" "Key=dozebox:owner,Value=orchestrator" > /dev/null
aws ec2 wait instance-stopped --instance-ids "$id"

curl -fsS -X POST "$url/v1/wake" -H "x-dozebox-token: $token" -H "Idempotency-Key: $run-1" | jq -e '.decision=="accept"'
curl -fsS -X POST "$url/v1/wake" -H "x-dozebox-token: $token" -H "Idempotency-Key: $run-1" | jq -e '.decision=="accept"'
aws ec2 wait instance-running --instance-ids "$id"   # the tick started it (one tick a minute)
curl -fsS "$url/v1/status" -H "x-dozebox-token: $token" | jq -e '.state=="running" or .state=="launching"'
curl -fsS -X POST "$url/v1/park" -H "x-dozebox-token: $token" | jq -e '.decision=="accept"'
aws ec2 wait instance-stopped --instance-ids "$id"
sleep 180   # three ticks: the park must stay parked (R2); a real-time wait against real AWS, not a unit test
aws ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].State.Name' --output text \
  | grep -qx stopped
curl -sS -o /dev/null -w '%{http_code}' "$url/v1/status" -H "x-dozebox-token: wrong" | grep -qx 401
aws dynamodb get-item --table-name "$(tf output -raw state_table_name)" --key '{"pk":{"S":"lease#reconcile"}}' \
  | jq -e '.Item.fencing.N | tonumber > 1'
ok=true
