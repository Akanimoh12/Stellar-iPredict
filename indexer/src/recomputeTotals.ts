import type { Queryable } from "./db.js";

export interface TotalsRecomputeResult {
  checked: number;
  corrected: number;
}

export async function recomputeMarketTotalsFromBets(db: Queryable): Promise<TotalsRecomputeResult> {
  const result = await db.query<{ id: string | number }>(
    `WITH totals AS (
       SELECT
         market_id,
         COALESCE(SUM(CASE WHEN is_yes THEN net_amount ELSE 0 END), 0) AS total_yes,
         COALESCE(SUM(CASE WHEN NOT is_yes THEN net_amount ELSE 0 END), 0) AS total_no
       FROM bets
       GROUP BY market_id
     ), updated AS (
       UPDATE markets m
       SET total_yes = COALESCE(t.total_yes, 0),
           total_no = COALESCE(t.total_no, 0),
           updated_at = NOW()
       FROM totals t
       WHERE m.id = t.market_id
         AND (m.total_yes IS DISTINCT FROM t.total_yes OR m.total_no IS DISTINCT FROM t.total_no)
       RETURNING m.id
     )
     SELECT id FROM updated`
  );

  const count = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM markets`);
  return { checked: Number(count.rows[0]?.count ?? 0), corrected: result.rows.length };
}
