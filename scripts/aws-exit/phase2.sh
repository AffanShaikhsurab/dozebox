#!/usr/bin/env bash
# Phase 2 real-AWS exit (part 16, owned by WP-C3): apply examples/drill without an agent and without the front door,
# deploy the real control bundle, then drive the instance through the control API: wake (twice with one
# Idempotency-Key), the tick starts it, park, the tick stops it and it stays stopped for three ticks, a wrong token is
# 401, and the reconcile lease has been granted more than once. Tears everything down on exit. Run from the repo root
# with credentials for the test account and `pnpm install` done.
set -euo pipefail
run="p2-$(date +%s | tail -c 7)"
box="$(printf 'drill-%s-zzzzzzzzzzzz' "$run" | cut -c1-20)"
started="$(date +%s)"
tf() { terraform -chdir=examples/drill "$@"; }
vars=(-var "box_id=$box" -var agent_version=none -var front_door=false)
param=""
cleanup() {
  [ -n "$param" ] && aws ssm delete-parameter --name "$param" > /dev/null 2>&1 || true
  tf destroy -auto-approve "${vars[@]}" || true
}
trap cleanup EXIT

pnpm --filter @dozebox/control build > /dev/null
tf init -input=false > /dev/null
tf apply -auto-approve "${vars[@]}"
id="$(tf output -raw persistent_instance_id)"
fn="$(tf output -raw control_function_name)"
url="$(tf output -raw control_url)"; url="${url%/}"
aws lambda update-function-code --function-name "$fn" --zip-file fileb://packages/control/dist/control.zip > /dev/null
aws lambda wait function-updated-v2 --function-name "$fn"

param="$(tf output -raw wake_token_parameter)"
token="$(openssl rand -hex 24)"
aws ssm put-parameter --name "$param" --type SecureString --value "$token" \
  --tags "Key=dozebox:test,Value=${TF_VAR_test_tag:-drill}" "Key=dozebox:owner,Value=orchestrator" > /dev/null
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
minutes=$(( ($(date +%s) - started) / 60 ))
echo "{\"phase\":2,\"ok\":true,\"box\":\"$box\",\"minutes\":$minutes,\"estimatedUsd\":0.05}"
