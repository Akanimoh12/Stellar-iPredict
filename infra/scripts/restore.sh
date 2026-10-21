#!/usr/bin/env bash
#
# iPredict — PostgreSQL restore.
#
# Loads a dump produced by backup.sh back into a database. This DROPS AND
# REPLACES every object the dump contains, so it refuses to run without an
# explicit confirmation. Supports both plain and AES-256 encrypted dumps (.dump.enc).
#
#   infra/scripts/restore.sh infra/backups/ipredict-20260101T000000Z.dump
#   infra/scripts/restore.sh infra/backups/ipredict-20260101T000000Z.dump.enc
#   infra/scripts/restore.sh --list <dump>            # inspect, change nothing
#   infra/scripts/restore.sh --yes -d "$STAGING_URL" <dump>
#
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly INFRA_DIR="$(dirname -- "$SCRIPT_DIR")"
readonly COMPOSE_FILE="${COMPOSE_FILE:-$INFRA_DIR/docker-compose.production.yml}"

DATABASE_URL="${DATABASE_URL:-}"
ASSUME_YES="no"
LIST_ONLY="no"
USE_DOCKER="auto"
JOBS="${RESTORE_JOBS:-4}"
DUMP=""

DECRYPT="auto"
ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-${BACKUP_PASSPHRASE:-}}"
ENCRYPTION_KEY_FILE="${BACKUP_PASSPHRASE_FILE:-${BACKUP_ENCRYPTION_KEY_FILE:-}}"

log() { printf '[restore] %s\n' "$*" >&2; }
die() { printf '[restore] error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: restore.sh [options] <dump-file>

Options:
  -d, --database URL        Target Postgres connection string (default: $DATABASE_URL)
  -j, --jobs N              Parallel restore workers (default: 4, or $RESTORE_JOBS)
  -l, --list                Print the archive's contents and exit. Changes nothing.
  -y, --yes                 Skip the interactive confirmation (for automation)
      --docker              Run pg_restore inside the compose postgres service
      --local               Run the pg_restore binary on this machine

Decryption options:
  -e, --decrypt             Explicitly decrypt an AES-256 encrypted archive
      --encryption-key KEY  Passphrase for AES-256 decryption
                            (default: $BACKUP_ENCRYPTION_KEY or $BACKUP_PASSPHRASE)
      --key-file FILE       File containing passphrase for AES-256 decryption
                            (default: $BACKUP_PASSPHRASE_FILE)

  -h, --help                Show this help

The restore is destructive: objects in the dump are dropped and recreated in
the target database. Point -d at the database you mean to overwrite.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--database)         DATABASE_URL="${2:?--database needs a URL}"; shift 2 ;;
    -j|--jobs)             JOBS="${2:?--jobs needs a number}"; shift 2 ;;
    -l|--list)             LIST_ONLY="yes"; shift ;;
    -y|--yes)              ASSUME_YES="yes"; shift ;;
    --docker)              USE_DOCKER="yes"; shift ;;
    --local)               USE_DOCKER="no"; shift ;;
    -e|--decrypt)          DECRYPT="yes"; shift ;;
    --encryption-key|--passphrase)
                           ENCRYPTION_KEY="${2:?--encryption-key needs a passphrase}"; shift 2 ;;
    --key-file|--passphrase-file)
                           ENCRYPTION_KEY_FILE="${2:?--key-file needs a file path}"; shift 2 ;;
    -h|--help)             usage; exit 0 ;;
    -*)                    usage >&2; die "unknown option: $1" ;;
    *)                     [[ -z "$DUMP" ]] || die "only one dump file may be given"; DUMP="$1"; shift ;;
  esac
done

[[ -n "$DUMP" ]] || { usage >&2; die "no dump file given"; }
[[ -f "$DUMP" ]] || die "no such file: $DUMP"
[[ "$JOBS" =~ ^[0-9]+$ && "$JOBS" -gt 0 ]] || die "jobs must be a positive integer, got '$JOBS'"

# ── Integrity ────────────────────────────────────────────────────────────────
# Verify the sidecar before touching the target. Restoring a corrupt dump over
# a live database is strictly worse than not restoring at all.
verify_checksum() {
  local sidecar="$DUMP.sha256"
  if [[ ! -f "$sidecar" ]]; then
    log "warning: no $sidecar alongside the dump; skipping checksum verification"
    return 0
  fi
  local dir base
  dir="$(cd -- "$(dirname -- "$DUMP")" && pwd)"
  base="$(basename -- "$DUMP")"
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$dir" && sha256sum --quiet --check "$base.sha256" ) || die "checksum mismatch for $DUMP"
  elif command -v shasum >/dev/null 2>&1; then
    ( cd "$dir" && shasum -a 256 --check --status "$base.sha256" ) || die "checksum mismatch for $DUMP"
  else
    log "warning: no sha256 tool found; skipping checksum verification"
    return 0
  fi
  log "checksum ok"
}

verify_checksum

# ── Decryption (if encrypted) ────────────────────────────────────────────────
DECRYPTED_TEMP=""
cleanup_temp() {
  if [[ -n "$DECRYPTED_TEMP" && -f "$DECRYPTED_TEMP" ]]; then
    rm -f -- "$DECRYPTED_TEMP" 2>/dev/null || true
  fi
}
trap cleanup_temp EXIT

RESTORE_INPUT="$DUMP"

if [[ "$DUMP" == *.enc || "$DECRYPT" == "yes" ]]; then
  command -v openssl >/dev/null 2>&1 || die "openssl is required to decrypt $DUMP"
  if [[ -z "$ENCRYPTION_KEY" && -z "$ENCRYPTION_KEY_FILE" ]]; then
    if [[ -t 0 ]]; then
      read -s -r -p "[restore] Enter decryption passphrase: " ENCRYPTION_KEY
      echo "" >&2
    else
      die "dump is encrypted but no passphrase was provided (use --encryption-key or \$BACKUP_ENCRYPTION_KEY)"
    fi
  fi
  if [[ -n "$ENCRYPTION_KEY_FILE" && ! -f "$ENCRYPTION_KEY_FILE" ]]; then
    die "encryption key file not found: $ENCRYPTION_KEY_FILE"
  fi

  DECRYPTED_TEMP="$(mktemp "${TMPDIR:-/tmp}/ipredict-restore-XXXXXX.dump")"
  chmod 600 "$DECRYPTED_TEMP"

  log "decrypting $DUMP..."
  if [[ -n "$ENCRYPTION_KEY_FILE" ]]; then
    openssl enc -d -aes-256-cbc -salt -pbkdf2 -iter 100000 \
      -in "$DUMP" -out "$DECRYPTED_TEMP" \
      -pass "file:$ENCRYPTION_KEY_FILE"
  else
    openssl enc -d -aes-256-cbc -salt -pbkdf2 -iter 100000 \
      -in "$DUMP" -out "$DECRYPTED_TEMP" \
      -pass "pass:$ENCRYPTION_KEY"
  fi
  [[ -s "$DECRYPTED_TEMP" ]] || die "decryption produced an empty file"
  log "decryption successful"
  RESTORE_INPUT="$DECRYPTED_TEMP"
fi

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" "$@"
  else
    docker-compose -f "$COMPOSE_FILE" "$@"
  fi
}

if [[ "$USE_DOCKER" == "auto" ]]; then
  if [[ -n "$DATABASE_URL" ]] && command -v pg_restore >/dev/null 2>&1; then
    USE_DOCKER="no"
  else
    USE_DOCKER="yes"
  fi
fi

if [[ "$LIST_ONLY" == "yes" ]]; then
  if [[ "$USE_DOCKER" == "no" ]]; then
    pg_restore --list "$RESTORE_INPUT"
  else
    compose exec -T postgres sh -c \
      'cat > /tmp/list.dump && pg_restore --list /tmp/list.dump; rc=$?; rm -f /tmp/list.dump; exit $rc' \
      < "$RESTORE_INPUT"
  fi
  exit 0
fi

# ── Confirm ──────────────────────────────────────────────────────────────────
redact() { printf '%s' "$1" | sed -E 's#(://[^:/@]+):[^@]*@#\1:****@#'; }

if [[ "$USE_DOCKER" == "no" ]]; then
  [[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is not set (see infra/.env.example)"
  target="$(redact "$DATABASE_URL")"
else
  : "${POSTGRES_USER:=ipredict}"
  : "${POSTGRES_DB:=ipredict}"
  target="$POSTGRES_DB (inside the compose postgres service)"
fi

if [[ "$ASSUME_YES" != "yes" ]]; then
  [[ -t 0 ]] || die "refusing to restore non-interactively without --yes"
  log "about to DROP AND REPLACE the contents of: $target"
  log "source: $DUMP"
  read -r -p "[restore] type 'restore' to continue: " reply
  [[ "$reply" == "restore" ]] || die "aborted"
fi

# ── Restore ──────────────────────────────────────────────────────────────────
log "restoring $DUMP into $target"

if [[ "$USE_DOCKER" == "no" ]]; then
  pg_restore \
    --dbname="$DATABASE_URL" \
    --clean --if-exists \
    --no-owner --no-privileges \
    --exit-on-error \
    --jobs="$JOBS" \
    "$RESTORE_INPUT"
else
  compose exec -T postgres sh -c \
    "cat > /tmp/restore.dump && \
     pg_restore --username='$POSTGRES_USER' --dbname='$POSTGRES_DB' \
       --clean --if-exists --no-owner --no-privileges --exit-on-error \
       --jobs='$JOBS' /tmp/restore.dump; rc=\$?; rm -f /tmp/restore.dump; exit \$rc" \
    < "$RESTORE_INPUT"
fi

log "restore complete"
log "next: re-run migrations so schema_migrations matches the code, then restart the API and indexer"
