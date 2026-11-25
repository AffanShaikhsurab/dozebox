#!/usr/bin/env bash
# Phase 7 exit scans over all history (WP-Z1), with the commit and file of every hit. Reads only; rewrites nothing.
#   scripts/release/scrub-check.sh [--private <expressions-file>] [--report <file>] [--slug owner/name] [repo]
# The private expressions file (real account ids, box ids, names, hosts) lives outside the repo and is never committed.
# It uses the filter-repo syntax: `literal==>replacement` or `regex:<pcre>==>replacement`.
# Matched text is masked in the output (first 2 characters and the length), so the report can be shared.
# Exit 0 when every scan is clean, 1 when any scan has a hit or a scanner is missing.
set -euo pipefail
export LC_ALL=C
private="" report="" slug=""
while [ $# -gt 0 ]; do
  case "$1" in
    --private) private="${2:?--private needs a file}"; shift 2 ;;
    --report) report="${2:?--report needs a file}"; shift 2 ;;
    --slug) slug="${2:?--slug needs owner/name}"; shift 2 ;;
    -*) echo "scrub-check: unknown flag $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
repo="$(cd "${1:-.}" && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
[ -n "$report" ] || report="$tmp/report.txt"
: > "$report"

# The public repository's own slug (owner/name) and the owner's @handle stay: they are in every repo URL. They are
# blanked before scanning, so a personal name elsewhere on the same line still counts. scrub.sh keeps the same two.
if [ -z "$slug" ]; then
  slug="$(git -C "$repo" remote get-url origin 2> /dev/null | sed -nE 's#^.*github\.com[:/]([^/]+/[^/]+)$#\1#p' | sed 's/\.git$//')"
fi
blank() { if [ -n "$slug" ]; then sed -e "s#${slug}#DZ-KEPT-SLUG#g" -e "s#@${slug%/*}\\b#@DZ-KEPT-OWNER#g"; else cat; fi; }

# One line per history line: <sha>\t<file>\t<text>. Headers (identities, messages) get the file "(commit)".
git -C "$repo" log --all -p --format='@@DZ %H%n%an <%ae>%n%cn <%ce>%n%B' \
  | awk -v OFS='\t' '
      /^@@DZ / { sha = substr($2, 1, 12); file = "(commit)"; next }
      /^diff --git / { file = $4; sub(/^b\//, "", file); next }
      /^(\+\+\+|---) / { next }
      { print sha, file, $0 }' | blank > "$tmp/lines.tsv"
# The same for the files at HEAD: HEAD\t<file>\t<text>.
git -C "$repo" grep -I -n -e '' HEAD 2> /dev/null \
  | awk -v OFS='\t' '{ sub(/^HEAD:/, ""); i = index($0, ":"); f = substr($0, 1, i - 1); r = substr($0, i + 1)
                       sub(/^[0-9]+:/, "", r); print "HEAD", f, r }' | blank > "$tmp/head.tsv"

fail=0
# Made-up ids that tests use on purpose (scripts/history/fake-ids.txt): allowed, like scripts/history/verify.sh does.
fakes="$(grep -vE '^#|^$' "$repo/scripts/history/fake-ids.txt" 2> /dev/null | paste -sd '|' || true)"
fakes="${fakes:-111122223333|i-0123456789abcdef0}"
# hits <tsv> <mode> <pattern> <exclude>: "<sha>\t<file>\t<masked match>" per match.
hits() {
  { cut -f3- "$1" | grep -n $2 -o -- "$3" 2> /dev/null || true; } | { if [ -n "$4" ]; then grep -vE -- "$4" || true; else cat; fi; } \
    | awk -F'\t' '
      NR == FNR { i = index($0, ":"); ln = substr($0, 1, i - 1); m = substr($0, i + 1)
                  masked[ln] = masked[ln] SUBSEP substr(m, 1, 2) ".." "(" length(m) ")"; next }
      FNR in masked { n = split(substr(masked[FNR], 2), ms, SUBSEP); for (j = 1; j <= n; j++) print $1 "\t" $2 "\t" ms[j] }
    ' - "$1"
}
# scan <label> <grep-mode -E|-P|-F> <pattern> [exclude-regex]: all history, then the files at HEAD.
scan() {
  local label="$1" mode="$2" pat="$3" exclude="${4:-}"
  hits "$tmp/lines.tsv" "$mode" "$pat" "$exclude" > "$tmp/hits"
  hits "$tmp/head.tsv" "$mode" "$pat" "$exclude" > "$tmp/head"
  local n h
  n="$(wc -l < "$tmp/hits")"
  h="$(wc -l < "$tmp/head")"
  if [ "$n" = "0" ] && [ "$h" = "0" ]; then echo "ok    $label"; echo "ok    $label" >> "$report"; return; fi
  fail=1
  echo "HIT   $label: $n match(es) in history, $h at HEAD"
  {
    echo "HIT   $label: $n match(es) in history, $h at HEAD (commit, file, masked match, count)"
    sort "$tmp/hits" "$tmp/head" | uniq -c | awk '{ c = $1; $1 = ""; sub(/^ /, ""); print "      " $0 "\t" c }'
  } >> "$report"
}

scan "12-digit numbers (account ids) except the documented fakes" -E '\b[0-9]{12}\b' ":($fakes)\$"
scan "personal names and e-mail" -iE 'maintainer|[A-Za-z0-9._%+-]*@(gmail|outlook)\.com'
scan "resource ids i-/vol-/snap- except the documented fakes" -E '\b(i|vol|snap)-[0-9a-f]{17}\b' ":($fakes)\$"

# expressions <label> <file>: every filter-repo expression in the file must be gone (scrub.sh rewrites them all).
expressions() {
  local k=0 line pat
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    k=$((k + 1))
    case "$line" in
      regex:*) pat="${line#regex:}"; scan "$1 expression #$k (regex)" -P "${pat%%==>*}" ;;
      *) scan "$1 expression #$k (literal)" -F "${line%%==>*}" ;;
    esac
  done < "$2"
}
[ -f "$repo/scripts/history/scrub-expressions.txt" ] && expressions public "$repo/scripts/history/scrub-expressions.txt"
[ -n "$private" ] && expressions private "$private"

if [ -d "$repo/legacy" ]; then echo "HIT   legacy/ still exists"; echo "HIT   legacy/ exists at HEAD" >> "$report"; fail=1
else echo "ok    legacy/ removed"; fi

if command -v gitleaks > /dev/null; then
  if gitleaks git --log-opts="--all" --redact --no-banner --exit-code 1 --report-path "$tmp/gitleaks.json" "$repo" > "$tmp/gitleaks.txt" 2>&1; then
    echo "ok    gitleaks (all history)"; echo "ok    gitleaks" >> "$report"
  else
    fail=1; echo "HIT   gitleaks: $(tail -1 "$tmp/gitleaks.txt")"
    { echo "HIT   gitleaks (rule, commit, file):"
      node -e 'for (const f of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")))
        console.log(`      ${f.RuleID}\t${f.Commit.slice(0, 12)}\t${f.File}:${f.StartLine}`)' "$tmp/gitleaks.json"
    } >> "$report"
  fi
else fail=1; echo "HIT   gitleaks is not installed"; fi

if command -v trufflehog > /dev/null; then
  if trufflehog git "file://$repo" --only-verified --fail --no-update --json > "$tmp/th.json" 2> "$tmp/th.err"; then
    echo "ok    trufflehog (verified, all history)"; echo "ok    trufflehog" >> "$report"
  else
    fail=1; echo "HIT   trufflehog: $(grep -c . "$tmp/th.json" || true) verified finding(s)"
    { echo "HIT   trufflehog (detector, commit, file):"
      node -e 'for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) {
        const f = JSON.parse(l), g = f.SourceMetadata?.Data?.Git ?? {};
        console.log(`      ${f.DetectorName}\t${String(g.commit ?? "").slice(0, 12)}\t${g.file ?? ""}`) }' "$tmp/th.json"
      tail -3 "$tmp/th.err" | sed 's/^/      /'
    } >> "$report"
  fi
else fail=1; echo "HIT   trufflehog is not installed"; fi

if node "$repo/scripts/check-words.ts" > "$tmp/words.txt" 2>&1; then echo "ok    check:words"
else fail=1; echo "HIT   check:words"; sed 's/^/      /' "$tmp/words.txt" >> "$report"; fi

echo "report: $report"
[ "$fail" -eq 0 ] && echo "scrub-check: clean" || echo "scrub-check: hits"
exit "$fail"
