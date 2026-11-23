import type { LeaderboardRow } from "./types.js";
import type { Queryable } from "./markets.js";
import * as poolModule from "./pool.js";

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
 * Default executor for leaderboard reads.
 *
 * Rankings tolerate a few seconds of staleness, so they are replica-eligible.
 * The read pool falls back to the primary when no replica is configured, and
 * pins a request to the primary after it has written anything (see
 * `runWithReadSession` in db/pool.ts).
 */
function getDefaultReadDb(): Queryable {
  const readPool = (poolModule as { readPool?: Queryable }).readPool;
  if (!readPool) {
    throw new Error("read database is not configured");
  }
  return readPool;
}

/**
 * Fetches a paginated and sorted leaderboard from the database.
 *
 * Both call styles are supported:
 *   getLeaderboard(params)          // replica/primary read pool
 *   getLeaderboard(db, params)      // explicit executor (tests, transactions)
 */
export function getLeaderboard(params: GetLeaderboardParams): Promise<LeaderboardRow[]>;
export function getLeaderboard(
  db: Queryable,
  params: GetLeaderboardParams,
): Promise<LeaderboardRow[]>;
export async function getLeaderboard(
  dbOrParams: Queryable | GetLeaderboardParams,
  maybeParams?: GetLeaderboardParams,
): Promise<LeaderboardRow[]> {
  const params = maybeParams ?? (dbOrParams as GetLeaderboardParams);
  const db = maybeParams ? (dbOrParams as Queryable) : getDefaultReadDb();
  const { limit, offset, sort } = params;

  if (sort === "bets") {
    const query = `
      SELECT address, display_name, points, won_bets, lost_bets, updated_at
      FROM leaderboard
      ORDER BY (won_bets + lost_bets) DESC, address ASC
      LIMIT $1 OFFSET $2;
    `;
    const result = await db.query<LeaderboardRow>(query, [limit, offset]);
    return result.rows;
  }

  const query = `
    SELECT address, display_name, points, won_bets, lost_bets, updated_at
    FROM leaderboard
    ORDER BY points DESC, address ASC
    LIMIT $1 OFFSET $2;
  `;
  const result = await db.query<LeaderboardRow>(query, [limit, offset]);
  return result.rows;
}

export function getLeaderboardTotal(): Promise<number>;
export function getLeaderboardTotal(db: Queryable): Promise<number>;
export async function getLeaderboardTotal(
  db: Queryable = getDefaultReadDb(),
): Promise<number> {
  const result = await db.query<{ total: string }>(
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

  // A leaderboard mutation is still a write from the caller's perspective:
  // any read that follows it in the same session must observe it, so keep the
  // session on the primary. Optional access keeps this module usable when the
  // pool module is partially mocked.
  (poolModule as { markWrite?: () => void }).markWrite?.();

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
