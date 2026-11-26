#!/usr/bin/env bash
# Stage 0: fetch the agent release, verify it, switch to it, install its units, start. Idempotent.
# Usage: install-agent.sh <version> <base_url> <sha256>
set -euo pipefail

version="${1:?version}"
base="${2:?base url}"
expected_sha="${3:-}"
root="${DOZEBOX_ROOT:-/opt/dozebox}"
unit_dir="${DOZEBOX_UNIT_DIR:-/etc/systemd/system}"
run_dir="${DOZEBOX_RUN_DIR:-/run/dozebox}"
systemctl_bin="${DOZEBOX_SYSTEMCTL_BIN:-systemctl}"
curl_bin="${DOZEBOX_CURL_BIN:-curl}"
arch="${DOZEBOX_ARCH:-$(uname -m)}"
apt_bin="${DOZEBOX_APT_GET_BIN:-apt-get}"
bwrap_bin="${DOZEBOX_BWRAP_BIN:-bwrap}"
nft_bin="${DOZEBOX_NFT_BIN:-nft}"

dir="${root}/releases/${version}"
started="$(date +%s%3N)"
ok=false
tmp=""
mkdir -p "${root}/releases" "$run_dir"

finish() {
  local code=$?
  [[ -n "$tmp" ]] && rm -rf "$tmp"
  [[ $code -eq 0 && $ok == true ]] || ok=false
  printf '{"step":"agent-install","startedAt":%s,"ms":%s,"ok":%s}\n' \
    "$started" "$(($(date +%s%3N) - started))" "$ok" >>"${run_dir}/boot-timeline.jsonl" || true
}
trap finish EXIT

# The jail needs bwrap and nft; the stock Ubuntu image has neither. Best effort: the agent reports what is missing.
ensure_jail_packages() {
  local started ms ok=false
  started="$(date +%s%3N)"
  if command -v "$bwrap_bin" >/dev/null && command -v "$nft_bin" >/dev/null; then
    ok=true
  elif DEBIAN_FRONTEND=noninteractive "$apt_bin" install -y --no-install-recommends bubblewrap nftables; then
    ok=true
  else
    echo "install-agent: could not install bubblewrap and nftables" >&2
  fi
  ms=$(($(date +%s%3N) - started))
  printf '{"step":"jail-packages","startedAt":%s,"ms":%s,"ok":%s}\n' \
    "$started" "$ms" "$ok" >>"${run_dir}/boot-timeline.jsonl" || true
}

ensure_jail_packages

fetch() {
  tmp="$(mktemp -d "${root}/releases/.tmp.XXXXXX")"
  "$curl_bin" --fail --silent --show-error --location --retry 5 --max-time 120 \
    -o "${tmp}/agent.tar.gz" "${base}/dozebox-agent-${version}-linux-${arch}.tar.gz" &&
    echo "${expected_sha}  ${tmp}/agent.tar.gz" | sha256sum --check --status &&
    mkdir "${tmp}/release" && tar -xzf "${tmp}/agent.tar.gz" -C "${tmp}/release" &&
    [[ -x "${tmp}/release/bin/dozeboxd" ]] &&
    rm -rf "$dir" && mv "${tmp}/release" "$dir"
}

if [[ -x "${dir}/bin/dozeboxd" ]]; then
  ok=true
elif fetch; then
  ok=true
else
  previous="$(readlink -f "${root}/current" 2>/dev/null || true)"
  if [[ -n "$previous" && -x "${previous}/bin/dozeboxd" ]]; then
    echo "install-agent: could not install ${version}; keeping ${previous}" >&2
    dir="$previous"
  else
    echo "install-agent: could not install ${version} and there is no previous release" >&2
    exit 1
  fi
fi

ln -sfn "$dir" "${root}/current.new"
mv -T -f "${root}/current.new" "${root}/current"
mkdir -p "$unit_dir"
if [[ -d "${root}/current/systemd" ]]; then
  cp -f "${root}/current/systemd/"* "${unit_dir}/"
fi
"$systemctl_bin" daemon-reload
"$systemctl_bin" enable --now --no-block dozebox-boot.service dozeboxd.service
