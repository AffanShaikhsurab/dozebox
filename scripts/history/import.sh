#!/usr/bin/env bash
# Import the old runner's history into legacy/ with git filter-repo, scrubbed (part 12 M1 and M1b).
#
# Run in a scratch directory, never in a developer checkout: filter-repo rewrites every commit.
#
#   scripts/history/import.sh <source-git-url> <work-dir> [private-expressions-file]
#
# The private expressions file holds the values that must not appear in this repository (real names, e-mail
# addresses, instance ids), in the same `regex:...==>...` syntax as scrub-expressions.txt. It lives outside the repo.
# The result is <work-dir>/src on branch main, verified; push it to an `import` branch.
set -euo pipefail

src_url="${1:?source git url}"
work="${2:?work dir}"
private="${3:-}"
here="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$work"
work="$(cd "$work" && pwd)"
rm -rf "$work/src"
git clone -q --no-local --single-branch --branch main "$src_url" "$work/src"
git -C "$work/src" rev-parse HEAD > "$work/source-head.txt"

cat "$here/scrub-expressions.txt" > "$work/expressions.txt"
if [ -n "$private" ]; then cat "$private" >> "$work/expressions.txt"; fi
"$here/fake-id-rule.sh" "$here/fake-ids.txt" >> "$work/expressions.txt"

# Every human author becomes the maintainer's public identity; bots keep their public identity.
git -C "$work/src" log --format='%ae%n%ce' | sort -u | while read -r email; do
  case "$email" in
    noreply@github.com | *+kiro-agent@users.noreply.github.com) ;;
    *) printf 'Maintainer <maintainer@users.noreply.github.com> <%s>\n' "$email" ;;
  esac
done > "$work/mailmap.txt"

cd "$work/src"
git filter-repo --force \
  --path infra/runner/ \
  --path infra/terraform/ \
  --path infra/fis/ \
  --path docs/operations/cloud-machine.md \
  --path-rename infra/runner/:legacy/runner/ \
  --path-rename infra/terraform/:legacy/terraform/ \
  --path-rename infra/fis/:legacy/fis/ \
  --path-rename docs/operations/cloud-machine.md:legacy/docs/cloud-machine.md \
  --replace-text "$work/expressions.txt" \
  --replace-message "$work/expressions.txt" \
  --mailmap "$work/mailmap.txt"
cp .git/filter-repo/commit-map "$work/commit-map"

"$here/verify.sh" "$work/src" "$private"
echo "import: ok, $(git rev-list --count HEAD) commits, head $(git rev-parse HEAD)"
