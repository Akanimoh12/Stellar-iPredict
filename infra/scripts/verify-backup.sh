#!/usr/bin/env bash
#
# iPredict — automated backup restore verification.
#
# An untested backup is a hypothesis. This script proves the latest dump can
# actually be restored: it stands up a throwaway Postgres, restores into it,
# and checks the result is a complete, current database — then tears it down.
#
#   infra/scripts/verify-backup.sh                     # newest dump in infra/backups
#   infra/scripts/verify-backup.sh path/to/some.dump   # a specific dump
#   BACKUP_ALERT_WEBHOOK_URL=... infra/scripts/verify-backup.sh   # alert on failure
#
# Exit status is 0 only if every check passed. Any failure also POSTs to
# $BACKUP_ALERT_WEBHOOK_URL (or $ALERT_WEBHOOK_URL) if one is set.
#
# What it measures (written to the summary line and, if set, $VERIFY_METRICS_FILE
# in Prometheus textfile format):
#   - restore_seconds   — wall-clock to restore. The dominant term in RTO.
#   - dump_age_seconds   — how old the dump is. Bounds RPO (data since the dump
#                          is only recoverable by replaying chain events).
#
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly INFRA_DIR="$(dirname -- "$SCRIPT_DIR")"
readonly REPO_DIR="$(dirname -- "$INFRA_DIR")"
readonly MIGRATIONS_DIR="$REPO_DIR/db/migrations"

BACKUP_DIR="${BACKUP_DIR:-$INFRA_DIR/backups}"
PG_IMAGE="${VERIFY_PG_IMAGE:-postgres:16.4-alpine}"
SCRATCH_DB="${VERIFY_SCRATCH_DB:-ipredict_verify}"
SCRATCH_USER="verify"
SCRATCH_PASS="verify"
ALERT_URL="${BACKUP_ALERT_WEBHOOK_URL:-${ALERT_WEBHOOK_URL:-}}"
METRICS_FILE="${VERIFY_METRICS_FILE:-}"
# Tables that must exist in a restored database. Emptiness is reported, not
# failed — a fresh deployment legitimately has no bets yet.
REQUIRED_TABLES="${VERIFY_REQUIRED_TABLES:-markets bets events oracle_submissions leaderboard council_votes schema_migrations}"

DUMP="${1:-}"

log()  { printf '[verify-backup] %s\n' "$*" >&2; }
die()  { fail "$*"; exit 1; }

CONTAINER=""
cleanup() {
  [[ -n "$CONTAINER" ]] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

alert() {
  local reason="$1"
  [[ -n "$ALERT_URL" ]] || return 0
  local payload
  payload=$(printf '{"type":"backup.verification_failed","severity":"SEV2","dump":"%s","reason":"%s","host":"%s"}' \
    "${DUMP:-unknown}" "$(printf '%s' "$reason" | sed 's/"/\\"/g')" "$(hostname)")
  curl -fsS -m 10 -X POST -H 'content-type: application/json' -d "$payload" "$ALERT_URL" >/dev/null 2>&1 \
    && log "alert posted" || log "warning: failed to POST alert to \$BACKUP_ALERT_WEBHOOK_URL"
}

fail() {
  printf '[verify-backup] FAIL: %s\n' "$*" >&2
  alert "$*"
}

command -v docker >/dev/null 2>&1 || die "docker is required"

# ── Pick the dump ───────────────────────────────────────────────────────────
if [[ -z "$DUMP" ]]; then
  DUMP="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'ipredict-*.dump' 2>/dev/null | sort | tail -1 || true)"
  [[ -n "$DUMP" ]] || die "no dump found in $BACKUP_DIR (pass one explicitly)"
fi
[[ -f "$DUMP" ]] || die "no such dump: $DUMP"
log "verifying $DUMP"

now_epoch="$(date -u +%s)"
dump_epoch="$(date -u -r "$DUMP" +%s 2>/dev/null || stat -c %Y "$DUMP")"
dump_age_seconds=$(( now_epoch - dump_epoch ))
log "dump age: $(( dump_age_seconds / 3600 ))h $(( (dump_age_seconds % 3600) / 60 ))m"

# ── Scratch Postgres ───────────────────────────────────────────────────────
CONTAINER="ipredict-verify-$$"
log "starting scratch postgres ($PG_IMAGE) as $CONTAINER"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER="$SCRATCH_USER" \
  -e POSTGRES_PASSWORD="$SCRATCH_PASS" \
  -e POSTGRES_DB="$SCRATCH_DB" \
  "$PG_IMAGE" >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U "$SCRATCH_USER" -d "$SCRATCH_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$CONTAINER" pg_isready -U "$SCRATCH_USER" -d "$SCRATCH_DB" >/dev/null 2>&1 \
  || die "scratch postgres did not become ready"

psql_scratch() { docker exec -e PGPASSWORD="$SCRATCH_PASS" "$CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U "$SCRATCH_USER" -d "$SCRATCH_DB" "$@"; }

# ── Integrity of the dump file itself ──────────────────────────────────────
# Same check restore.sh does before a production restore: prove the file has
# not rotted or been truncated in transit.
if [[ -f "$DUMP.sha256" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$(dirname "$DUMP")" && sha256sum --quiet --check "$(basename "$DUMP").sha256" ) \
      || die "checksum mismatch for $DUMP"
  elif command -v shasum >/dev/null 2>&1; then
    ( cd "$(dirname "$DUMP")" && shasum -a 256 --check --status "$(basename "$DUMP").sha256" ) \
      || die "checksum mismatch for $DUMP"
  fi
  log "checksum ok"
else
  log "warning: no $DUMP.sha256 sidecar; skipping checksum check"
fi

# ── Restore (timed) ────────────────────────────────────────────────────────
# pg_restore runs inside the scratch container so this does not depend on the
# host having Postgres client tools. --exit-on-error so a partial restore
# fails loudly instead of looking like it worked.
restore_start="$(date -u +%s)"
if ! docker exec -i -e PGPASSWORD="$SCRATCH_PASS" "$CONTAINER" \
  pg_restore --username="$SCRATCH_USER" --dbname="$SCRATCH_DB" \
    --clean --if-exists --no-owner --no-privileges --exit-on-error --jobs=4 \
  < "$DUMP"; then
  die "pg_restore failed"
fi
restore_seconds=$(( $(date -u +%s) - restore_start ))
log "restore completed in ${restore_seconds}s"

# ── Checks ─────────────────────────────────────────────────────────────────
errors=0
check() {
  local desc="$1"; shift
  if "$@"; then
    log "ok   — $desc"
  else
    fail "$desc"
    errors=$(( errors + 1 ))
  fi
}

table_exists()   { psql_scratch -tAc "SELECT to_regclass('public.$1') IS NOT NULL" | grep -qx t; }
row_count()      { psql_scratch -tAc "SELECT count(*) FROM $1"; }

for t in $REQUIRED_TABLES; do
  check "table '$t' present" table_exists "$t"
done

# Schema currency: the dump's schema_migrations must match the repo's
# up-migrations. A shortfall means the backup predates a schema change and a
# restore would need migrations re-applied (and may not round-trip cleanly).
repo_migrations="$(find "$MIGRATIONS_DIR" -maxdepth 1 -name '[0-9]*.sql' ! -name '*.down.sql' | wc -l | tr -d ' ')"
dump_migrations="$(row_count schema_migrations 2>/dev/null || echo 0)"
log "migrations: repo=$repo_migrations dump=$dump_migrations"
check "backup schema is current (dump migrations >= repo migrations)" \
  test "$dump_migrations" -ge "$repo_migrations"

# Referential sanity — a restore that dropped rows mid-way would show here.
orphan_bets="$(psql_scratch -tAc "SELECT count(*) FROM bets b LEFT JOIN markets m ON m.id = b.market_id WHERE m.id IS NULL" 2>/dev/null || echo ERR)"
check "no orphan bets (found: $orphan_bets)" test "$orphan_bets" = "0"

log "row counts:"
for t in markets bets events oracle_submissions leaderboard; do
  table_exists "$t" && log "  $t: $(row_count "$t")"
done

# ── Report ─────────────────────────────────────────────────────────────────
if [[ -n "$METRICS_FILE" ]]; then
  {
    echo "# HELP ipredict_backup_verify_success Last backup verification result (1 ok, 0 fail)"
    echo "# TYPE ipredict_backup_verify_success gauge"
    echo "ipredict_backup_verify_success $([[ $errors -eq 0 ]] && echo 1 || echo 0)"
    echo "ipredict_backup_verify_restore_seconds $restore_seconds"
    echo "ipredict_backup_verify_dump_age_seconds $dump_age_seconds"
    echo "ipredict_backup_verify_timestamp_seconds $now_epoch"
  } > "$METRICS_FILE.tmp" && mv "$METRICS_FILE.tmp" "$METRICS_FILE"
fi

if [[ $errors -eq 0 ]]; then
  log "PASS — dump=$DUMP restore_seconds=$restore_seconds dump_age_seconds=$dump_age_seconds"
  exit 0
fi
log "FAILED $errors check(s) — dump=$DUMP"
exit 1
