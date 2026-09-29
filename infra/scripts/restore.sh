#!/usr/bin/env bash
#
# iPredict — PostgreSQL restore.
#
# Loads a dump produced by backup.sh back into a database. This DROPS AND
# REPLACES every object the dump contains, so it refuses to run without an
# explicit confirmation.
#
#   infra/scripts/restore.sh infra/backups/ipredict-20260101T000000Z.dump
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

log() { printf '[restore] %s\n' "$*" >&2; }
die() { printf '[restore] error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: restore.sh [options] <dump-file>

Options:
  -d, --database URL   Target Postgres connection string (default: $DATABASE_URL)
  -j, --jobs N         Parallel restore workers (default: 4, or $RESTORE_JOBS)
  -l, --list           Print the archive's contents and exit. Changes nothing.
  -y, --yes            Skip the interactive confirmation (for automation)
      --docker         Run pg_restore inside the compose postgres service
      --local          Run the pg_restore binary on this machine
  -h, --help           Show this help

The restore is destructive: objects in the dump are dropped and recreated in
the target database. Point -d at the database you mean to overwrite.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--database) DATABASE_URL="${2:?--database needs a URL}"; shift 2 ;;
    -j|--jobs)     JOBS="${2:?--jobs needs a number}"; shift 2 ;;
    -l|--list)     LIST_ONLY="yes"; shift ;;
    -y|--yes)      ASSUME_YES="yes"; shift ;;
    --docker)      USE_DOCKER="yes"; shift ;;
    --local)       USE_DOCKER="no"; shift ;;
    -h|--help)     usage; exit 0 ;;
    -*)            usage >&2; die "unknown option: $1" ;;
    *)             [[ -z "$DUMP" ]] || die "only one dump file may be given"; DUMP="$1"; shift ;;
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

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" "$@"
  else
    docker-compose -f "$COMPOSE_FILE" "$@"
  fi
}

if [[ "$USE_DOCKER" == "auto" ]]; then
  # Without a URL there is nothing for a local client to dial: the compose
  # stack keeps Postgres on the internal network with no published port.
  if [[ -n "$DATABASE_URL" ]] && command -v pg_restore >/dev/null 2>&1; then
    USE_DOCKER="no"
  else
    USE_DOCKER="yes"
  fi
fi

if [[ "$LIST_ONLY" == "yes" ]]; then
  if [[ "$USE_DOCKER" == "no" ]]; then
    pg_restore --list "$DUMP"
  else
    compose exec -T postgres sh -c \
      'cat > /tmp/list.dump && pg_restore --list /tmp/list.dump; rc=$?; rm -f /tmp/list.dump; exit $rc' \
      < "$DUMP"
  fi
  exit 0
fi

# ── Confirm ──────────────────────────────────────────────────────────────────
# Show the target without its password: the point is to let the operator catch
# "wrong database", not to print a credential into a terminal log.
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
# --clean --if-exists   drop each object first, tolerating a fresh database
# --no-owner/-privileges  the dump is portable across environments whose role
#                        names differ; ownership is set by the target's role
# --exit-on-error        stop at the first failure instead of leaving a
#                        half-restored schema that looks like it worked
log "restoring $DUMP into $target"

if [[ "$USE_DOCKER" == "no" ]]; then
  pg_restore \
    --dbname="$DATABASE_URL" \
    --clean --if-exists \
    --no-owner --no-privileges \
    --exit-on-error \
    --jobs="$JOBS" \
    "$DUMP"
else
  compose exec -T postgres sh -c \
    "cat > /tmp/restore.dump && \
     pg_restore --username='$POSTGRES_USER' --dbname='$POSTGRES_DB' \
       --clean --if-exists --no-owner --no-privileges --exit-on-error \
       --jobs='$JOBS' /tmp/restore.dump; rc=\$?; rm -f /tmp/restore.dump; exit \$rc" \
    < "$DUMP"
fi

log "restore complete"
log "next: re-run migrations so schema_migrations matches the code, then restart the API and indexer"
