import { Pool } from "pg";

export type SortOption = "points" | "bets";

export interface GetLeaderboardParams {
  limit: number;
  offset: number;
  sort: SortOption;
}

export interface LeaderboardRow {
  address: string;
  display_name: string | null;
  points: string;
  won_bets: number;
  lost_bets: number;
  updated_at: Date;
}

/** Persistent leaderboard record for a single player. */
export interface LeaderboardEntry {
  address: string;
  points: number;
  won: number;
  lost: number;
}

/** Outcome of an upsert operation. */
export interface TransactionResult {
  success: boolean;
  hash?: string;
  error?: string;
}

const store = new Map<string, LeaderboardEntry>();

function generateId(): string {
  return `lb_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Fetches a paginated and sorted leaderboard.
 *
 * @param pool Database pool connection
 * @param params Pagination and sorting parameters
 * @returns Array of leaderboard entries
 */
export async function getLeaderboard(
  pool: Pool,
  params: GetLeaderboardParams
): Promise<LeaderboardRow[]> {
  const { limit, offset, sort } = params;

  if (sort === "bets") {
    const query = `
      SELECT address, display_name, points, won_bets, lost_bets, updated_at
      FROM leaderboard
      ORDER BY (won_bets + lost_bets) DESC
      LIMIT $1 OFFSET $2;
    `;
    const result = await pool.query<LeaderboardRow>(query, [limit, offset]);
    return result.rows;
  }

  const query = `
    SELECT address, display_name, points, won_bets, lost_bets, updated_at
    FROM leaderboard
    ORDER BY points DESC
    LIMIT $1 OFFSET $2;
  `;
  const result = await pool.query<LeaderboardRow>(query, [limit, offset]);
  return result.rows;
}

/**
 * Insert or update a leaderboard entry.
 */
export function upsertLeaderboardEntry(
  address: string,
  pointsDelta: number,
  outcome: "won" | "lost"
): TransactionResult {
  if (!address || address.trim().length === 0) {
    return { success: false, error: "address is required" };
  }

  if (typeof pointsDelta !== "number" || pointsDelta < 0) {
    return { success: false, error: "pointsDelta must be a non-negative number" };
  }

  const existing = store.get(address);
  const entry: LeaderboardEntry = existing
    ? { ...existing }
    : { address, points: 0, won: 0, lost: 0 };

  entry.points += pointsDelta;
  if (outcome === "won") {
    entry.won += 1;
  } else {
    entry.lost += 1;
  }

  store.set(address, entry);

  return { success: true, hash: generateId() };
}

export function getLeaderboardEntry(
  address: string
): LeaderboardEntry | undefined {
  const entry = store.get(address);
  return entry ? { ...entry } : undefined;
}

export function clearLeaderboard(): void {
  store.clear();
}
