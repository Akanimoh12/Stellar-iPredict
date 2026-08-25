#!/usr/bin/env bash
#
# iPredict — PostgreSQL backup.
#
# Takes a compressed, verified pg_dump of the iPredict database and prunes old
# dumps. Restore with the sibling restore.sh.
#
#   infra/scripts/backup.sh                       # dump to infra/backups/
#   infra/scripts/backup.sh -o /srv/backups -r 14 # custom dir, 14-day retention
#   infra/scripts/backup.sh --docker              # dump via the compose container
#
# Design notes:
#   - Custom format (-Fc), not plain SQL: it is compressed, restores in
#     parallel, and lets restore.sh be selective about which objects it brings
#     back.
#   - The dump is written to a .part file and renamed only after pg_restore -l
#     has read it back. A half-written file is never left looking like a
#     usable backup.
#   - A .sha256 sidecar is written for every dump so restore.sh can prove the
#     file it is about to load has not rotted or been truncated in transit.
#
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly INFRA_DIR="$(dirname -- "$SCRIPT_DIR")"
readonly COMPOSE_FILE="${COMPOSE_FILE:-$INFRA_DIR/docker-compose.production.yml}"

BACKUP_DIR="${BACKUP_DIR:-$INFRA_DIR/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
DATABASE_URL="${DATABASE_URL:-}"
USE_DOCKER="auto"

readonly PREFIX="ipredict"

log()  { printf '[backup] %s\n' "$*" >&2; }
die()  { printf '[backup] error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: backup.sh [options]

Options:
  -o, --output DIR      Directory to write the dump into
                        (default: infra/backups, or $BACKUP_DIR)
  -d, --database URL    Postgres connection string
                        (default: $DATABASE_URL)
  -r, --retention DAYS  Delete dumps older than DAYS. 0 disables pruning
                        (default: 7, or $BACKUP_RETENTION_DAYS)
      --docker          Always run pg_dump inside the compose postgres service
      --local           Always run the pg_dump binary on this machine
  -h, --help            Show this help

Environment:
  DATABASE_URL, BACKUP_DIR, BACKUP_RETENTION_DAYS, COMPOSE_FILE
  POSTGRES_USER / POSTGRES_DB  (used in --docker mode)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output)     BACKUP_DIR="${2:?--output needs a directory}"; shift 2 ;;
    -d|--database)   DATABASE_URL="${2:?--database needs a URL}"; shift 2 ;;
    -r|--retention)  RETENTION_DAYS="${2:?--retention needs a number}"; shift 2 ;;
    --docker)        USE_DOCKER="yes"; shift ;;
    --local)         USE_DOCKER="no"; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               usage >&2; die "unknown argument: $1" ;;
  esac
done

[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "retention must be a whole number of days, got '$RETENTION_DAYS'"

# ── Pick how pg_dump runs ────────────────────────────────────────────────────
# pg_dump refuses to dump a server newer than itself, and the host's client is
# routinely older than the pinned postgres:16 server. When it is, fall back to
# the container's own pg_dump rather than failing at the end of a long dump.
server_major() {
  [[ -n "$DATABASE_URL" ]] || return 1
  command -v psql >/dev/null 2>&1 || return 1
  psql "$DATABASE_URL" -tAc 'SHOW server_version_num' 2>/dev/null | cut -c1-2
}

choose_mode() {
  if [[ "$USE_DOCKER" != "auto" ]]; then
    return
  fi
  if [[ -z "$DATABASE_URL" ]]; then
    # The compose stack keeps Postgres on the internal network with no
    # published port, so with no URL to dial the container's own client is the
    # only thing that can reach it.
    log "no DATABASE_URL; dumping through the compose postgres service"
    USE_DOCKER="yes"
    return
  fi
  if ! command -v pg_dump >/dev/null 2>&1; then
    log "no local pg_dump; running it inside the compose postgres service"
    USE_DOCKER="yes"
    return
  fi
  local client server
  client="$(pg_dump --version | grep -oE '[0-9]+' | head -1)"
  server="$(server_major || true)"
  if [[ -n "$server" && "$client" -lt "$server" ]]; then
    log "local pg_dump is $client but the server is $server; using the container's client"
    USE_DOCKER="yes"
  else
    USE_DOCKER="no"
  fi
}

choose_mode

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" "$@"
  else
    docker-compose -f "$COMPOSE_FILE" "$@"
  fi
}

if [[ "$USE_DOCKER" == "no" ]]; then
  [[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is not set (see infra/.env.example)"
else
  command -v docker >/dev/null 2>&1 || die "docker is required for --docker mode"
  [[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
fi

# ── Dump ─────────────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"

readonly STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly TARGET="$BACKUP_DIR/${PREFIX}-${STAMP}.dump"
readonly PARTIAL="$TARGET.part"

# Any non-zero exit leaves no partial file behind to be mistaken for a backup.
cleanup() { rm -f -- "$PARTIAL" 2>/dev/null || true; }
trap cleanup EXIT

log "dumping to $TARGET"

if [[ "$USE_DOCKER" == "no" ]]; then
  pg_dump \
    --dbname="$DATABASE_URL" \
    --format=custom \
    --compress=9 \
    --no-owner \
    --no-privileges \
    --file="$PARTIAL"
else
  : "${POSTGRES_USER:=ipredict}"
  : "${POSTGRES_DB:=ipredict}"
  # -T: no TTY, so the binary dump reaches stdout unmangled.
  compose exec -T postgres \
    pg_dump \
      --username="$POSTGRES_USER" \
      --dbname="$POSTGRES_DB" \
      --format=custom \
      --compress=9 \
      --no-owner \
      --no-privileges \
    > "$PARTIAL"
fi

[[ -s "$PARTIAL" ]] || die "pg_dump produced an empty file"

# ── Verify, then publish ─────────────────────────────────────────────────────
# pg_restore --list parses the whole archive's table of contents, so it fails
# on a truncated or corrupt dump. Cheap, and it is the difference between a
# backup and a file.
verify() {
  if command -v pg_restore >/dev/null 2>&1; then
    pg_restore --list "$PARTIAL" >/dev/null
  elif [[ "$USE_DOCKER" == "yes" ]]; then
    # pg_restore seeks within a custom-format archive, so it cannot read one
    # from a pipe — stage it inside the container first.
    compose exec -T postgres sh -c \
      'cat > /tmp/verify.dump && pg_restore --list /tmp/verify.dump >/dev/null; rc=$?; rm -f /tmp/verify.dump; exit $rc' \
      < "$PARTIAL"
  else
    log "warning: no pg_restore available; skipping archive verification"
    return 0
  fi
}

verify || die "the dump failed verification and was discarded"

mv "$PARTIAL" "$TARGET"
trap - EXIT

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$BACKUP_DIR" && sha256sum "$(basename "$TARGET")" > "$(basename "$TARGET").sha256" )
  elif command -v shasum >/dev/null 2>&1; then
    ( cd "$BACKUP_DIR" && shasum -a 256 "$(basename "$TARGET")" > "$(basename "$TARGET").sha256" )
  else
    log "warning: no sha256 tool found; skipping checksum"
  fi
}
checksum

log "wrote $TARGET ($(du -h "$TARGET" | cut -f1))"

# ── Prune ────────────────────────────────────────────────────────────────────
# Pruning runs last and only after a verified dump landed, so a run of
# failures can never age out the last good backup.
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  pruned=0
  while IFS= read -r old; do
    rm -f -- "$old" "$old.sha256"
    pruned=$((pruned + 1))
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${PREFIX}-*.dump" -mtime "+$RETENTION_DAYS")
  log "pruned $pruned dump(s) older than ${RETENTION_DAYS}d"
fi

log "done"
