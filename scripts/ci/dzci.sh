#!/usr/bin/env bash
# dozebox CI on the CI box: the jobs of .github/workflows/ci.yml, from a clean clone.
#   ~/dzci.sh [ref]          ref defaults to main; any branch, tag or sha on origin
# Logs: ~/dzci/logs/<sha>/<job>.txt. Last line: DZCI-OK <sha>, or DZCI-FAIL <job>[,<job>...] <sha>.
set -uo pipefail
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"
ref="${1:-main}"
repo="git@github.com:AffanShaikhsurab/dozebox.git"
base="$HOME/dzci"
mkdir -p "$base"
exec 9> "$base/.lock"
flock -w 3600 9 || { echo "DZCI-FAIL lock"; exit 1; }

work="$base/work"
rm -rf "$work"
if ! git clone -q --no-tags "$repo" "$work" 2>"$base/clone.err"; then
  cat "$base/clone.err"; echo "DZCI-FAIL clone"; exit 1
fi
cd "$work" || { echo "DZCI-FAIL clone"; exit 1; }
git fetch -q origin "$ref" 2>/dev/null || true
if ! git checkout -q --detach "origin/$ref" 2>/dev/null && ! git checkout -q --detach "$ref" 2>/dev/null; then
  echo "DZCI-FAIL checkout $ref"; exit 1
fi
git fetch -q --unshallow 2>/dev/null || true
git fetch -q origin '+refs/heads/*:refs/remotes/origin/*'
sha="$(git rev-parse HEAD)"
logs="$base/logs/$sha"
rm -rf "$logs"; mkdir -p "$logs"
echo "dzci: $ref at $sha ($(node -v), pnpm $(pnpm -v), $(terraform -v | head -1), gitleaks $(gitleaks version))"

failed=()
job() {
  local name="$1"; shift
  local start=$SECONDS
  if "$@" > "$logs/$name.txt" 2>&1; then
    echo "  ok    $name ($((SECONDS - start)) s)"
  else
    echo "  FAIL  $name ($((SECONDS - start)) s), last lines of $logs/$name.txt:"
    tail -15 "$logs/$name.txt" | sed 's/^/        /'
    failed+=("$name")
  fi
}

job install pnpm install --frozen-lockfile
if [ "${#failed[@]}" -eq 0 ]; then
  job check pnpm check
  job schema pnpm --filter @dozebox/protocol gen:schema --check
fi
job terraform bash -c 'terraform fmt -check -recursive terraform && terraform -chdir=terraform init -backend=false -input=false && terraform -chdir=terraform test && terraform -chdir=terraform/bootstrap init -backend=false -input=false && terraform -chdir=terraform/bootstrap test'
job legacy node --test "legacy/runner/test/**/*.node-test.ts"
job gitleaks gitleaks git --log-opts="--all" --redact --no-banner --exit-code 1 .

if [ "${#failed[@]}" -eq 0 ]; then
  echo "DZCI-OK $sha"
else
  echo "DZCI-FAIL $(IFS=,; echo "${failed[*]}") $sha"
  exit 1
fi
