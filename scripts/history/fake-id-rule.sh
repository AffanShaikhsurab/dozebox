#!/usr/bin/env bash
# Print the filter-repo expressions that rewrite every account number and resource id except the listed fakes.
#   scripts/history/fake-id-rule.sh scripts/history/fake-ids.txt
set -euo pipefail
list="${1:?fake ids file}"
accounts="$(grep -E '^[0-9]{12}$' "$list" | paste -sd '|')"
ids="$(grep -E '^(i|vol|snap)-[0-9a-f]{17}$' "$list" | paste -sd '|')"
printf 'regex:\\b(?!(?:%s)\\b)\\d{12}\\b==>111122223333\n' "$accounts"
printf 'regex:\\b(?!(?:%s)\\b)(i|vol|snap)-[0-9a-f]{17}\\b==>\\1-0123456789abcdef0\n' "$ids"
