#!/usr/bin/env bash
# Phase 1 real-AWS exit (part 16): apply a parked examples/drill stack, check it, destroy it. Run from the repo root
# with credentials for the test account. TF_VAR_test_tag sets the dozebox:test tag (default drill).
set -euo pipefail
run="p1-$(date +%s | tail -c 7)"
box="$(printf 'drill-%s-zzzzzzzzzzzz' "$run" | cut -c1-20)"   # 20 characters: the IAM size worst case
tf() { terraform -chdir=examples/drill "$@"; }
trap 'tf destroy -auto-approve -var box_id="$box" -var agent_version=none || true' EXIT
tf init -input=false
tf apply -auto-approve -var box_id="$box" -var agent_version=none   # real IAM accepts every policy
id="$(aws ec2 describe-instances --filters "Name=tag:dozebox:box,Values=$box" "Name=tag:dozebox:role,Values=persistent" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"
aws ec2 wait instance-stopped --instance-ids "$id"
aws ec2 describe-spot-instance-requests --filters "Name=instance-id,Values=$id" \
  --query 'SpotInstanceRequests[0].[Type,InstanceInterruptionBehavior]' --output text | grep -qx $'persistent\tstop'
vol="$(tf output -raw data_volume_id)"
aws ec2 describe-volumes --volume-ids "$vol" \
  --query "Volumes[0].Tags[?Key=='dozebox:active'].Value" --output text | grep -qx true
aws budgets describe-budget --account-id "$(aws sts get-caller-identity --query Account --output text)" \
  --budget-name "dozebox-${box}-monthly" > /dev/null
aws cloudwatch describe-alarms --alarm-name-prefix "dozebox-${box}-kill" --query 'length(MetricAlarms)' | grep -qv '^0$'
aws dlm get-lifecycle-policies --query "Policies[?contains(Description, '${box}')].State" --output text | grep -qx ENABLED
echo '{"phase":1,"ok":true}'
