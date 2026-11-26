#!/usr/bin/env bash
# Stage 0 entry point for dozebox-stage0.service. cloud-init's runcmd runs once per instance, and the stack stops the
# box right after create, so a stop during runcmd would lose stage 0 for the instance's whole life. This unit is
# enabled on every boot instead: it arms the failsafe, records the boot-to-stage0 step, installs the agent, and writes
# the done marker only after that succeeded.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
run_dir="${DOZEBOX_RUN_DIR:-/run/dozebox}"
systemctl_bin="${DOZEBOX_SYSTEMCTL_BIN:-systemctl}"
uptime_file="${DOZEBOX_UPTIME_FILE:-/proc/uptime}"
mkdir -p "$run_dir"

# Arm the failsafe first: a box whose stage 0 fails must still park itself instead of running until someone notices.
"$systemctl_bin" daemon-reload || true
"$systemctl_bin" enable --now dozebox-failsafe.timer || echo "stage0: could not arm dozebox-failsafe.timer" >&2

up="$(cut -d. -f1 "$uptime_file" 2>/dev/null || true)"
up="${up:-0}"
printf '{"step":"stage0","startedAt":%s,"ms":%s,"ok":true}\n' \
  "$(($(date +%s%3N) - up * 1000))" "$((up * 1000))" >>"${run_dir}/boot-timeline.jsonl" || true

bash "${here}/install-agent.sh" "$@" || exit 1
: >"${run_dir}/stage0.done"
