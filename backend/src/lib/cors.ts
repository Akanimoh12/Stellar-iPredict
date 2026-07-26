/**
 * CORS allowlist parsing.
 *
 * Lives here rather than in `server.ts` because `config/index.ts` needs it: the
 * server now imports the route index, which reaches the DB pool and therefore
 * the config module. Keeping this leaf-level breaks that cycle.
 */

/** Origin used when `CORS_ORIGINS` is unset — the frontend's dev server. */
export const DEFAULT_CORS_ORIGINS = ["http://localhost:3000"];

/**
 * Parses the `CORS_ORIGINS` env var (comma-separated) into an allowlist.
 *
 * Unset falls back to the local frontend; explicitly empty allows no browser
 * origin at all, which is the right default for a private deployment.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULT_CORS_ORIGINS];

  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
