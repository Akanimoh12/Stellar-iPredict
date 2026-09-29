import type { Queryable } from "./db.js";

export interface BetCountRecomputeResult {
  checked: number;
  corrected: number;
}

/**
 * Recompute `markets.bet_count` for every market from the authoritative `bets`
 * table. The `bets` table is keyed on `(market_id, bettor)`, so one row per
 * bettor per market — `COUNT(*)` therefore yields the number of bettors, which
 * is what `bet_count` represents (see the backend `bettors` sort).
 *
 * Markets with no bets are reset to 0 so drift in either direction is healed.
 * Only rows whose stored value differs from the recomputed value are written.
 */
export async function recomputeMarketBetCountsFromBets(db: Queryable): Promise<BetCountRecomputeResult> {
  const result = await db.query<{ id: string | number }>(
    `WITH counts AS (
       SELECT market_id, COUNT(*)::int AS bet_count
       FROM bets
       GROUP BY market_id
     ), expected AS (
       SELECT m.id, COALESCE(c.bet_count, 0) AS bet_count
       FROM markets m
       LEFT JOIN counts c ON c.market_id = m.id
     ), updated AS (
       UPDATE markets m
       SET bet_count = e.bet_count,
           updated_at = NOW()
       FROM expected e
       WHERE m.id = e.id
         AND m.bet_count IS DISTINCT FROM e.bet_count
       RETURNING m.id
     )
     SELECT id FROM updated`
  );

  const count = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM markets`);
  return { checked: Number(count.rows[0]?.count ?? 0), corrected: result.rows.length };
}
