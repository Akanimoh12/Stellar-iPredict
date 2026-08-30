#!/usr/bin/env bash
# =============================================================================
# iPredict — Pre-PR Verification Script
# =============================================================================
# Runs typecheck + tests for backend, indexer, and oracle.
#
# There is no CI on the `implementation-drips` branch yet, so contributors
# should run this before opening a PR.
#
# Usage:
#   ./scripts/verify-all.sh
#
# Requires:
#   - Node.js >= 20
#   - npm dependencies installed in backend/, indexer/, oracle/
#   - PostgreSQL and Redis running locally (for tests that need them)
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; FAILURES=$((FAILURES+1)); }
step() { echo -e "\n${BOLD}━━━ $* ━━━${NC}"; }
info() { echo -e "  ${BLUE}·${NC} $*"; }

FAILURES=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Services to check ─────────────────────────────────────────────────────────
SERVICES=("backend" "indexer" "oracle")

echo -e "${BOLD}iPredict — Pre-PR Verification${NC}"
echo -e "Branch: implementation-drips (no CI)"
echo -e "Services: ${SERVICES[*]}"
echo ""

# ── Run checks for each service ──────────────────────────────────────────────
for SERVICE in "${SERVICES[@]}"; do
  SERVICE_DIR="$ROOT/$SERVICE"

  if [[ ! -d "$SERVICE_DIR" ]]; then
    fail "$SERVICE — directory not found at $SERVICE_DIR"
    continue
  fi

  if [[ ! -f "$SERVICE_DIR/package.json" ]]; then
    fail "$SERVICE — no package.json found"
    continue
  fi

  # ── Typecheck ───────────────────────────────────────────────────────────────
  step "Typecheck: $SERVICE"
  info "Running: npm run typecheck (in $SERVICE/)"
  if (cd "$SERVICE_DIR" && npm run typecheck); then
    pass "$SERVICE typecheck passed"
  else
    fail "$SERVICE typecheck FAILED (see output above)"
  fi

  # ── Tests ───────────────────────────────────────────────────────────────────
  step "Tests: $SERVICE"
  info "Running: npm test (in $SERVICE/)"
  if (cd "$SERVICE_DIR" && npm test); then
    pass "$SERVICE tests passed"
  else
    fail "$SERVICE tests FAILED (see output above)"
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
if [[ "$FAILURES" -eq 0 ]]; then
  echo -e "${BOLD}${GREEN}║   All checks passed!                 ║${NC}"
else
  echo -e "${BOLD}${RED}║   $FAILURES check(s) failed — see above    ║${NC}"
fi
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""

exit "$FAILURES"