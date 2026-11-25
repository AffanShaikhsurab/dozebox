#!/usr/bin/env bash
# Parks a box that never served (timer, 60 min after boot) or whose boot units failed for good (DOZEBOX_PARK_NOW=1).
# Plain bash and the AWS CLI, so it works when Node, the download or the agent broke.
set -u

run_dir="${DOZEBOX_RUN_DIR:-/run/dozebox}"
aws_bin="${DOZEBOX_AWS_BIN:-aws}"
sc="${DOZEBOX_SYSTEMCTL_BIN:-systemctl}"
curl_bin="${DOZEBOX_CURL_BIN:-curl}"
imds="${DOZEBOX_IMDS_URL:-http://169.254.169.254}"
uptime_file="${DOZEBOX_UPTIME_FILE:-/proc/uptime}"
instance_file="${DOZEBOX_INSTANCE_ID_FILE:-/var/lib/cloud/data/instance-id}"
boot_file="${DOZEBOX_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}"
prefix="${DOZEBOX_PREFIX:-dozebox}"
box="${DOZEBOX_BOX_ID:-}"
park_now="${DOZEBOX_PARK_NOW:-0}"

awsb() { timeout 90 "$aws_bin" "$@" --cli-connect-timeout 10 --cli-read-timeout 20; }
jstr() {
  local s="${1:0:$2}"
  s="$(printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037')"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '%s' "${s//$'\t'/\\t}"
}
poweroff_now() {
  local -a cmd
  read -ra cmd <<<"${DOZEBOX_POWEROFF_COMMAND:-shutdown -h now}"
  "${cmd[@]}"
}

failed=""
if [ "$park_now" = 1 ]; then
  # OnFailure= also fires for a crash systemd is about to restart: park only on a unit that failed for good.
  case "$(cat "${run_dir}/phase" 2>/dev/null)" in reclaim-notice | sleeping) exit 0 ;; esac
  for u in dozebox-boot dozeboxd; do
    if [ "$(timeout 10 "$sc" show -p ActiveState --value "${u}.service" 2>/dev/null)" = failed ]; then
      failed="${failed:+$failed, }${u} ($(timeout 10 "$sc" show -p Result --value "${u}.service" 2>/dev/null))"
    fi
  done
  [ -n "$failed" ] || exit 0
elif [ -e "${run_dir}/serving" ]; then
  exit 0
fi

up_min=$(($(cut -d. -f1 "$uptime_file" 2>/dev/null || echo 0) / 60))
if [ "$park_now" = 1 ]; then
  message="failsafe: ${failed} failed; parked ${up_min} min after boot"
else
  message="failsafe: the agent did not start serving within ${up_min} min of boot"
fi

if [ -n "$box" ] && command -v "$aws_bin" >/dev/null 2>&1; then
  instance="$(tr -d '[:space:]' <"$instance_file" 2>/dev/null)"
  boot="$(tr -d '[:space:]-' <"$boot_file" 2>/dev/null)"
  at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  writer="{\"instanceId\":\"$(jstr "$instance" 64)\",\"bootId\":\"$(jstr "$boot" 64)\"}"
  tmp="$(mktemp)"
  put() {
    printf '%s\n' "$2" >"$tmp"
    awsb ssm put-parameter --name "/${prefix}/${box}/rec/$1" --type String --overwrite \
      --value "file://${tmp}" >/dev/null || echo "failsafe: could not write rec/$1" >&2
  }
  put last-error "{\"v\":1,\"at\":\"${at}\",\"writer\":${writer},\"source\":\"failsafe\",\"message\":\"$(jstr "$message" 1000)\"}"
  put last-words "{\"v\":1,\"at\":\"${at}\",\"writer\":${writer},\"parkedBecause\":\"failsafe\",\"by\":\"failsafe\",\"detail\":\"$(jstr "$message" 300)\",\"recentErrors\":[],\"strikes\":0,\"awakeBecause\":[]}"
  rm -f "$tmp"

  # Group instances carry the aws:autoscaling:groupName tag; a persistent instance has none (404).
  group="" known=0
  token="$("$curl_bin" -sS --max-time 5 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' "${imds}/latest/api/token" 2>/dev/null)"
  if [ -n "$token" ]; then
    body="$(mktemp)"
    code="$("$curl_bin" -sS --max-time 5 -o "$body" -w '%{http_code}' -H "X-aws-ec2-metadata-token: ${token}" \
      "${imds}/latest/meta-data/tags/instance/aws:autoscaling:groupName" 2>/dev/null)"
    [ "$code" = 200 ] && group="$(cat "$body")" known=1
    [ "$code" = 404 ] && known=1
    rm -f "$body"
  fi
  if [ -n "$group" ]; then
    awsb autoscaling set-desired-capacity --auto-scaling-group-name "$group" --desired-capacity 0 --no-honor-cooldown && exit 0
  elif [ "$known" = 1 ] && [ -n "$instance" ]; then
    awsb ec2 stop-instances --instance-ids "$instance" >/dev/null && exit 0
  fi
else
  echo "failsafe: no AWS CLI on this box, powering off" >&2
fi
poweroff_now
