#!/usr/bin/env bash
# The final history scrub before the public flip (WP-Z1), in a scratch directory, never in a developer checkout.
#   scripts/release/scrub.sh --private <expressions-file> [--source <git-url>] [--slug owner/name] [--push <git-url>] <work-dir>
# 1. Bare clone of every branch and tag of --source (default: this checkout's origin).
# 2. git filter-repo: drop legacy/ from every commit, apply scripts/history/scrub-expressions.txt, the private file and
#    the fake-id rule (every 12-digit number and i-/vol-/snap- id except scripts/history/fake-ids.txt) to contents
#    and messages, and map every human identity to the maintainer's public one.
# 3. scripts/release/scrub-check.sh on the result. With --push, and only when the check is clean, force-push every
#    branch and tag to that URL. Without --push it is a rehearsal: nothing leaves <work-dir>.
set -euo pipefail
private="" source="" push="" slug=""
while [ $# -gt 0 ]; do
  case "$1" in
    --private) private="${2:?}"; shift 2 ;;
    --source) source="${2:?}"; shift 2 ;;
    --push) push="${2:?}"; shift 2 ;;
    --slug) slug="${2:?}"; shift 2 ;;
    -*) echo "scrub: unknown flag $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
work="${1:?work dir}"
[ -n "$private" ] || { echo "scrub: --private <file> is required" >&2; exit 2; }
private="$(cd "$(dirname "$private")" && pwd)/$(basename "$private")"
here="$(cd "$(dirname "$0")" && pwd)"
history="$here/../history"
[ -n "$source" ] || source="$(git -C "$here" remote get-url origin)"

mkdir -p "$work"
work="$(cd "$work" && pwd)"
rm -rf "$work/repo.git" "$work/checkout" "$work/original"
git clone -q --bare "$source" "$work/repo.git"
# Only `main` and the tags go public: lane, phase and orchestration branches (plans, notes, the real account) do not.
git -C "$work/repo.git" for-each-ref --format='%(refname)' refs/heads | grep -vx 'refs/heads/main' \
  | while read -r ref; do git -C "$work/repo.git" update-ref -d "$ref"; done

# The public repo's slug and the owner's @handle survive the name rules: filter-repo applies every literal first, then
# the regexes in file order, so the placeholder goes in as a literal and comes back by the last regex.
[ -n "$slug" ] || slug="$(echo "$source" | sed -nE 's#^.*github\.com[:/]([^/]+/[^/]+)$#\1#p' | sed 's/\.git$//')"
[ -n "$slug" ] || { echo "scrub: cannot read owner/name from $source" >&2; exit 2; }
# A per-run token, so this file's own text is not a placeholder the last rule would restore.
keep="dzkeep$(date +%s%N)"
{
  printf '%s==>%s/%s\n@%s==>@%s\n' "$slug" "$keep" "${slug#*/}" "${slug%/*}" "$keep"
  cat "$history/scrub-expressions.txt"
  grep -vE '^#|^$' "$private"
  bash "$history/fake-id-rule.sh" "$history/fake-ids.txt"
  printf 'regex:%s==>%s\n' "$keep" "${slug%/*}"
} > "$work/expressions.txt"

git -C "$work/repo.git" log --all --format='%ae%n%ce' | sort -u | while read -r email; do
  case "$email" in
    noreply@github.com | *+kiro-agent@users.noreply.github.com | maintainer@users.noreply.github.com) ;;
    *) printf 'Maintainer <maintainer@users.noreply.github.com> <%s>\n' "$email" ;;
  esac
done > "$work/mailmap.txt"

git -C "$work/repo.git" filter-repo --force \
  --invert-paths --path legacy/ \
  --replace-text "$work/expressions.txt" \
  --replace-message "$work/expressions.txt" \
  --mailmap "$work/mailmap.txt"
cp "$work/repo.git/filter-repo/commit-map" "$work/commit-map"

git clone -q --no-local "$work/repo.git" "$work/checkout"
git clone -q --single-branch --branch main "$source" "$work/original"
echo "scrub: what the rewrite changes in main's files (legacy/ removed, values replaced):"
diff -rq --exclude=.git "$work/original" "$work/checkout" | grep -v "^Only in $work/original: legacy$" | sed "s#$work/##g" || true
diff -ru --exclude=.git --exclude=legacy "$work/original" "$work/checkout" > "$work/head.diff" || true
echo "scrub: identities after the rewrite:"
git -C "$work/checkout" log --all --format='  %an <%ae>' | sort -u
bash "$here/scrub-check.sh" --private "$private" --slug "$slug" --report "$work/report.txt" "$work/checkout"

if [ -n "$push" ]; then
  git -C "$work/repo.git" push --force "$push" main
  git -C "$work/repo.git" push --force --tags "$push"
  echo "scrub: pushed main and tags to $push"
else
  echo "scrub: rehearsal done; to publish: git -C $work/repo.git push --force <url> main && git -C $work/repo.git push --force --tags <url>"
fi
