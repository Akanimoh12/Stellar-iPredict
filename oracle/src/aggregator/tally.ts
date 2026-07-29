import type { CouncilVote } from "./threshold.js";

export interface MarketTally {
  marketId: string;
  yesVotes: number;
  noVotes: number;
  totalVoters: number;
  /** De-duplicated votes (one per member, latest wins). */
  votes: readonly CouncilVote[];
}

export interface SubmissionStore {
  /** Persists (or overwrites) a member's outcome for a market. */
  recordSubmission(marketId: string, member: string, outcome: boolean): Promise<void>;
  /** All current submissions for a market — at most one per member. */
  getSubmissions(marketId: string): Promise<CouncilVote[]>;
}

/**
 * Pure aggregation over a market's current submissions.
 *
 * De-duplicates by member (latest vote wins), consistent with
 * `selectThresholdOutcome` and `detectConflict`, so every consumer of
 * council votes agrees on the same tally.
 */
export function computeTally(marketId: string, votes: readonly CouncilVote[]): MarketTally {
  const votesByMember = new Map<string, boolean>();
  for (const vote of votes) {
    const member = vote.member.trim();
    if (member) votesByMember.set(member, vote.outcome);
  }

  let yes = 0;
  let no = 0;
  for (const outcome of votesByMember.values()) {
    if (outcome) yes += 1;
    else no += 1;
  }

  return {
    marketId,
    yesVotes: yes,
    noVotes: no,
    totalVoters: yes + no,
    votes: [...votesByMember.entries()].map(([member, outcome]) => ({ member, outcome })),
  };
}

/**
 * Tracks council submissions per market and exposes the current tally.
 *
 * Persistence is delegated to a `SubmissionStore` so the finalizer reads a
 * durable, de-duplicated view regardless of process restarts, and so a
 * member re-submitting never double-counts their vote.
 */
export class SubmissionTracker {
  constructor(private readonly store: SubmissionStore) {}

  async submit(marketId: string, member: string, outcome: boolean): Promise<void> {
    const trimmedMarket = marketId.trim();
    const trimmedMember = member.trim();
    if (!trimmedMarket) throw new Error("marketId is required");
    if (!trimmedMember) throw new Error("member is required");
    await this.store.recordSubmission(trimmedMarket, trimmedMember, outcome);
  }

  async getTally(marketId: string): Promise<MarketTally> {
    const votes = await this.store.getSubmissions(marketId);
    return computeTally(marketId, votes);
  }
}

export interface QueryablePool {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/** Postgres-backed `SubmissionStore` against the `council_votes` table. */
export function createPostgresSubmissionStore(pool: QueryablePool): SubmissionStore {
  return {
    async recordSubmission(marketId, member, outcome) {
      await pool.query(
        `INSERT INTO council_votes (market_id, member, outcome)
         VALUES ($1, $2, $3)
         ON CONFLICT (market_id, member)
         DO UPDATE SET outcome = EXCLUDED.outcome, submitted_at = NOW()`,
        [marketId, member, outcome],
      );
    },
    async getSubmissions(marketId) {
      const result = await pool.query<{ member: string; outcome: boolean }>(
        `SELECT member, outcome FROM council_votes WHERE market_id = $1`,
        [marketId],
      );
      return result.rows.map((row) => ({ member: row.member, outcome: row.outcome }));
    },
  };
}
