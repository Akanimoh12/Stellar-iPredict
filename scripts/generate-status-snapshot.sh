#!/usr/bin/env bash
# Generate status-page/snapshot.json at build time.
#
# The snapshot is a build artifact. It is written into the directory that gets
# deployed and is never committed (status-page/snapshot.json is gitignored).
# See status-page/README.md.
#
# Usage:
#   scripts/generate-status-snapshot.sh [OUTPUT]      # default: status-page/snapshot.json
#
# Environment:
#   STATUS_API_URL    Live /status endpoint, e.g. https://api.ipredict.app/status.
#   STATUS_PAGE_URL   Base URL of the deployed status page, e.g.
#                     https://ipredict-status.pages.dev. Used to carry the last
#                     known good snapshot forward when the live fetch fails.
#
# Sources, in order of preference:
#   1. live      GET $STATUS_API_URL, merged with the oracle resolution status
#   2. previous  the snapshot.json the deployed page is serving right now
#   3. placeholder  status "unknown"
#
# A failed fetch never fails the script: stale is better than blank during an
# outage. The chosen source is printed as `source=<name>` and, on GitHub
# Actions, written to $GITHUB_OUTPUT.

set -uo pipefail

OUTPUT="${1:-status-page/snapshot.json}"
STATUS_API_URL="${STATUS_API_URL:-}"
STATUS_PAGE_URL="${STATUS_PAGE_URL:-}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$(dirname "$OUTPUT")"

log() { echo "$*" >&2; }
warn() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::warning::$*"; else log "warning: $*"; fi
}

# Fetch URL into FILE; succeed only on HTTP 2xx with a JSON object that has a
# string `status` field.
fetch_json() {
  local url="$1" file="$2"
  curl -fsS --max-time 10 --retry 2 --retry-delay 3 -o "$file" "$url" 2>/dev/null \
    && jq -e 'type == "object" and (.status | type == "string")' "$file" >/dev/null 2>&1
}

finish() {
  local source="$1"
  log "Snapshot ($source): $(jq -r .status "$OUTPUT") at $(jq -r .generatedAt "$OUTPUT")"
  echo "source=$source"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "source=$source" >> "$GITHUB_OUTPUT"; fi
  exit 0
}

# ── 1. Live ──────────────────────────────────────────────────────────────────
if [ -z "$STATUS_API_URL" ]; then
  warn "STATUS_API_URL is not set; skipping the live fetch."
elif fetch_json "$STATUS_API_URL" "$TMP/status.json"; then
  # Merge oracle health so the page can show it independently. The URL is
  # derived by replacing /status with /api/markets/resolution-status.
  ORACLE_URL="${STATUS_API_URL/\/status/\/api\/markets\/resolution-status}"
  if curl -fsS --max-time 10 -o "$TMP/oracle.json" "$ORACLE_URL" 2>/dev/null \
     && jq -e . "$TMP/oracle.json" >/dev/null 2>&1; then
    jq --slurpfile oracle "$TMP/oracle.json" '. + {oracleStatus: $oracle[0]}' \
      "$TMP/status.json" > "$OUTPUT"
  else
    cp "$TMP/status.json" "$OUTPUT"
  fi
  finish live
else
  warn "Live /status fetch failed; falling back to the deployed snapshot."
fi

# ── 2. Previous deployed snapshot ────────────────────────────────────────────
if [ -n "$STATUS_PAGE_URL" ]; then
  if fetch_json "${STATUS_PAGE_URL%/}/snapshot.json" "$TMP/previous.json"; then
    cp "$TMP/previous.json" "$OUTPUT"
    finish previous
  fi
  warn "Could not read the deployed snapshot; writing a placeholder."
fi

# ── 3. Placeholder ───────────────────────────────────────────────────────────
cat > "$OUTPUT" <<'JSON'
{
  "_note": "Placeholder written at build time because neither the live /status endpoint nor a previous snapshot was reachable.",
  "status": "unknown",
  "generatedAt": "1970-01-01T00:00:00.000Z",
  "api": { "ok": false, "db": { "ok": false }, "redis": { "ok": false } },
  "indexer": { "ok": false, "lastIndexedLedger": null, "lastEventAt": null, "lagSeconds": null },
  "lastResolvedMarket": null
}
JSON
finish placeholder
