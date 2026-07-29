#!/usr/bin/env bash
# Create iPredict backend/oracle issues from a TSV file.
#
# TSV columns (tab-separated), one issue per line:
#   title \t labels(comma-sep) \t milestone-number \t body-file-path
#
# Usage: scripts/create-issues.sh <issues.tsv>
#
# Idempotency: skips creating an issue whose exact title already exists (open or closed).
set -euo pipefail

REPO="Akanimoh12/Stellar-iPredict"
TSV="${1:?usage: create-issues.sh <issues.tsv>}"

# Cache existing titles once to avoid an API call per issue.
echo "Fetching existing issue titles…"
EXISTING="$(gh issue list --repo "$REPO" --state all --limit 1000 --json title --jq '.[].title')"

created=0
skipped=0
while IFS=$'\t' read -r title labels milestone bodyfile; do
  [ -z "${title:-}" ] && continue
  case "$title" in \#*) continue;; esac   # allow # comments

  if grep -Fxq "$title" <<<"$EXISTING"; then
    echo "skip (exists): $title"
    skipped=$((skipped+1))
    continue
  fi

  gh issue create --repo "$REPO" \
    --title "$title" \
    --label "$labels" \
    --milestone "$milestone" \
    --body-file "$bodyfile" >/dev/null

  echo "created: $title"
  created=$((created+1))
  sleep 0.6   # gentle on the API
done < "$TSV"

echo "----"
echo "created=$created  skipped=$skipped"
