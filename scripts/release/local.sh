#!/usr/bin/env bash
# Build a release the way .github/workflows/release.yml does, without publishing anything (WP-Z2).
#   scripts/release/local.sh --version <semver> [--out dist/release] [--skip-check]
# Output in <out>: dozebox-agent-<v>-linux-{aarch64,x86_64}.tar.gz (+ slim/), dozebox-control-<v>.zip,
# npm/*.tgz (the packed npm packages, workspace ranges resolved) and SHA256SUMS over all of them.
# Ends with `npm publish --dry-run` of every npm tarball and `sha256sum -c SHA256SUMS`.
# The package.json versions are stamped for the build and restored on exit.
set -euo pipefail
version="" out="dist/release" check=1
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    --skip-check) check=0; shift ;;
    *) echo "local.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "local.sh: --version <semver> is required (got '$version')" >&2; exit 2
fi
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
case "$out" in /*) ;; *) out="$root/$out" ;; esac
# Published npm packages, in publish order (dependencies first).
npm_packages=(protocol client cli)
tag="latest"
case "$version" in *-*) tag="next" ;; esac

backup="$(mktemp -d)"
restore() { for p in "${npm_packages[@]}"; do [ -f "$backup/$p.json" ] && cp "$backup/$p.json" "packages/$p/package.json"; done; rm -rf "$backup"; }
trap restore EXIT

step() { echo; echo "== $*"; }
step "install"
pnpm install --frozen-lockfile
if [ "$check" = "1" ]; then step "check"; pnpm check; fi
step "licenses"
pnpm -s check:licenses

step "stamp version $version"
for p in "${npm_packages[@]}"; do
  cp "packages/$p/package.json" "$backup/$p.json"
  node -e 'const f=process.argv[1],v=process.argv[2],fs=require("fs");const j=JSON.parse(fs.readFileSync(f,"utf8"));j.version=v;fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' \
    "packages/$p/package.json" "$version"
done

step "build"
rm -rf "$out"
mkdir -p "$out/npm"
pnpm -r --if-present build
if [ ! -f scripts/release/build-agent.ts ]; then
  echo "local.sh: scripts/release/build-agent.ts is missing (it lands with lane/integrate)" >&2; exit 1
fi
node scripts/release/build-agent.ts --version "$version" --arch aarch64 --arch x86_64 --out "$out"
cp packages/control/dist/control.zip "$out/dozebox-control-$version.zip"

step "pack npm packages"
for p in "${npm_packages[@]}"; do
  (cd "packages/$p" && pnpm pack --pack-destination "$out/npm" > /dev/null)
done
for f in "$out"/npm/*.tgz; do
  if tar -xOzf "$f" package/package.json | grep -q '"workspace:'; then
    echo "local.sh: $(basename "$f") still has a workspace: range" >&2; exit 1
  fi
done

step "SHA256SUMS"
(cd "$out" && sha256sum -- *.tar.gz *.zip npm/*.tgz > SHA256SUMS && sha256sum -c --quiet SHA256SUMS)
cat "$out/SHA256SUMS"

step "npm publish --dry-run (tag $tag)"
for p in "${npm_packages[@]}"; do
  name="$(node -p "require('./packages/$p/package.json').name")"
  file="$out/npm/$(echo "$name" | sed 's/^@//; s#/#-#')-$version.tgz"
  # Provenance needs the CI's OIDC token; the workflow publishes with it, the dry run here without.
  if ! npm publish --dry-run --provenance=false --access public --tag "$tag" "$file" > "$backup/publish.txt" 2>&1; then
    cat "$backup/publish.txt" >&2; exit 1
  fi
  grep -E 'notice (name|version|total files)|warn' "$backup/publish.txt" || true
done
echo
echo "local.sh: release $version built in $out (nothing published)"
