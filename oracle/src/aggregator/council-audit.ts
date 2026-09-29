import { computeTally, type MarketTally, type QueryablePool } from "./tally.js";
import type { CouncilVote } from "./threshold.js";
import type { RawPayloadSink, SourceResult } from "../adapters/resolve.js";

/**
 * Retention policy for council audit data (issue #646).
 *
 * Council votes, finalized `oracle_submissions` and `oracle_disputes` are
 * **audit-class**, not operational: they are the record of how a market
 * resolved and who decided it. A dispute or legal inquiry about a resolution
 * can surface long after the event, so this window is set deliberately long
 * and independently of the operational purge — `enforce_data_retention()`
 * never touches these tables.
 *
 * `adapter_raw_payloads` (migration `0028_adapter_raw_payloads`) is audit-class
 * under the same window, and for the same reason: it is the only record of what
 * a provider actually returned at resolution time.
 *
 * `RETENTION_YEARS` is a placeholder for a legal/compliance decision; bump it
 * there, not by ad-hoc deletion. The canonical policy lives in
 * `db/migrations/0018_data_retention.sql` and docs/DATA-RETENTION.md.
 */
export const COUNCIL_AUDIT_RETENTION = {
  class: "audit" as const,
  retentionYears: 7,
  /** Purge is a manual, reviewed operation — there is no automatic job. */
  automaticEnforcement: false,
} as const;

/**
 * Per-row cap on a stored raw payload, mirroring `max_raw_payload_bytes()` in
 * `db/migrations/0028_adapter_raw_payloads.sql`.
 *
 * Enforced here as well as in the schema because the check constraint can only
 * reject a row, whereas the writer needs to *shorten* the payload and mark the
 * record truncated. A provider returning an unexpectedly large body must not be
 * able to fill the disk through the audit path — and a truncated record must say
 * so, rather than being indistinguishable from a complete one.
 */
export const MAX_RAW_PAYLOAD_BYTES = 1_048_576;

/**
 * Whether an audit record finalized at `finalizedAt` is old enough to be
 * *eligible* for deletion under the retention window. Even when this returns
 * `true`, removal is a manual, reviewed step — nothing calls it from a job.
 * Returns `false` for a missing/invalid timestamp so an unknown record is
 * never treated as purgeable.
 */
export function isCouncilAuditRecordPurgeable(
  finalizedAt: string | null | undefined,
  now: Date = new Date(),
  retentionYears: number = COUNCIL_AUDIT_RETENTION.retentionYears,
): boolean {
  if (!finalizedAt) return false;
  const finalized = new Date(finalizedAt);
  if (Number.isNaN(finalized.getTime())) return false;
  const cutoff = new Date(now);
  cutoff.setFullYear(cutoff.getFullYear() - retentionYears);
  return finalized < cutoff;
}

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
  /**
   * Raw provider payloads that backed this decision, in fetch order.
   *
   * Empty (rather than absent) for markets resolved before
   * `adapter_raw_payloads` existed, so a consumer can tell "no payload was
   * recorded" from "payloads were not requested".
   */
  rawPayloads: readonly RawPayloadRecord[];
}

/**
 * One provider response, as persisted for audit/dispute review.
 *
 * Mirrors one row of `adapter_raw_payloads`. `truncated` matters: it marks a
 * record whose payload hit `MAX_RAW_PAYLOAD_BYTES` and was stored shortened, so
 * a reviewer never treats a partial payload as the provider's full response.
 */
export interface RawPayloadRecord {
  /** Provider/adapter identity, e.g. `"binance"`. */
  provider: string;
  /** The request that produced this response, after credential redaction. */
  request: unknown;
  /** The provider's response body, verbatim. */
  response: unknown;
  /** Uncompressed size of `response` in bytes. */
  responseBytes: number;
  /** True when `response` was shortened to respect `MAX_RAW_PAYLOAD_BYTES`. */
  truncated: boolean;
  /** What the provider reported, and the confidence the oracle derived. */
  outcome: boolean | null;
  confidence: number | null;
  /** When the provider responded (ISO-8601). */
  respondedAt: string | null;
  /** When the payload was persisted (ISO-8601). */
  receivedAt: string | null;
}

/** Raw inputs needed to build one audit record. */
export interface CouncilAuditInput {
  marketId: string;
  votes: readonly CouncilVote[];
  decision?: string | null;
  txHash?: string | null;
  finalizedAt?: string | null;
  /** Raw provider payloads backing this decision. */
  rawPayloads?: readonly RawPayloadRecord[];
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
    rawPayloads: input.rawPayloads ?? [],
  };
}

// ---------------------------------------------------------------------------
// Raw payload persistence
// ---------------------------------------------------------------------------

/** Measures the uncompressed JSON size of a payload, as the schema records it. */
export function rawPayloadByteLength(payload: unknown): number {
  const encoded = JSON.stringify(payload ?? null);
  return Buffer.byteLength(encoded ?? "null", "utf8");
}

/**
 * Shortens a payload that exceeds `MAX_RAW_PAYLOAD_BYTES`.
 *
 * Returns the payload unchanged when it fits. Otherwise replaces it with a
 * marker object describing what was dropped and sets `truncated` — the record
 * stays truthful about being incomplete, which a silently clipped payload would
 * not be. JSON is not sliced mid-token (a partial string would not parse and
 * would make the stored evidence unusable).
 */
export function boundRawPayload(payload: unknown): { response: unknown; responseBytes: number; truncated: boolean } {
  const responseBytes = rawPayloadByteLength(payload);
  if (responseBytes <= MAX_RAW_PAYLOAD_BYTES) {
    return { response: payload, responseBytes, truncated: false };
  }

  return {
    response: {
      truncated: true,
      reason: `payload of ${responseBytes} bytes exceeded the ${MAX_RAW_PAYLOAD_BYTES} byte audit limit`,
      // Enough of the head to identify which provider/endpoint answered.
      preview: JSON.stringify(payload ?? null).slice(0, 2048),
    },
    // Recorded against the *original* size so the bound is what was measured,
    // not the size of the substitute.
    responseBytes,
    truncated: true,
  };
}

/**
 * Persists the raw provider payloads for one resolution decision.
 *
 * Append-only: every provider consulted during a resolution gets its own row,
 * including a provider consulted more than once. Overwriting in place would
 * destroy the observation that was actually in hand at decision time, which is
 * the whole evidentiary value of the record.
 *
 * Payloads are expected to have been credential-redacted by the adapter layer
 * (`sanitizeProvenanceValue`) before reaching here; this function stores what
 * it is given.
 */
export async function persistRawPayloads(
  pool: QueryablePool,
  marketId: string,
  sources: readonly SourceResult[],
): Promise<number> {
  const rows: Array<[string, string, unknown, unknown, number, boolean, boolean | null, number | null, string | null]> = [];

  for (const source of sources) {
    // A source that errored has no response to evidence; the error itself is
    // already recorded on the resolution.
    if (source.error !== undefined) continue;
    if (source.raw === undefined) continue;
    // A payload with no attributable provider cannot be audited, so it is
    // dropped rather than stored anonymously.
    if (!source.provider) continue;

    const { response, responseBytes, truncated } = boundRawPayload(source.raw);
    rows.push([
      marketId,
      source.provider,
      source.request ?? null,
      response,
      responseBytes,
      truncated,
      source.outcome,
      source.confidence,
      source.respondedAt ?? null,
    ]);
  }

  if (rows.length === 0) return 0;

  // One multi-row INSERT: a resolution touches several providers, and a round
  // trip each would make the audit write the slowest part of finalizing.
  const placeholders = rows
    .map((_, index) => {
      const base = index * 9;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
    })
    .join(", ");

  const values = rows.flat();
  await pool.query(
    `INSERT INTO adapter_raw_payloads
       (market_id, provider, raw_request, raw_response, response_bytes,
        truncated, outcome, confidence, responded_at)
     VALUES ${placeholders}`,
    values,
  );

  return rows.length;
}

/**
 * Binds {@link persistRawPayloads} into a `RawPayloadSink` for `resolveMarket`.
 *
 * This is the Postgres-backed implementation of the optional `rawPayloadSink`
 * hook, so the resolution path persists payload evidence without the adapter
 * layer needing to know anything about the database.
 */
export function createRawPayloadSink(pool: QueryablePool): RawPayloadSink {
  return async (marketId, sources) => {
    await persistRawPayloads(pool, marketId, sources);
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
  // Payload *summary* only. Raw provider bodies run to hundreds of KB each, so
  // embedding them here would make one row per market unusable. The full
  // payloads ship in the JSON export and in the long-format
  // `toRawPayloadCsv` companion.
  "raw_payload_providers",
  "raw_payload_count",
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

/** Distinct provider ids, in fetch order, as one cell. */
function providersCell(payloads: readonly RawPayloadRecord[]): string {
  return [...new Set(payloads.map((p) => p.provider))].join("|");
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
      providersCell(record.rawPayloads),
      String(record.rawPayloads.length),
    ];
    rows.push(cells.map((cell) => escapeCsv(cell)).join(","));
  }
  // Trailing newline so appending/concatenating exports stays well-formed.
  return `${rows.join("\n")}\n`;
}

const RAW_CSV_COLUMNS = [
  "market_id",
  "provider",
  "responded_at",
  "received_at",
  "outcome",
  "confidence",
  "response_bytes",
  "truncated",
  "request",
  "response",
] as const;

/**
 * Long-format companion export: one row per provider payload.
 *
 * Kept separate from {@link toAuditCsv} so the per-market summary stays one
 * manageable row, while the evidence itself is still exportable to CSV for
 * reviewers who do not want to open JSON. Every payload backing every
 * resolution is represented, including truncated ones (flagged as such).
 */
export function toRawPayloadCsv(records: readonly CouncilAuditRecord[]): string {
  const rows: string[] = [RAW_CSV_COLUMNS.join(",")];
  for (const record of records) {
    for (const payload of record.rawPayloads) {
      const cells = [
        record.marketId,
        payload.provider,
        payload.respondedAt ?? "",
        payload.receivedAt ?? "",
        payload.outcome === null ? "" : String(payload.outcome),
        payload.confidence === null ? "" : String(payload.confidence),
        String(payload.responseBytes),
        String(payload.truncated),
        JSON.stringify(payload.request ?? null),
        JSON.stringify(payload.response ?? null),
      ];
      rows.push(cells.map((cell) => escapeCsv(cell)).join(","));
    }
  }
  return `${rows.join("\n")}\n`;
}

interface FinalizedMarketRow extends Record<string, unknown> {
  market_id: string;
  decision: string | null;
  tx_hash: string | null;
  finalized_at: string | null;
  [key: string]: unknown;
}

interface CouncilVoteRow extends Record<string, unknown> {
  market_id: string;
  member: string;
  outcome: boolean;
  [key: string]: unknown;
}

interface RawPayloadRow extends Record<string, unknown> {
  market_id: string;
  provider: string;
  raw_request: unknown;
  raw_response: unknown;
  response_bytes: number;
  truncated: boolean;
  outcome: boolean | null;
  confidence: string | number | null;
  responded_at: string | null;
  received_at: string | null;
}

/**
 * Reads finalized decisions, their council votes, and the raw provider
 * payloads backing them from Postgres and builds one audit record per
 * finalized market.
 *
 * Only finalized markets are exported (`status = 'finalized'`), so the audit
 * reflects committed decisions rather than in-flight submissions.
 *
 * The payload read is a separate query rather than a join: a resolution
 * consults several providers, so the join would multiply vote rows and have to
 * be de-duplicated again in application code.
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

  const payloads = await pool.query<RawPayloadRow>(
    `SELECT market_id,
            provider,
            raw_request,
            raw_response,
            response_bytes,
            truncated,
            outcome,
            confidence,
            responded_at::text AS responded_at,
            received_at::text AS received_at
       FROM adapter_raw_payloads
      ORDER BY market_id ASC, received_at ASC, id ASC`,
  );

  const votesByMarket = new Map<string, CouncilVote[]>();
  for (const row of votes.rows) {
    const bucket = votesByMarket.get(row.market_id) ?? [];
    bucket.push({ member: row.member, outcome: row.outcome });
    votesByMarket.set(row.market_id, bucket);
  }

  const payloadsByMarket = new Map<string, RawPayloadRecord[]>();
  for (const row of payloads.rows) {
    const bucket = payloadsByMarket.get(row.market_id) ?? [];
    bucket.push({
      provider: row.provider,
      request: row.raw_request,
      response: row.raw_response,
      responseBytes: Number(row.response_bytes),
      truncated: row.truncated,
      outcome: row.outcome,
      // NUMERIC comes back as a string by design (no lossy float parse).
      confidence: row.confidence === null ? null : Number(row.confidence),
      respondedAt: row.responded_at,
      receivedAt: row.received_at,
    });
    payloadsByMarket.set(row.market_id, bucket);
  }

  return finalized.rows.map((row) =>
    buildAuditRecord({
      marketId: row.market_id,
      votes: votesByMarket.get(row.market_id) ?? [],
      decision: row.decision,
      txHash: row.tx_hash,
      finalizedAt: row.finalized_at,
      rawPayloads: payloadsByMarket.get(row.market_id) ?? [],
    }),
  );
}

export type AuditFormat = "csv" | "json" | "raw-csv";

/**
 * Collects the council audit and serialises it in the requested format.
 *
 * `raw-csv` is the long-format payload companion — one row per provider
 * response — for reviewers who need the evidence itself in a spreadsheet.
 */
export async function exportCouncilAudit(pool: QueryablePool, format: AuditFormat): Promise<string> {
  const records = await collectCouncilAudit(pool);
  if (format === "csv") return toAuditCsv(records);
  if (format === "raw-csv") return toRawPayloadCsv(records);
  return toAuditJson(records);
}
