import type { Queryable } from "./markets.js";
import type { OracleSubmissionRow } from "./types.js";

export type { Queryable };

// ── Outcome canonicalization (issue #650) ────────────────────────────────────

/**
 * The permitted outcome representations. Markets are binary, so this is a
 * closed two-value set. The canonical form is uppercase `YES` / `NO`
 * (chosen deliberately over the boolean-coerced `"true"`/`"false"` the
 * schema used to persist — existing rows are migrated to match in
 * `db/migrations/0017_oracle_outcome_canonical.sql`). A matching
 * `CHECK (outcome IN ('YES','NO'))` constraint enforces it at the database
 * regardless of the write path.
 */
export const CANONICAL_OUTCOMES = ["YES", "NO"] as const;
export type CanonicalOutcome = (typeof CANONICAL_OUTCOMES)[number];

const OUTCOME_ALIASES: Record<string, CanonicalOutcome> = {
  YES: "YES",
  Y: "YES",
  TRUE: "YES",
  "1": "YES",
  NO: "NO",
  N: "NO",
  FALSE: "NO",
  "0": "NO",
};

/**
 * Normalise a submitted outcome to its canonical form, or return `null` if it
 * is not a recognised binary outcome. Accepts booleans and case-insensitive,
 * whitespace-padded string spellings (`"yes"`, `"YES "`, `"true"`, `"1"`), so
 * every spelling of the same outcome persists identically.
 */
export function normalizeOutcome(raw: unknown): CanonicalOutcome | null {
  if (typeof raw === "boolean") return raw ? "YES" : "NO";
  if (typeof raw !== "string") return null;
  const key = raw.trim().toUpperCase();
  return OUTCOME_ALIASES[key] ?? null;
}

/** Type guard for an already-canonical outcome value. */
export function isCanonicalOutcome(value: unknown): value is CanonicalOutcome {
  return typeof value === "string" && (CANONICAL_OUTCOMES as readonly string[]).includes(value);
}

// ── Provider registry ────────────────────────────────────────────────────────

let providerCache: Set<string> | null = null;
let providerCacheExpiry = 0;
const PROVIDER_CACHE_TTL_MS = 60_000;

export async function isRegisteredProvider(
  address: string,
  db?: Queryable,
): Promise<boolean> {
  if (providerCache && Date.now() < providerCacheExpiry) {
    return providerCache.has(address);
  }

  const executor = db ?? pool;
  if (!executor) throw new Error("Database pool is not initialized");

  const result = await executor.query<{ address: string }>(
    "SELECT address FROM oracle_providers WHERE active = TRUE",
  );
  providerCache = new Set(result.rows.map((r) => r.address));
  providerCacheExpiry = Date.now() + PROVIDER_CACHE_TTL_MS;
  return providerCache.has(address);
}

export function invalidateProviderCache(): void {
  providerCache = null;
  providerCacheExpiry = 0;
}

// ── Idempotency ─────────────────────────────────────────────────────────────

export interface IdempotencyRecord {
  payload_hash: string;
  response_body: unknown;
  status_code: number;
}

export async function getIdempotencyRecord(
  key: string,
  db?: Queryable,
): Promise<IdempotencyRecord | null> {
  const executor = db ?? pool;
  if (!executor) throw new Error("Database pool is not initialized");

  const result = await executor.query<IdempotencyRecord>(
    "SELECT payload_hash, response_body, status_code FROM idempotency_keys WHERE idempotency_key = $1",
    [key],
  );
  return result.rows[0] ?? null;
}

export async function storeIdempotencyRecord(
  key: string,
  payloadHash: string,
  responseBody: unknown,
  statusCode: number,
  db?: Queryable,
): Promise<void> {
  const executor = db ?? pool;
  if (!executor) throw new Error("Database pool is not initialized");

  await executor.query(
    `INSERT INTO idempotency_keys (idempotency_key, payload_hash, response_body, status_code)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [key, payloadHash, JSON.stringify(responseBody), statusCode],
  );
}

export async function cleanupExpiredIdempotencyKeys(
  retentionSeconds: number,
  db?: Queryable,
): Promise<number> {
  const executor = db ?? pool;
  if (!executor) throw new Error("Database pool is not initialized");

  const cutoff = new Date(Date.now() - retentionSeconds * 1000);
  const result = await executor.query(
    "DELETE FROM idempotency_keys WHERE created_at < $1",
    [cutoff],
  );
  return (result as any).rowCount ?? 0;
}

export type RecordOracleSubmissionInput = {
  marketId: number;
  provider: string;
  outcome: string;
  bondAmount?: string | number;
  nonce?: string;
  requestTimestamp?: Date;
};

export async function recordOracleSubmission(
  input: RecordOracleSubmissionInput,
  db: Queryable,
): Promise<OracleSubmissionRow> {
  const bondAmountStr = String(input.bondAmount ?? "0");

  // Defence in depth (issue #650): the API schema already canonicalises, but
  // never write a non-canonical outcome even if a future caller forgets to.
  const canonicalOutcome = normalizeOutcome(input.outcome);
  if (canonicalOutcome === null) {
    throw new Error(
      `recordOracleSubmission: outcome "${input.outcome}" is not one of ${CANONICAL_OUTCOMES.join(", ")}`,
    );
  }

  const queryText = `
    INSERT INTO oracle_submissions (market_id, submitter, outcome, bond_amount, status, nonce, request_timestamp)
    VALUES ($1, $2, $3, $4, 'submitted', $5, $6)
    RETURNING id, market_id, submitter, outcome, bond_amount, submitted_at, status
  `;

  const result = await db.query<OracleSubmissionRow>(queryText, [
    input.marketId,
    input.provider,
    canonicalOutcome,
    bondAmountStr,
    input.nonce ?? null,
    input.requestTimestamp ?? null,
  ]);

  return result.rows[0];
}

export async function getOracleSubmissionsCount(
  marketId: number,
  db: Queryable,
): Promise<number> {
  const queryText = `
    SELECT COUNT(*)::text AS count
    FROM oracle_submissions
    WHERE market_id = $1 AND status = 'submitted'
  `;

  const result = await db.query<{ count: string }>(queryText, [marketId]);
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Check if a nonce has been used before.
 * Returns true if the nonce exists in the database.
 */
export async function hasNonceBeenUsed(
  nonce: string,
  db: Queryable,
): Promise<boolean> {
  const queryText = `
    SELECT 1
    FROM oracle_submissions
    WHERE nonce = $1
    LIMIT 1
  `;

  const result = await db.query(queryText, [nonce]);
  return result.rows.length > 0;
}

/**
 * Clean up expired nonces based on retention period.
 * Removes nonces older than the retention window to prevent unbounded growth.
 */
export async function cleanupExpiredNonces(
  retentionSeconds: number,
  db: Queryable,
): Promise<number> {
  const executor = db ?? pool;
  if (!executor) throw new Error("Database pool is not initialized");

  const cutoffTime = new Date(Date.now() - retentionSeconds * 1000);

  const queryText = `
    DELETE FROM oracle_submissions
    WHERE nonce IS NOT NULL
      AND request_timestamp < $1
    RETURNING id
  `;

  const result = await executor.query<{ id: number }>(queryText, [cutoffTime]);
  return result.rows.length;
}
