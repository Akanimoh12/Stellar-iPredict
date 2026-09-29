import type { QueryablePool } from "./tally.js";

export interface BondDashboardData {
  totalBondedXLM: bigint;
  atRiskMarkets: string[];
}

interface PostgresBondRow extends Record<string, unknown> {
  market_id: string;
  bond_amount: string | number;
  status: string;
}

export async function getBondDashboardData(
  pool: QueryablePool,
  requiredMinimumBond: bigint = 100_0000000n,
): Promise<BondDashboardData> {
  const result = await pool.query<PostgresBondRow>(
    `SELECT market_id::text AS market_id,
            bond_amount,
            status
       FROM oracle_submissions
      WHERE status IN ('submitted', 'pending', 'challenged', 'escalated')`,
  );

  let totalBondedXLM = 0n;
  const atRiskMarkets = new Set<string>();

  for (const row of result.rows) {
    const bond = BigInt(row.bond_amount);
    totalBondedXLM += bond;

    // A market is considered "at risk" if it is challenged/escalated OR if its bond is below the required minimum
    if (
      row.status === "challenged" ||
      row.status === "escalated" ||
      bond < requiredMinimumBond
    ) {
      atRiskMarkets.add(row.market_id);
    }
  }

  return {
    totalBondedXLM,
    atRiskMarkets: Array.from(atRiskMarkets),
  };
}
