#!/usr/bin/env bash
#
# iPredict — automated backup restore verification.
#
# An untested backup is a hypothesis. This script proves the latest dump can
# actually be restored: it stands up a throwaway Postgres, restores into it,
# and checks the result is a complete, current database — then tears it down.
# Supports both unencrypted (.dump) and encrypted (.dump.enc) archives.
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
#   - dump_age_seconds  — how old the dump is. Bounds RPO (data since the dump
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
ALERT_FORMAT="${BACKUP_ALERT_WEBHOOK_FORMAT:-${ALERT_WEBHOOK_FORMAT:-auto}}"
METRICS_FILE="${VERIFY_METRICS_FILE:-}"
ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-${BACKUP_PASSPHRASE:-}}"
ENCRYPTION_KEY_FILE="${BACKUP_PASSPHRASE_FILE:-${BACKUP_ENCRYPTION_KEY_FILE:-}}"

# Tables that must exist in a restored database. Emptiness is reported, not
# failed — a fresh deployment legitimately has no bets yet.
REQUIRED_TABLES="${VERIFY_REQUIRED_TABLES:-markets bets events oracle_submissions leaderboard council_votes schema_migrations}"

DUMP=""

log()  { printf '[verify-backup] %s\n' "$*" >&2; }
die()  { fail "$*"; exit 1; }

usage() {
  cat <<'USAGE'
Usage: verify-backup.sh [options] [dump-file]

Options:
  -d, --dump FILE           Path to a specific .dump or .dump.enc archive
  -b, --backup-dir DIR      Directory to search for newest dump (default: infra/backups)
  -k, --key KEY             Passphrase for decrypting .enc archives
      --key-file FILE       File containing decryption passphrase
  -h, --help                Show this help

Environment:
  BACKUP_DIR, BACKUP_ALERT_WEBHOOK_URL, BACKUP_ALERT_WEBHOOK_FORMAT
  BACKUP_ENCRYPTION_KEY, BACKUP_PASSPHRASE_FILE
  VERIFY_PG_IMAGE, VERIFY_SCRATCH_DB, VERIFY_METRICS_FILE
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--dump)             DUMP="${2:?--dump needs a file}"; shift 2 ;;
    -b|--backup-dir)       BACKUP_DIR="${2:?--backup-dir needs a directory}"; shift 2 ;;
    -k|--key|--passphrase) ENCRYPTION_KEY="${2:?--key needs a passphrase}"; shift 2 ;;
    --key-file|--passphrase-file)
                           ENCRYPTION_KEY_FILE="${2:?--key-file needs a file path}"; shift 2 ;;
    -h|--help)             usage; exit 0 ;;
    -*)                    usage >&2; die "unknown option: $1" ;;
    *)                     [[ -z "$DUMP" ]] || die "only one dump file may be given"; DUMP="$1"; shift ;;
  esac
done

CONTAINER=""
DECRYPTED_TEMP=""

cleanup() {
  [[ -n "$CONTAINER" ]] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [[ -n "$DECRYPTED_TEMP" && -f "$DECRYPTED_TEMP" ]] && rm -f -- "$DECRYPTED_TEMP" >/dev/null 2>&1 || true
}
trap cleanup EXIT

alert() {
  local reason="$1"
  [[ -n "$ALERT_URL" ]] || return 0
  local host="$(hostname)"
  local dump_name="${DUMP:-unknown}"
  local clean_reason="$(printf '%s' "$reason" | sed 's/"/\\"/g')"

  if [[ "$ALERT_FORMAT" == "slack" || "$ALERT_URL" == *"hooks.slack.com"* ]]; then
    curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"🚨 *Backup Verification Failed* on \`${host}\`\n• *Dump*: \`${dump_name}\`\n• *Reason*: ${clean_reason}\"}" \
      "$ALERT_URL" >/dev/null 2>&1 && log "alert posted to Slack" || log "warning: failed to post Slack alert"
  elif [[ "$ALERT_FORMAT" == "discord" || "$ALERT_URL" == *"discord.com/api/webhooks"* ]]; then
    curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
      -d "{\"content\":\"🚨 **Backup Verification Failed** on \`${host}\`\n• **Dump**: \`${dump_name}\`\n• **Reason**: ${clean_reason}\"}" \
      "$ALERT_URL" >/dev/null 2>&1 && log "alert posted to Discord" || log "warning: failed to post Discord alert"
  else
    local payload
    payload=$(printf '{"type":"backup.verification_failed","severity":"SEV2","dump":"%s","reason":"%s","host":"%s"}' \
      "$dump_name" "$clean_reason" "$host")
    curl -fsS -m 10 -X POST -H 'content-type: application/json' -d "$payload" "$ALERT_URL" >/dev/null 2>&1 \
      && log "alert posted" || log "warning: failed to POST alert to \$BACKUP_ALERT_WEBHOOK_URL"
  fi
}

fail() {
  printf '[verify-backup] FAIL: %s\n' "$*" >&2
  alert "$*"
}

command -v docker >/dev/null 2>&1 || die "docker is required"

# ── Pick the dump ───────────────────────────────────────────────────────────
if [[ -z "$DUMP" ]]; then
  DUMP="$(find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'ipredict-*.dump' -o -name 'ipredict-*.dump.enc' \) 2>/dev/null | sort | tail -1 || true)"
  [[ -n "$DUMP" ]] || die "no dump found in $BACKUP_DIR (pass one explicitly)"
fi
[[ -f "$DUMP" ]] || die "no such dump: $DUMP"
log "verifying $DUMP"

now_epoch="$(date -u +%s)"
dump_epoch="$(date -u -r "$DUMP" +%s 2>/dev/null || stat -c %Y "$DUMP")"
dump_age_seconds=$(( now_epoch - dump_epoch ))
log "dump age: $(( dump_age_seconds / 3600 ))h $(( (dump_age_seconds % 3600) / 60 ))m"

# ── Integrity of the dump file itself ──────────────────────────────────────
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

# ── Decrypt if encrypted ───────────────────────────────────────────────────
RESTORE_SOURCE="$DUMP"
if [[ "$DUMP" == *.enc ]]; then
  command -v openssl >/dev/null 2>&1 || die "openssl is required to decrypt $DUMP"
  if [[ -z "$ENCRYPTION_KEY" && -z "$ENCRYPTION_KEY_FILE" ]]; then
    die "dump is encrypted (.enc) but no passphrase provided (set \$BACKUP_ENCRYPTION_KEY or --key)"
  fi
  DECRYPTED_TEMP="$(mktemp "${TMPDIR:-/tmp}/ipredict-verify-XXXXXX.dump")"
  chmod 600 "$DECRYPTED_TEMP"
  log "decrypting $DUMP for verification..."
  if [[ -n "$ENCRYPTION_KEY_FILE" ]]; then
    openssl enc -d -aes-256-cbc -salt -pbkdf2 -iter 100000 \
      -in "$DUMP" -out "$DECRYPTED_TEMP" \
      -pass "file:$ENCRYPTION_KEY_FILE"
  else
    openssl enc -d -aes-256-cbc -salt -pbkdf2 -iter 100000 \
      -in "$DUMP" -out "$DECRYPTED_TEMP" \
      -pass "pass:$ENCRYPTION_KEY"
  fi
  [[ -s "$DECRYPTED_TEMP" ]] || die "decryption failed or produced empty file"
  RESTORE_SOURCE="$DECRYPTED_TEMP"
fi

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

# ── Restore (timed) ────────────────────────────────────────────────────────
restore_start="$(date -u +%s)"
if ! docker exec -i -e PGPASSWORD="$SCRATCH_PASS" "$CONTAINER" \
  pg_restore --username="$SCRATCH_USER" --dbname="$SCRATCH_DB" \
    --clean --if-exists --no-owner --no-privileges --exit-on-error --jobs=4 \
  < "$RESTORE_SOURCE"; then
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

# Schema currency: the dump's schema_migrations must match the repo's up-migrations
repo_migrations="$(find "$MIGRATIONS_DIR" -maxdepth 1 -name '[0-9]*.sql' ! -name '*.down.sql' | wc -l | tr -d ' ')"
dump_migrations="$(row_count schema_migrations 2>/dev/null || echo 0)"
log "migrations: repo=$repo_migrations dump=$dump_migrations"
check "backup schema is current (dump migrations >= repo migrations)" \
  test "$dump_migrations" -ge "$repo_migrations"

# Referential sanity
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
