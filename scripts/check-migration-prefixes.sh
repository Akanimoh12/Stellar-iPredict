#!/usr/bin/env bash
# =============================================================================
# iPredict — Migration Prefix Check
# =============================================================================
# Scans db/migrations/ for SQL files and fails if any two files share the same
# numeric prefix (the NNNN at the start of the filename).
#
# Usage:
#   ./scripts/check-migration-prefixes.sh
#
# Exit code:
#   0 — all prefixes are unique
#   1 — duplicate prefix(es) found
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$ROOT/db/migrations"

DUPLICATES=$(
  cd "$MIGRATIONS_DIR" || exit 1
  # Extract the numeric prefix (e.g. "0008" from "0008_council_votes.sql")
  # Only consider .sql files that are NOT .down.sql
  ls *.sql 2>/dev/null \
    | grep -v '\.down\.sql$' \
    | sed -E 's/^([0-9]+)_.*$/\1/' \
    | sort \
    | uniq -d
)

if [[ -n "$DUPLICATES" ]]; then
  echo "ERROR: Duplicate migration prefix(es) found in $MIGRATIONS_DIR"
  echo ""
  for PREFIX in $DUPLICATES; do
    echo "  Prefix: $PREFIX"
    # Show which files share this prefix
    ls "$MIGRATIONS_DIR" \
      | grep -v '\.down\.sql$' \
      | grep "^${PREFIX}_" \
      | while IFS= read -r line; do echo "    - $line"; done
  done
  echo ""
  echo "Each migration must have a unique, monotonically increasing numeric"
  echo "prefix (e.g., 0001, 0002, ...). Renumber the colliding file(s) to an"
  echo "unused number that preserves the intended apply order."
  exit 1
fi

echo "OK — All migration prefixes are unique."
exit 0