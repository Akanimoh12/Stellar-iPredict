#!/usr/bin/env bash
#
# iPredict — PostgreSQL backup.
#
# Takes a compressed, verified pg_dump of the iPredict database, optionally
# encrypts it with AES-256, ships it off-site (S3/remote host), and prunes old
# dumps. Restore with the sibling restore.sh.
#
#   infra/scripts/backup.sh                       # dump to infra/backups/
#   infra/scripts/backup.sh -o /srv/backups -r 14 # custom dir, 14-day retention
#   infra/scripts/backup.sh --docker              # dump via the compose container
#   infra/scripts/backup.sh --encrypt             # encrypt dump with AES-256-CBC
#   infra/scripts/backup.sh --s3-uri s3://bucket/ # copy dump and checksum off-site
#
# Design notes:
#   - Custom format (-Fc), not plain SQL: it is compressed, restores in
#     parallel, and lets restore.sh be selective about which objects it brings
#     back.
#   - The dump is written to a .part file and renamed only after pg_restore -l
#     has read it back. A half-written file is never left looking like a
#     usable backup.
#   - Optional AES-256-CBC encryption (PBKDF2 key derivation, 100k iterations)
#     protects sensitive data at rest and in transit off the host.
#   - A .sha256 sidecar is written for every dump (and encrypted dump) so restore.sh
#     can prove the file it is about to load has not rotted or been truncated in transit.
#   - Optional off-site replication to S3-compatible object storage or remote
#     SSH/rsync targets guarantees disaster recovery if the host is lost.
#
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly INFRA_DIR="$(dirname -- "$SCRIPT_DIR")"
readonly COMPOSE_FILE="${COMPOSE_FILE:-$INFRA_DIR/docker-compose.production.yml}"

BACKUP_DIR="${BACKUP_DIR:-$INFRA_DIR/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
DATABASE_URL="${DATABASE_URL:-}"
USE_DOCKER="auto"

ENCRYPT="${BACKUP_ENCRYPT:-auto}"
ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-${BACKUP_PASSPHRASE:-}}"
ENCRYPTION_KEY_FILE="${BACKUP_PASSPHRASE_FILE:-${BACKUP_ENCRYPTION_KEY_FILE:-}}"

S3_URI="${BACKUP_S3_URI:-}"
REMOTE_DEST="${BACKUP_REMOTE_DEST:-}"

readonly PREFIX="ipredict"

log()  { printf '[backup] %s\n' "$*" >&2; }
die()  { printf '[backup] error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: backup.sh [options]

Options:
  -o, --output DIR          Directory to write the dump into
                            (default: infra/backups, or $BACKUP_DIR)
  -d, --database URL        Postgres connection string
                            (default: $DATABASE_URL)
  -r, --retention DAYS      Delete dumps older than DAYS. 0 disables pruning
                            (default: 7, or $BACKUP_RETENTION_DAYS)
      --docker              Always run pg_dump inside the compose postgres service
      --local               Always run the pg_dump binary on this machine

Encryption options:
  -e, --encrypt             Encrypt dump with AES-256-CBC
      --no-encrypt          Do not encrypt dump
      --encryption-key KEY  Passphrase / key for AES-256 encryption
                            (default: $BACKUP_ENCRYPTION_KEY or $BACKUP_PASSPHRASE)
      --key-file FILE       File containing passphrase for AES-256 encryption
                            (default: $BACKUP_PASSPHRASE_FILE)

Off-site shipping options:
      --s3-uri URI          S3 / object storage URI to ship backup to (e.g. s3://bucket/path)
                            (default: $BACKUP_S3_URI)
      --remote-dest DEST    Remote rsync/scp target (e.g. user@remote.host:/path)
                            (default: $BACKUP_REMOTE_DEST)

  -h, --help                Show this help

Environment:
  DATABASE_URL, BACKUP_DIR, BACKUP_RETENTION_DAYS, COMPOSE_FILE
  BACKUP_ENCRYPTION_KEY, BACKUP_PASSPHRASE, BACKUP_PASSPHRASE_FILE
  BACKUP_S3_URI, BACKUP_REMOTE_DEST
  POSTGRES_USER / POSTGRES_DB  (used in --docker mode)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output)           BACKUP_DIR="${2:?--output needs a directory}"; shift 2 ;;
    -d|--database)         DATABASE_URL="${2:?--database needs a URL}"; shift 2 ;;
    -r|--retention)        RETENTION_DAYS="${2:?--retention needs a number}"; shift 2 ;;
    --docker)              USE_DOCKER="yes"; shift ;;
    --local)               USE_DOCKER="no"; shift ;;
    -e|--encrypt)          ENCRYPT="yes"; shift ;;
    --no-encrypt)          ENCRYPT="no"; shift ;;
    --encryption-key|--passphrase)
                           ENCRYPTION_KEY="${2:?--encryption-key needs a passphrase}"; ENCRYPT="yes"; shift 2 ;;
    --key-file|--passphrase-file)
                           ENCRYPTION_KEY_FILE="${2:?--key-file needs a file path}"; ENCRYPT="yes"; shift 2 ;;
    --s3-uri)              S3_URI="${2:?--s3-uri needs a URI}"; shift 2 ;;
    --remote-dest)         REMOTE_DEST="${2:?--remote-dest needs a destination}"; shift 2 ;;
    -h|--help)             usage; exit 0 ;;
    *)                     usage >&2; die "unknown argument: $1" ;;
  esac
done

[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "retention must be a whole number of days, got '$RETENTION_DAYS'"

# Resolve auto encryption
if [[ "$ENCRYPT" == "auto" ]]; then
  if [[ -n "$ENCRYPTION_KEY" || -n "$ENCRYPTION_KEY_FILE" ]]; then
    ENCRYPT="yes"
  else
    ENCRYPT="no"
  fi
fi

if [[ "$ENCRYPT" == "yes" ]]; then
  command -v openssl >/dev/null 2>&1 || die "openssl is required for backup encryption"
  if [[ -z "$ENCRYPTION_KEY" && -z "$ENCRYPTION_KEY_FILE" ]]; then
    die "encryption requested but neither BACKUP_ENCRYPTION_KEY nor BACKUP_PASSPHRASE_FILE was provided"
  fi
  if [[ -n "$ENCRYPTION_KEY_FILE" && ! -f "$ENCRYPTION_KEY_FILE" ]]; then
    die "encryption key file not found: $ENCRYPTION_KEY_FILE"
  fi
fi

# ── Pick how pg_dump runs ────────────────────────────────────────────────────
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
readonly PARTIAL_ENC="$TARGET.part.enc"

# Any non-zero exit leaves no partial files behind.
cleanup() { rm -f -- "$PARTIAL" "$PARTIAL_ENC" 2>/dev/null || true; }
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

# ── Verify ───────────────────────────────────────────────────────────────────
# Verify the unencrypted archive TOC before encrypting or finalizing.
verify() {
  if command -v pg_restore >/dev/null 2>&1; then
    pg_restore --list "$PARTIAL" >/dev/null
  elif [[ "$USE_DOCKER" == "yes" ]]; then
    compose exec -T postgres sh -c \
      'cat > /tmp/verify.dump && pg_restore --list /tmp/verify.dump >/dev/null; rc=$?; rm -f /tmp/verify.dump; exit $rc' \
      < "$PARTIAL"
  else
    log "warning: no pg_restore available; skipping archive verification"
    return 0
  fi
}

verify || die "the dump failed verification and was discarded"

# ── Optional Encryption ──────────────────────────────────────────────────────
if [[ "$ENCRYPT" == "yes" ]]; then
  log "encrypting dump with AES-256-CBC..."
  if [[ -n "$ENCRYPTION_KEY_FILE" ]]; then
    openssl enc -aes-256-cbc -salt -pbkdf2 -iter 100000 \
      -in "$PARTIAL" -out "$PARTIAL_ENC" \
      -pass "file:$ENCRYPTION_KEY_FILE"
  else
    openssl enc -aes-256-cbc -salt -pbkdf2 -iter 100000 \
      -in "$PARTIAL" -out "$PARTIAL_ENC" \
      -pass "pass:$ENCRYPTION_KEY"
  fi
  [[ -s "$PARTIAL_ENC" ]] || die "encryption failed or produced empty file"
  rm -f -- "$PARTIAL"
  FINAL_TARGET="${TARGET}.enc"
  mv "$PARTIAL_ENC" "$FINAL_TARGET"
else
  FINAL_TARGET="$TARGET"
  mv "$PARTIAL" "$FINAL_TARGET"
fi

trap - EXIT

# ── Sidecar Checksum ─────────────────────────────────────────────────────────
checksum() {
  local dir base
  dir="$(cd -- "$(dirname -- "$FINAL_TARGET")" && pwd)"
  base="$(basename -- "$FINAL_TARGET")"
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$dir" && sha256sum "$base" > "$base.sha256" )
  elif command -v shasum >/dev/null 2>&1; then
    ( cd "$dir" && shasum -a 256 "$base" > "$base.sha256" )
  else
    log "warning: no sha256 tool found; skipping checksum"
  fi
}
checksum

log "wrote $FINAL_TARGET ($(du -h "$FINAL_TARGET" | cut -f1))"

# ── Off-site shipping ────────────────────────────────────────────────────────
ship_offsite() {
  local base
  base="$(basename -- "$FINAL_TARGET")"

  if [[ -n "$S3_URI" ]]; then
    log "shipping backup off-site to S3: $S3_URI"
    if command -v aws >/dev/null 2>&1; then
      aws s3 cp "$FINAL_TARGET" "$S3_URI/$base"
      if [[ -f "$FINAL_TARGET.sha256" ]]; then
        aws s3 cp "$FINAL_TARGET.sha256" "$S3_URI/$base.sha256"
      fi
    elif command -v s3cmd >/dev/null 2>&1; then
      s3cmd put "$FINAL_TARGET" "$S3_URI/$base"
      if [[ -f "$FINAL_TARGET.sha256" ]]; then
        s3cmd put "$FINAL_TARGET.sha256" "$S3_URI/$base.sha256"
      fi
    else
      die "off-site S3 shipping requested ($S3_URI) but neither 'aws' nor 's3cmd' CLI was found"
    fi
    log "off-site S3 upload complete"
  fi

  if [[ -n "$REMOTE_DEST" ]]; then
    log "shipping backup off-site to remote destination: $REMOTE_DEST"
    if command -v rsync >/dev/null 2>&1; then
      if [[ -f "$FINAL_TARGET.sha256" ]]; then
        rsync -avz "$FINAL_TARGET" "$FINAL_TARGET.sha256" "$REMOTE_DEST/"
      else
        rsync -avz "$FINAL_TARGET" "$REMOTE_DEST/"
      fi
    elif command -v scp >/dev/null 2>&1; then
      if [[ -f "$FINAL_TARGET.sha256" ]]; then
        scp "$FINAL_TARGET" "$FINAL_TARGET.sha256" "$REMOTE_DEST/"
      else
        scp "$FINAL_TARGET" "$REMOTE_DEST/"
      fi
    else
      die "off-site remote copy requested ($REMOTE_DEST) but neither 'rsync' nor 'scp' was found"
    fi
    log "off-site remote copy complete"
  fi
}

ship_offsite

# ── Prune ────────────────────────────────────────────────────────────────────
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  pruned=0
  while IFS= read -r old; do
    rm -f -- "$old" "$old.sha256"
    pruned=$((pruned + 1))
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f \( -name "${PREFIX}-*.dump" -o -name "${PREFIX}-*.dump.enc" \) -mtime "+$RETENTION_DAYS")
  log "pruned $pruned dump(s) older than ${RETENTION_DAYS}d"
fi

log "done"
