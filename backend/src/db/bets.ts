// ── Types ─────────────────────────────────────────────────────────────────────

/** A single bet placed by a user on a market. */
export interface Bet {
  address: string;
  amount: number;
  isYes: boolean;
  claimed: boolean;
}

/** Paginated response from getBetsByMarket. */
export interface PaginatedBets {
  bets: Bet[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ── Module-private store ───────────────────────────────────────────────────────

const store = new Map<number, Bet[]>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Retrieve a paginated list of bets for a given market.
 *
 * @param marketId - The market to query (must be >= 0).
 * @param page     - 0-based page index (must be >= 0).
 * @param limit    - Number of bets per page (must be > 0).
 * @returns Paginated result with bets, total count, and page metadata.
 */
export function getBetsByMarket(
  marketId: number,
  page: number,
  limit: number
): PaginatedBets {
  const empty: PaginatedBets = {
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

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Seed bets for a market — for test use only. */
export function seedBets(marketId: number, bets: Bet[]): void {
  store.set(marketId, bets);
}

/** Clear all stored bets — for test isolation only. */
export function clearBets(): void {
  store.clear();
}
