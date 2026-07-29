import { computeTally, type MarketTally, type QueryablePool } from "./tally.js";
import type { CouncilVote } from "./threshold.js";

/**
 * A single, self-contained audit record for one finalized market: the council
 * votes that were cast, the derived tally, and the decision that was recorded.
 *
 * This is the unit exported for audit. It is intentionally denormalised so a
 * reviewer needs nothing beyond one row/object to reconstruct how a market was
 * decided.
 */
export interface CouncilAuditRecord {
  marketId: string;
  decision: string | null;
  txHash: string | null;
  finalizedAt: string | null;
  yesVotes: number;
  noVotes: number;
  totalVoters: number;
  votes: readonly CouncilVote[];
}

/** Raw inputs needed to build one audit record. */
export interface CouncilAuditInput {
  marketId: string;
  votes: readonly CouncilVote[];
  decision?: string | null;
  txHash?: string | null;
  finalizedAt?: string | null;
}

/**
 * Builds an audit record, deriving the tally from the votes with the same
 * de-duplication rules the finalizer used (`computeTally`), so the exported
 * tallies match what the council actually decided on.
 */
export function buildAuditRecord(input: CouncilAuditInput): CouncilAuditRecord {
  const tally: MarketTally = computeTally(input.marketId, input.votes);
  return {
    marketId: tally.marketId,
    decision: input.decision ?? null,
    txHash: input.txHash ?? null,
    finalizedAt: input.finalizedAt ?? null,
    yesVotes: tally.yesVotes,
    noVotes: tally.noVotes,
    totalVoters: tally.totalVoters,
    votes: tally.votes,
  };
}

/** Serialises audit records to pretty-printed JSON. */
export function toAuditJson(records: readonly CouncilAuditRecord[]): string {
  return JSON.stringify(records, null, 2);
}

const CSV_COLUMNS = [
  "market_id",
  "decision",
  "tx_hash",
  "finalized_at",
  "yes_votes",
  "no_votes",
  "total_voters",
  "votes",
] as const;

function escapeCsv(value: string): string {
  // Quote whenever the value could otherwise break the row/column structure.
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function votesCell(votes: readonly CouncilVote[]): string {
  // Compact, stable "member=yes|member=no" encoding so a single CSV cell stays
  // human-readable without needing a second joined export.
  return votes.map((vote) => `${vote.member}=${vote.outcome ? "yes" : "no"}`).join("|");
}

/** Serialises audit records to CSV with a stable header row. */
export function toAuditCsv(records: readonly CouncilAuditRecord[]): string {
  const rows: string[] = [CSV_COLUMNS.join(",")];
  for (const record of records) {
    const cells = [
      record.marketId,
      record.decision ?? "",
      record.txHash ?? "",
      record.finalizedAt ?? "",
      String(record.yesVotes),
      String(record.noVotes),
      String(record.totalVoters),
      votesCell(record.votes),
    ];
    rows.push(cells.map((cell) => escapeCsv(cell)).join(","));
  }
  // Trailing newline so appending/concatenating exports stays well-formed.
  return `${rows.join("\n")}\n`;
}

interface FinalizedMarketRow extends Record<string, unknown> {
  market_id: string;
  decision: string | null;
  tx_hash: string | null;
  finalized_at: string | null;
}

interface CouncilVoteRow extends Record<string, unknown> {
  market_id: string;
  member: string;
  outcome: boolean;
}

/**
 * Reads finalized decisions and their council votes from Postgres and builds
 * one audit record per finalized market.
 *
 * Only finalized markets are exported (`status = 'finalized'`), so the audit
 * reflects committed decisions rather than in-flight submissions.
 */
export async function collectCouncilAudit(pool: QueryablePool): Promise<CouncilAuditRecord[]> {
  const finalized = await pool.query<FinalizedMarketRow>(
    `SELECT market_id::text AS market_id,
            decision,
            tx_hash,
            finalized_at::text AS finalized_at
       FROM oracle_submissions
      WHERE status = 'finalized'
      ORDER BY market_id ASC`,
  );

  const votes = await pool.query<CouncilVoteRow>(
    `SELECT market_id::text AS market_id, member, outcome
       FROM council_votes
      ORDER BY market_id ASC, member ASC`,
  );

  const votesByMarket = new Map<string, CouncilVote[]>();
  for (const row of votes.rows) {
    const bucket = votesByMarket.get(row.market_id) ?? [];
    bucket.push({ member: row.member, outcome: row.outcome });
    votesByMarket.set(row.market_id, bucket);
  }

  return finalized.rows.map((row) =>
    buildAuditRecord({
      marketId: row.market_id,
      votes: votesByMarket.get(row.market_id) ?? [],
      decision: row.decision,
      txHash: row.tx_hash,
      finalizedAt: row.finalized_at,
    }),
  );
}

export type AuditFormat = "csv" | "json";

/** Collects the council audit and serialises it in the requested format. */
export async function exportCouncilAudit(pool: QueryablePool, format: AuditFormat): Promise<string> {
  const records = await collectCouncilAudit(pool);
  return format === "csv" ? toAuditCsv(records) : toAuditJson(records);
}
