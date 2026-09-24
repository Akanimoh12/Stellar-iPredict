#!/usr/bin/env bash
#
# iPredict — deploy the production backend stack.
#
#   infra/scripts/deploy.sh                        # migrate + bring up everything
#   infra/scripts/deploy.sh --services api indexer # migrate, then only those
#   infra/scripts/deploy.sh --skip-migrate         # deploy without migrating
#
# What it does, in order:
#   1. Starts the data plane (postgres, redis) and the log collector, and
#      waits for postgres to report healthy.
#   2. Runs DB migrations (db/migrations, in filename order) BEFORE any
#      application service starts. This is the point of the script: api and
#      indexer must never boot against a half-migrated schema.
#   3. Starts the application services (api, indexer, oracle-*).
#
# Migrations go through the compose `migrate` profile, which runs
# scripts/init-db.sh against the running database. That path is idempotent:
# already-applied files are skipped, and each migration commits together with
# its schema_migrations bookkeeping row. It is safe to run on every deploy.
#
# The script only manipulates the compose stack — it never touches host state
# outside infra/ — so it is safe to run repeatedly and from CI.
#
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly INFRA_DIR="$(dirname -- "$SCRIPT_DIR")"
readonly COMPOSE_FILE="${COMPOSE_FILE:-$INFRA_DIR/docker-compose.production.yml}"
readonly DEFAULT_ENV_FILE="$INFRA_DIR/.env"

ENV_FILE="$DEFAULT_ENV_FILE"
SERVICES=()
SKIP_MIGRATE="no"
BUILD_FLAG=()

log() { printf '[deploy] %s\n' "$*" >&2; }
die() { printf '[deploy] error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: deploy.sh [options] [--] [services...]

Deploy the iPredict production stack: run DB migrations, then start the
application services.

Options:
      --skip-migrate   Do not run the migration step (use with care)
      --no-build       Do not build images; use existing/tagged ones
      --services LIST  Comma-separated list of services to start
                       (migrations still run first unless --skip-migrate)
      --env-file PATH  Environment file for compose interpolation
                       (default: infra/.env, or $ENV_FILE)
  -h, --help           Show this help

Positional:
  services...          Same as --services: only start the listed services.
                       Defaults to the full stack.

Environment:
  COMPOSE_FILE         Alternative compose file
  ENV_FILE             Alternative env file (same as --env-file)

Examples:
  infra/scripts/deploy.sh
  infra/scripts/deploy.sh --services api,indexer
  infra/scripts/deploy.sh --no-build
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-migrate) SKIP_MIGRATE="yes"; shift ;;
    --no-build)     BUILD_FLAG=(--no-build); shift ;;
    --services)     IFS=',' read -r -a SERVICES <<< "${2:?--services needs a comma-separated list}"; shift 2 ;;
    --env-file)     ENV_FILE="${2:?--env-file needs a path}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    --)             shift; SERVICES+=("$@"); break ;;
    -*)             usage >&2; die "unknown option: $1" ;;
    *)              SERVICES+=("$1"); shift ;;
  esac
done

# ── Preflight ────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is required but not on PATH"
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
else
  command -v docker-compose >/dev/null 2>&1 || die "docker compose is required"
  COMPOSE=(docker-compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
fi

[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE (copy infra/.env.example to infra/.env and fill it in)"

# Compose resolves relative volume paths against the directory of the compose
# file; running from infra/ keeps `../db/migrations` and `./scripts/*` correct
# regardless of where deploy.sh is invoked from.
cd -- "$INFRA_DIR"

# ── 1. Data plane ────────────────────────────────────────────────────────────
# Start postgres, redis and the log collector first. `--wait` blocks until the
# healthchecked services are healthy, so by the time this returns the database
# is ready to migrate (the postgres healthcheck probes over TCP, which only
# answers after first-boot migrations in /docker-entrypoint-initdb.d finish).
# migrate also declares depends_on: postgres (service_healthy), so this step
# and the next one cannot race.
log "starting data plane (postgres, redis, log-collector)..."
timeout 300 "${COMPOSE[@]}" up -d --wait "${BUILD_FLAG[@]}" postgres redis log-collector \
  || die "data plane did not become healthy within 300s (check infra/.env values)"

# ── 2. Migrations ────────────────────────────────────────────────────────────
# Run BEFORE any application service. init-db.sh is idempotent: on first boot
# postgres already applied everything in /docker-entrypoint-initdb.d and the
# migrate run below is a no-op; on later deploys it applies only the new
# migration files, each in its own transaction with its bookkeeping row.
if [[ "$SKIP_MIGRATE" == "no" ]]; then
  log "applying DB migrations..."
  "${COMPOSE[@]}" --profile migrate run --rm migrate
else
  log "skipping migrations (--skip-migrate)"
fi

# ── 3. Application services ──────────────────────────────────────────────────
if [[ "${#SERVICES[@]}" -eq 0 ]]; then
  log "starting the full stack..."
  "${COMPOSE[@]}" up -d "${BUILD_FLAG[@]}"
else
  log "starting services: ${SERVICES[*]}..."
  "${COMPOSE[@]}" up -d "${BUILD_FLAG[@]}" "${SERVICES[@]}"
fi

log "deploy complete"
log "  status:  docker compose -f $COMPOSE_FILE ps"
log "  logs:    docker compose -f $COMPOSE_FILE logs -f <service>"
