import { Pool } from "pg";
import type { BetRow } from "./types.js";
import type { Queryable } from "./markets.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single bet placed by a user on a market (in-memory store shape). */
export interface Bet {
  address: string;
  amount: number;
  isYes: boolean;
  claimed: boolean;
}

/** Paginated response from getBetsByMarket (in-memory) or getBetsByMarketFromDb. */
export interface PaginatedBets {
  bets: BetRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// Re-export for backwards compatibility
export type { BetRow };

// ── Module-private in-memory store (used by tests) ────────────────────────────

const store = new Map<number, Bet[]>();

/** In-memory paginated bets — used by unit tests and the stats aggregator. */
export interface InMemoryPaginatedBets {
  bets: Bet[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Retrieve a paginated list of bets for a given market from the in-memory store.
 *
 * @param marketId - The market to query (must be >= 0).
 * @param page     - 0-based page index (must be >= 0).
 * @param limit    - Number of bets per page (must be > 0).
 */
export function getBetsByMarket(
  marketId: number,
  page: number,
  limit: number,
): InMemoryPaginatedBets {
  const empty: InMemoryPaginatedBets = {
    bets: [],
    total: 0,
    page,
    limit,
    totalPages: 0,
  };

  if (typeof marketId !== "number" || marketId < 0) return empty;
  if (typeof page !== "number" || page < 0) return empty;
  if (typeof limit !== "number" || limit <= 0) return empty;

  const bets = store.get(marketId) ?? [];
  const total = bets.length;
  const totalPages = Math.ceil(total / limit);
  const offset = page * limit;
  const sliced = bets.slice(offset, offset + limit);

  return { bets: sliced, total, page, limit, totalPages };
}

// ── DB-backed public API ──────────────────────────────────────────────────────

/**
 * Retrieve a paginated list of bets for a given market from the database.
 *
 * This is the primary production function — used by the cached API route.
 *
 * @param marketId - The market to query (positive integer).
 * @param page     - 1-based page index (must be >= 1).
 * @param limit    - Number of bets per page (must be between 1 and 100).
 * @param db       - A {@link Queryable} instance (defaults to the shared pool).
 * @returns Paginated result with bets, total count, and page metadata.
 */
export async function getBetsByMarketFromDb(
  marketId: number,
  page: number,
  limit: number,
  db: Queryable,
): Promise<PaginatedBets> {
  const offset = (page - 1) * limit;

  const [{ rows: bets }, { rows: countRows }] = await Promise.all([
    db.query<BetRow>(
      `SELECT market_id, bettor, net_amount, gross_amount, is_yes, claimed, created_at
         FROM bets
        WHERE market_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [marketId, limit, offset],
    ),
    db.query<{ total: number }>(
      `SELECT COUNT(*)::INT AS total FROM bets WHERE market_id = $1`,
      [marketId],
    ),
  ]);

  const total = countRows[0]?.total ?? 0;
  const totalPages = Math.ceil(total / limit);

  return { bets, total, page, limit, totalPages };
}

/**
 * Fetches all bets placed by a specific bettor.
 *
 * @param pool    Database pool connection
 * @param address The Stellar public key (address) of the bettor
 * @returns Array of bets made by the given bettor
 */
export async function getBetsByBettor(
  pool: Pool,
  address: string,
): Promise<BetRow[]> {
  const query = `
    SELECT market_id, bettor, net_amount, gross_amount, is_yes, claimed, created_at
    FROM bets
    WHERE bettor = $1
    ORDER BY created_at DESC;
  `;

  const result = await pool.query<BetRow>(query, [address]);
  return result.rows;
}

/**
 * Return all bets across every market, each tagged with its market id.
 * Useful for cross-cutting aggregations (stats, admin reports, etc.).
 */
export function getAllBets(): { marketId: number; bet: Bet }[] {
  const result: { marketId: number; bet: Bet }[] = [];
  for (const [marketId, bets] of store) {
    for (const bet of bets) {
      result.push({ marketId, bet });
    }
  }
  return result;
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Seed bets for a market — for test use only. */
export function seedBets(marketId: number, bets: Bet[]): void {
  store.set(marketId, bets);
}

/** Clear all stored bets — for test isolation only. */
export function clearBets(): void {
  store.clear();
}
