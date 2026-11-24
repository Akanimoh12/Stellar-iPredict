#!/usr/bin/env bash
# End-to-end local environment check (Issue #1002).
#
# Boots the Docker Compose dev stack, applies migrations, and runs a scripted
# market lifecycle against the real Postgres database. The stack (including its
# volumes) is removed on exit so the check is repeatable. Set KEEP_STACK=1 to
# keep the containers for debugging.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="infra/docker-compose.dev.yml"
KEEP_STACK="${KEEP_STACK:-0}"

cleanup() {
  if [[ "$KEEP_STACK" != "1" ]]; then
    docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null
  fi
}
trap cleanup EXIT

echo "==> Starting local dev stack (Postgres + Redis)"
docker compose -f "$COMPOSE_FILE" up -d --wait

export DATABASE_URL="${DATABASE_URL:-postgres://ipredict:ipredict@localhost:5432/ipredict}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"

echo "==> Applying database migrations"
npm run migrate --workspace=ipredict-db

echo "==> Running scripted market lifecycle"
npm run test:e2e:local:db
