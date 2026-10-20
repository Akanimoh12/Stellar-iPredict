#!/usr/bin/env bash
# =============================================================================
# iPredict — Migration Prefix Check
# =============================================================================
# Scans db/migrations/ for SQL files and fails if any two files share a new
# numeric prefix. Exact historical collisions are allowed because applied
# migrations are immutable and their filenames are recorded in deployments.
#
# Usage:
#   ./scripts/check-migration-prefixes.sh
#
# Exit code:
#   0 — all prefixes are unique or match the frozen historical groups
#   1 — malformed filename or unexpected duplicate prefix(es)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$ROOT/db/migrations"

declare -A PREFIX_FILES=()
while IFS= read -r FILE; do
  [[ "$FILE" == *.down.sql ]] && continue
  if [[ ! "$FILE" =~ ^([0-9]{4})_[a-z0-9]+([_a-z0-9]*)\.sql$ ]]; then
    echo "ERROR: Invalid migration filename: $FILE"
    exit 1
  fi
  PREFIX="${BASH_REMATCH[1]}"
  PREFIX_FILES["$PREFIX"]+="${FILE}"$'\n'
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort)

is_frozen_legacy_group() {
  local PREFIX="$1"
  local FILES
  FILES="$(printf '%s' "${PREFIX_FILES[$PREFIX]}" | sed '/^$/d' | paste -sd ' ' -)"

  case "$PREFIX:$FILES" in
    "0011:0011_create_token_balances.sql 0011_extend_oracle_submissions.sql" | \
    "0013:0013_events_archival.sql 0013_stats_indexes.sql" | \
    "0014:0014_markets_active_partial_index.sql 0014_oracle_dispute_bond_constraints.sql 0014_oracle_providers.sql" | \
    "0015:0015_idempotency_keys.sql 0015_oracle_disputes_total_bond_generated.sql 0015_oracle_updated_at.sql" | \
    "0022:0022_oracle_resolution_lag.sql 0022_oracle_submissions_request_id.sql" | \
    "0028:0028_adapter_raw_payloads.sql 0028_markets_sort_indexes.sql" | \
    "0029:0029_dead_letter_retry_cap.sql 0029_markets_sort_indexes.sql")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

UNEXPECTED_DUPLICATES=()
for PREFIX in "${!PREFIX_FILES[@]}"; do
  FILES="${PREFIX_FILES[$PREFIX]}"
  COUNT="$(printf '%s' "$FILES" | grep -c . || true)"
  if (( COUNT > 1 )) && ! is_frozen_legacy_group "$PREFIX"; then
    UNEXPECTED_DUPLICATES+=("$PREFIX:$FILES")
  fi
done

if (( ${#UNEXPECTED_DUPLICATES[@]} > 0 )); then
  echo "ERROR: Unexpected duplicate migration prefix(es) found in $MIGRATIONS_DIR"
  echo ""
  for GROUP in "${UNEXPECTED_DUPLICATES[@]}"; do
    PREFIX="${GROUP%%:*}"
    echo "  Prefix: $PREFIX"
    while IFS= read -r FILE; do
      [[ -n "$FILE" ]] && echo "    - $FILE"
    done <<< "${GROUP#*:}"
  done
  echo ""
  echo "Each new migration must have a unique numeric prefix. Do not rename"
  echo "frozen applied migrations; use the next unused prefix instead."
  exit 1
fi

echo "OK — No unexpected migration prefix collisions."
exit 0