import type { Queryable } from "./db.js";

export interface MarketTotals {
  total_yes: bigint | number | string;
  total_no: bigint | number | string;
}

export interface MarketTotalsDrift {
  marketId: string;
  database: { total_yes: string; total_no: string };
  onChain: { total_yes: string; total_no: string };
}

export interface TotalsRecomputeOptions {
  /** Optional read-only contract view. Runs after the SQL reconciliation. */
  getOnChainTotals?: (marketId: string) => Promise<MarketTotals>;
  /** Called once for every market whose recomputed totals differ from chain. */
  onDrift?: (drift: MarketTotalsDrift) => void;
}

export interface TotalsRecomputeResult {
  checked: number;
  corrected: number;
  /** Number of markets actually checked against the chain (0 by default). */
  onChainChecked?: number;
  drift?: MarketTotalsDrift[];
}

function normalizedAmount(value: bigint | string | number): string {
  // Never compare money through floating point. BIGINT/NUMERIC values arrive
  // from pg as decimal strings; a contract view should return integer stroops.
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("Unsafe numeric total: expected bigint or decimal string");
  }
  const amount = BigInt(value);
  if (amount < 0n) throw new Error("Market totals must be non-negative");
  return amount.toString();
}

/**
 * Rebuild market totals from bets, including markets with NO bets (both totals
 * become zero). An optional read-only verifier compares the resulting DB
 * snapshots to `get_market` on chain, without changing on-chain state.
 */
export async function recomputeMarketTotalsFromBets(
  db: Queryable,
  options: TotalsRecomputeOptions = {},
): Promise<TotalsRecomputeResult> {
  const result = await db.query<{ id: string | number }>(
    `WITH totals AS (
       SELECT market_id,
         COALESCE(SUM(CASE WHEN is_yes THEN net_amount ELSE 0 END), 0) AS total_yes,
         COALESCE(SUM(CASE WHEN NOT is_yes THEN net_amount ELSE 0 END), 0) AS total_no
       FROM bets
       GROUP BY market_id
     ), expected AS (
       SELECT m.id, COALESCE(t.total_yes, 0) AS total_yes,
         COALESCE(t.total_no, 0) AS total_no
       FROM markets m
       LEFT JOIN totals t ON t.market_id = m.id
     ), updated AS (
       UPDATE markets m
       SET total_yes = e.total_yes, total_no = e.total_no, updated_at = NOW()
       FROM expected e
       WHERE m.id = e.id
         AND (m.total_yes IS DISTINCT FROM e.total_yes OR m.total_no IS DISTINCT FROM e.total_no)
       RETURNING m.id
     )
     SELECT id FROM updated`
  );

  const count = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM markets`);
  const summary: TotalsRecomputeResult = {
    checked: Number(count.rows[0]?.count ?? 0),
    corrected: result.rows.length,
  };
  if (!options.getOnChainTotals) return summary;

  const snapshot = await db.query<{
    id: string | number;
    total_yes: string;
    total_no: string;
  }>(`SELECT id, total_yes::text AS total_yes, total_no::text AS total_no FROM markets ORDER BY id`);

  const drift: MarketTotalsDrift[] = [];
  for (const row of snapshot.rows) {
    const marketId = String(row.id);
    const chain = await options.getOnChainTotals(marketId);
    const database = {
      total_yes: normalizedAmount(row.total_yes),
      total_no: normalizedAmount(row.total_no),
    };
    const onChain = {
      total_yes: normalizedAmount(chain.total_yes),
      total_no: normalizedAmount(chain.total_no),
    };
    if (database.total_yes !== onChain.total_yes || database.total_no !== onChain.total_no) {
      const mismatch = { marketId, database, onChain };
      drift.push(mismatch);
      options.onDrift?.(mismatch);
    }
  }
  return { ...summary, onChainChecked: snapshot.rows.length, drift };
}
