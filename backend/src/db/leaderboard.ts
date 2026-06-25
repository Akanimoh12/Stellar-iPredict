// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Module-private store ───────────────────────────────────────────────────────

const store = new Map<string, LeaderboardEntry>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateId(): string {
  return `lb_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Insert or update a leaderboard entry.
 *
 * - If the player does not exist, creates a new entry.
 * - Adds `pointsDelta` to the current points.
 * - Increments `won` when `outcome` is `"won"`, otherwise increments `lost`.
 *
 * @param address    - Stellar account address (must be non-empty).
 * @param pointsDelta - Points to add (must be >= 0).
 * @param outcome    - Whether the player won or lost.
 * @returns `TransactionResult` indicating success or failure.
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

/** Retrieve the current leaderboard entry for a player (or undefined). */
export function getLeaderboardEntry(
  address: string
): LeaderboardEntry | undefined {
  const entry = store.get(address);
  return entry ? { ...entry } : undefined;
}

/** Clear all entries — for test isolation only. */
export function clearLeaderboard(): void {
  store.clear();
}
