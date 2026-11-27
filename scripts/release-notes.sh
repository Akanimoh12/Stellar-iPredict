#!/usr/bin/env bash
# Print the release notes for one version, taken from CHANGELOG.md.
#
# Usage:
#   scripts/release-notes.sh <version> [CHANGELOG]
#
#   scripts/release-notes.sh 0.2.0          # the "## [0.2.0] - YYYY-MM-DD" section
#   scripts/release-notes.sh v0.2.0         # a leading "v" is accepted
#   scripts/release-notes.sh Unreleased     # preview what the next release holds
#
# Prints the body of the section (without its heading) up to the next "## ["
# heading or the comparison links at the bottom of the file. Exits non-zero if
# the section is missing or empty, so a release cannot be published with blank
# notes. Used with:
#
#   scripts/release-notes.sh 0.2.0 > /tmp/notes.md
#   gh release create v0.2.0 --title v0.2.0 --notes-file /tmp/notes.md
#
# See docs/RELEASING.md.

set -euo pipefail

if [ $# -lt 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <version|Unreleased> [CHANGELOG]" >&2
  exit 2
fi

VERSION="${1#v}"
CHANGELOG="${2:-CHANGELOG.md}"

if [ ! -f "$CHANGELOG" ]; then
  echo "error: $CHANGELOG not found" >&2
  exit 1
fi

NOTES="$(awk -v version="$VERSION" '
  # A section heading looks like "## [0.2.0] - 2026-12-01" or "## [Unreleased]".
  /^## \[/ {
    if (found) exit
    heading = $0
    sub(/^## \[/, "", heading)
    sub(/\].*$/, "", heading)
    if (heading == version) { found = 1; next }
  }
  # Comparison link definitions ("[0.2.0]: https://...") end the last section.
  found && /^\[[^]]+\]: / { exit }
  found { print }
' "$CHANGELOG")"

# Trim leading and trailing blank lines.
NOTES="$(printf '%s\n' "$NOTES" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}')"

if [ -z "$NOTES" ]; then
  echo "error: no entries for [$VERSION] in $CHANGELOG" >&2
  exit 1
fi

printf '%s\n' "$NOTES"
