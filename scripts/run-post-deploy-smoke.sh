#!/usr/bin/env bash
# =============================================================================
# iPredict — shared post-deployment smoke gate
# =============================================================================
# Runs test/smoke/run.ts (issue #1001) against the supplied deployment and
# exits non-zero when any check fails, so the calling deploy script fails too.
#
# Environment:
#   SMOKE_BASE_URL   Target origin. API_PUBLIC_URL is used as a fallback.
#   SMOKE_ARGS       Extra arguments forwarded to the smoke CLI.
#   SKIP_SMOKE       Set to 1 to skip (contract-only deploys/offline restores).
#
# A missing target is a warning rather than a failure: deploying contracts does
# not necessarily start the API, and there is nothing meaningful to smoke yet.
# Set SMOKE_BASE_URL in the deploy environment to make this an actual gate.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "${SKIP_SMOKE:-0}" == "1" ]]; then
  echo "[smoke] SKIP_SMOKE=1 — skipping post-deployment smoke suite"
  exit 0
fi

TARGET="${SMOKE_BASE_URL:-${API_PUBLIC_URL:-}}"
if [[ -z "$TARGET" ]]; then
  echo "[smoke] warning: no SMOKE_BASE_URL/API_PUBLIC_URL; skipping smoke suite." >&2
  echo "[smoke] set SMOKE_BASE_URL to make the deploy gate mandatory." >&2
  exit 0
fi

echo "[smoke] running post-deployment smoke suite against $TARGET"
# SMOKE_ARGS is an operator-controlled word list (e.g. "--strict --timeout-ms 20000").
# shellcheck disable=SC2086
if ! (cd "$ROOT" && npm run --silent smoke -- --base-url "$TARGET" $SMOKE_ARGS); then
  echo "[smoke] ERROR: smoke suite failed against $TARGET. The rollout is NOT verified." >&2
  exit 1
fi

echo "[smoke] smoke suite passed"
