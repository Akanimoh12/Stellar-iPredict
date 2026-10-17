/**
 * CORS allowlist parsing and validation.
 *
 * Lives here rather than in `server.ts` because `config/index.ts` needs it: the
 * server now imports the route index, which reaches the DB pool and therefore
 * the config module. Keeping this leaf-level breaks that cycle.
 */

/** Origin used when `CORS_ORIGINS` is unset — the frontend's dev server. */
export const DEFAULT_CORS_ORIGINS = ["http://localhost:3000"];

export interface CorsValidationOptions {
  /** Whether CORS credentials (cookies / Authorization headers) are enabled. */
  credentials?: boolean;
}

/**
 * Validates a single CORS origin entry.
 *
 * Rejects:
 * - Wildcards (`*` or pattern wildcards like `*.example.com`).
 * - Wildcards specifically when credentials are enabled (prohibited by CORS spec and security best practice).
 * - Malformed URLs, non-http/https protocols, URLs containing paths, queries, or fragments.
 */
export function validateCorsOrigin(origin: string, options?: CorsValidationOptions): void {
  if (origin === "*" || origin.includes("*")) {
    if (options?.credentials) {
      throw new Error(
        `CORS configuration error: wildcard origin '${origin}' cannot be combined with credentials: true. Combining credentials with permissive origins enables cross-origin credential theft.`,
      );
    }
    throw new Error(
      `CORS configuration error: wildcard origin '${origin}' is not permitted. Explicitly declare allowed origins.`,
    );
  }

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(
      `CORS configuration error: origin '${origin}' is malformed. Origins must be valid absolute URLs (e.g. 'https://example.com').`,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `CORS configuration error: origin '${origin}' must use http: or https: scheme (received '${url.protocol}').`,
    );
  }

  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(
      `CORS configuration error: origin '${origin}' must not contain a path component (received path '${url.pathname}').`,
    );
  }

  if (origin.endsWith("/")) {
    throw new Error(
      `CORS configuration error: origin '${origin}' must not end with a trailing slash.`,
    );
  }

  if (url.search || url.hash) {
    throw new Error(
      `CORS configuration error: origin '${origin}' must not contain query parameters or fragments.`,
    );
  }

  if (url.username || url.password) {
    throw new Error(
      `CORS configuration error: origin '${origin}' must not contain user credentials.`,
    );
  }
}

/**
 * Validates an allowlist of CORS origins.
 */
export function validateCorsAllowlist(origins: string[], options?: CorsValidationOptions): void {
  for (const origin of origins) {
    validateCorsOrigin(origin, options);
  }
}

/**
 * Parses the `CORS_ORIGINS` env var (comma-separated) into an allowlist and validates each entry.
 *
 * Unset falls back to the local frontend; explicitly empty allows no browser
 * origin at all, which is the right default for a private deployment.
 */
export function parseCorsOrigins(raw: string | undefined, options?: CorsValidationOptions): string[] {
  if (raw === undefined) {
    validateCorsAllowlist(DEFAULT_CORS_ORIGINS, options);
    return [...DEFAULT_CORS_ORIGINS];
  }

  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  validateCorsAllowlist(origins, options);

  return origins;
}
