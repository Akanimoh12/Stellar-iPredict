import { createHash } from "node:crypto";

/**
 * Strong ETag for a JSON-serialisable payload — a quoted sha1 hex digest of
 * its canonical `JSON.stringify` form, per RFC 7232 §2.3.
 */
export function computeEtag(payload: unknown): string {
  const hash = createHash("sha1").update(JSON.stringify(payload)).digest("hex");
  return `"${hash}"`;
}

/**
 * Whether an `If-None-Match` request header matches `etag`.
 *
 * The header may carry a comma-separated list and/or the `*` wildcard
 * (RFC 7232 §3.2); a weak comparison (leading `W/`) is treated as a match
 * since we only ever compare full representations here.
 */
export function matchesIfNoneMatch(
  header: string | string[] | undefined,
  etag: string
): boolean {
  if (!header) {
    return false;
  }

  const values = Array.isArray(header) ? header : [header];
  return values.some((value) =>
    value
      .split(",")
      .map((candidate) => candidate.trim())
      .some((candidate) => candidate === "*" || candidate === etag || candidate === `W/${etag}`)
  );
}
