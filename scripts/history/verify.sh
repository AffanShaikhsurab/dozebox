#!/usr/bin/env bash
# Check a rewritten history (part 12 M1b). Exit 1 on any finding.
#   scripts/history/verify.sh <repo> [private-expressions-file]
set -euo pipefail
repo="${1:?repo}"
private="${2:-}"
here="$(cd "$(dirname "$0")" && pwd)"
fakes="$here/fake-ids.txt"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
git -C "$repo" log --all -p --format='%H%n%an <%ae>%n%cn <%ce>%n%B' > "$log"
fail=0

gitleaks git --log-opts="--all" --redact --no-banner --exit-code 1 --config "$here/../../.gitleaks.toml" "$repo" \
  || { echo "verify: gitleaks found leaks"; fail=1; }

known() { grep -vxFf <(grep -vE '^#|^$' "$fakes") || true; }
accounts="$(grep -oE '\b[0-9]{12}\b' "$log" | sort -u | known)"
if [ -n "$accounts" ]; then echo "verify: 12-digit numbers left: $(echo "$accounts" | wc -l)"; fail=1; fi
ids="$(grep -oE '\b(i|vol|snap)-[0-9a-f]{17}\b' "$log" | sort -u | known)"
if [ -n "$ids" ]; then echo "verify: resource ids left: $(echo "$ids" | wc -l)"; fail=1; fi
if grep -qiE '[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|icloud|proton)\.(com|me)' "$log"; then
  echo "verify: personal e-mail addresses left"; fail=1
fi
people="$(git -C "$repo" log --all --format='%an <%ae>%n%cn <%ce>' | sort -u \
  | grep -vxE 'Maintainer <maintainer@users\.noreply\.github\.com>|GitHub <noreply@github\.com>|Kiro Agent <[0-9]+\+kiro-agent@users\.noreply\.github\.com>' || true)"
if [ -n "$people" ]; then echo "verify: unmapped identities: $(echo "$people" | wc -l)"; fail=1; fi

if [ -n "$private" ]; then
  while IFS= read -r line; do
    case "$line" in
      '' | '#'*) continue ;;
      regex:*) pat="${line#regex:}"; pat="${pat%%==>*}"; n="$(grep -cP -- "$pat" "$log" || true)" ;;
      *) pat="${line%%==>*}"; n="$(grep -cF -- "$pat" "$log" || true)" ;;
    esac
    if [ "$n" != "0" ]; then echo "verify: a private expression still matches $n line(s)"; fail=1; fi
  done < "$private"
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "verify: clean"
