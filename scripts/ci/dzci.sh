#!/usr/bin/env bash
# dozebox CI on the CI box: the jobs of .github/workflows/ci.yml, independent jobs in parallel.
#   ~/dzci.sh [ref]          ref defaults to main; any branch, tag or sha on origin
# One persistent clone (fetch + checkout --detach; git clean keeps node_modules and .terraform), pnpm's default store and
# a persistent Terraform plugin cache. On a ref other than main, gitleaks scans origin/main..HEAD; on main, all history.
# Logs: ~/dzci/logs/<sha>/<job>.txt. Last line: DZCI-OK <sha>, or DZCI-FAIL <job>[,<job>...] <sha>.
set -uo pipefail
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"
ref="${1:-main}"
repo="git@github.com:AffanShaikhsurab/dozebox.git"
base="$HOME/dzci"
mkdir -p "$base/tf-plugins"
exec 9> "$base/.lock"
flock -w 3600 9 || { echo "DZCI-FAIL lock"; exit 1; }
export TF_PLUGIN_CACHE_DIR="$base/tf-plugins" TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE=true TF_IN_AUTOMATION=1
started=$SECONDS

work="$base/repo"
if [ ! -d "$work/.git" ]; then
  rm -rf "$work"
  git clone -q --no-tags "$repo" "$work" 2>"$base/clone.err" || { cat "$base/clone.err"; echo "DZCI-FAIL clone"; exit 1; }
fi
cd "$work" || { echo "DZCI-FAIL clone"; exit 1; }
git fetch -q --prune --no-tags origin '+refs/heads/*:refs/remotes/origin/*' || { echo "DZCI-FAIL fetch"; exit 1; }
git fetch -q --no-tags origin "$ref" 2>/dev/null || true
if ! git checkout -q -f --detach "origin/$ref" 2>/dev/null && ! git checkout -q -f --detach "$ref" 2>/dev/null; then
  echo "DZCI-FAIL checkout $ref"; exit 1
fi
git clean -q -ffdx -e node_modules -e .terraform
sha="$(git rev-parse HEAD)"
logs="$base/logs/$sha"
rm -rf "$logs"; mkdir -p "$logs"
echo "dzci: $ref at $sha ($(node -v), pnpm $(pnpm -v), $(terraform -v | head -1), gitleaks $(gitleaks version))"

if [ "$ref" = "main" ]; then leaks_range="--all"; else leaks_range="origin/main..HEAD"; fi

# job <name> <command...>: runs in the background, writes $logs/<name>.txt and $logs/<name>.rc.
started_jobs=()
job() {
  local name="$1"; shift
  started_jobs+=("$name")
  (
    start=$SECONDS
    "$@" > "$logs/$name.txt" 2>&1
    rc=$?
    echo "$rc $((SECONDS - start))" > "$logs/$name.rc"
  ) &
}

terraform_job() {
  terraform fmt -check -recursive terraform &&
    terraform -chdir=terraform init -backend=false -input=false &&
    terraform -chdir=terraform test &&
    terraform -chdir=terraform/bootstrap init -backend=false -input=false &&
    terraform -chdir=terraform/bootstrap test
}

node_jobs() {
  local start=$SECONDS
  pnpm install --frozen-lockfile > "$logs/install.txt" 2>&1
  local rc=$?
  echo "$rc $((SECONDS - start))" > "$logs/install.rc"
  [ "$rc" = "0" ] || return
  job check pnpm check
  job schema pnpm --filter @dozebox/protocol gen:schema --check
  # CPU-bound on 8 cores: the simulator yields to legacy, terraform and check.
  job sim nice -n 10 pnpm sim --seeds 2000
  job sim-judge nice -n 10 pnpm sim:judge
  job docs pnpm docs:check
  job licenses pnpm check:licenses
}

job terraform terraform_job
job legacy node --test "legacy/runner/test/**/*.node-test.ts"
job gitleaks gitleaks git --log-opts="$leaks_range" --redact --no-banner --exit-code 1 .
node_jobs
wait

failed=()
for name in install "${started_jobs[@]}"; do
  code=1 secs=0
  [ -f "$logs/$name.rc" ] && read -r code secs < "$logs/$name.rc"
  if [ "$code" = "0" ]; then
    echo "  ok    $name ($secs s)"
  else
    echo "  FAIL  $name ($secs s), last lines of $logs/$name.txt:"
    tail -15 "$logs/$name.txt" | sed 's/^/        /'
    failed+=("$name")
  fi
done
echo "dzci: $((SECONDS - started)) s"

if [ "${#failed[@]}" -eq 0 ]; then
  echo "DZCI-OK $sha"
else
  echo "DZCI-FAIL $(IFS=,; echo "${failed[*]}") $sha"
  exit 1
fi
