#!/bin/sh
#
# iPredict — apply db/migrations in filename order and record them.
#
# Runs in two places, which is why it uses plain PG* environment variables
# rather than a connection string:
#
#   1. Inside the postgres container's /docker-entrypoint-initdb.d on the very
#      first boot of an empty volume (the compose stack's automatic path).
#   2. On demand against an already-running database, to pick up migrations
#      added after that first boot:
#
#        docker compose -f docker-compose.production.yml --profile migrate \
#          run --rm migrate
#
# It writes the same `schema_migrations` bookkeeping table that db/migrate.ts
# uses, so the two runners agree on what has already been applied and neither
# re-runs a migration the other performed.
#
set -eu

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"

# The official postgres entrypoint exports POSTGRES_USER/POSTGRES_DB; a
# standalone run supplies PGUSER/PGDATABASE (plus PGHOST/PGPASSWORD).
PGUSER="${PGUSER:-${POSTGRES_USER:-postgres}}"
PGDATABASE="${PGDATABASE:-${POSTGRES_DB:-$PGUSER}}"
export PGUSER PGDATABASE

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "[init-db] no migrations directory at $MIGRATIONS_DIR; nothing to do" >&2
  exit 0
fi

psql -v ON_ERROR_STOP=1 -q -c "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )"

applied=0
skipped=0

for path in "$MIGRATIONS_DIR"/*.sql; do
  [ -e "$path" ] || continue
  name="$(basename "$path")"

  # Quote the filename for SQL by doubling any single quotes. Migration names
  # never contain one today; this keeps that from becoming a latent injection
  # if one ever does.
  quoted="$(printf '%s' "$name" | sed "s/'/''/g")"

  if [ -n "$(psql -v ON_ERROR_STOP=1 -tAc "SELECT 1 FROM schema_migrations WHERE filename = '$quoted'")" ]; then
    echo "[init-db] skip $name (already applied)"
    skipped=$((skipped + 1))
    continue
  fi

  echo "[init-db] apply $name"
  # One transaction per migration: the file and its bookkeeping row commit
  # together, so a failure can never leave a migration applied but unrecorded.
  psql -v ON_ERROR_STOP=1 -q --single-transaction \
    -f "$path" \
    -c "INSERT INTO schema_migrations (filename) VALUES ('$quoted')"
  applied=$((applied + 1))
done

echo "[init-db] done: $applied applied, $skipped already present"
