import { Pool } from "pg";
import type { LeaderboardRow } from "./types.js";

export type SortOption = "points" | "bets";

export interface GetLeaderboardParams {
  limit: number;
  offset: number;
  sort: SortOption;
}

// Re-export for backwards compatibility
export type { LeaderboardRow };

/** Persistent leaderboard record for a single player (in-memory store shape). */
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

// ── Module-private in-memory store (used by tests) ────────────────────────────

const store = new Map<string, LeaderboardEntry>();

// ── DB-backed public API ──────────────────────────────────────────────────────

/**
 * Fetches a paginated and sorted leaderboard from the database.
 */
export async function getLeaderboard(
  pool: Pool,
  params: GetLeaderboardParams,
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

export async function getLeaderboardTotal(pool: Pool): Promise<number> {
  const result = await pool.query<{ total: string }>(
    "SELECT COUNT(*)::text AS total FROM leaderboard;",
    [],
  );
  return Number(result.rows[0]?.total ?? 0);
}

// ── In-memory helpers (used by tests and stats aggregation) ──────────────────

function generateId(): string {
  return `lb_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Insert or update an in-memory leaderboard entry.
 * Adds `pointsDelta` to the current points and increments won/lost.
 */
export function upsertLeaderboardEntry(
  address: string,
  pointsDelta: number,
  outcome: "won" | "lost",
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

/** Retrieve the current in-memory leaderboard entry for a player (or undefined). */
export function getLeaderboardEntry(address: string): LeaderboardEntry | undefined {
  const entry = store.get(address);
  return entry ? { ...entry } : undefined;
}

/** Return every in-memory leaderboard entry (shallow copies). */
export function getAllLeaderboardEntries(): LeaderboardEntry[] {
  return Array.from(store.values()).map((e) => ({ ...e }));
}

/** Clear all in-memory entries — for test isolation only. */
export function clearLeaderboard(): void {
  store.clear();
}
