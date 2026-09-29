import { describe, expect, it, vi } from "vitest";
import {
  buildAuditRecord,
  collectCouncilAudit,
  COUNCIL_AUDIT_RETENTION,
  exportCouncilAudit,
  isCouncilAuditRecordPurgeable,
  toAuditCsv,
  toAuditJson,
  type CouncilAuditRecord,
} from "../src/aggregator/council-audit.js";
import type { QueryablePool } from "../src/aggregator/tally.js";

const RECORD: CouncilAuditRecord = {
  marketId: "42",
  decision: "yes",
  txHash: "abc123",
  finalizedAt: "2026-07-29T00:00:00.000Z",
  yesVotes: 2,
  noVotes: 1,
  totalVoters: 3,
  votes: [
    { member: "GAAA", outcome: true },
    { member: "GBBB", outcome: true },
    { member: "GCCC", outcome: false },
  ],
};

describe("buildAuditRecord", () => {
  it("derives the tally from votes, de-duplicating by member (latest wins)", () => {
    const record = buildAuditRecord({
      marketId: "7",
      votes: [
        { member: "GAAA", outcome: true },
        { member: "GAAA", outcome: false }, // re-vote: only the latest counts
        { member: "GBBB", outcome: true },
      ],
      decision: "yes",
    });

    expect(record.totalVoters).toBe(2);
    expect(record.yesVotes).toBe(1);
    expect(record.noVotes).toBe(1);
    expect(record.decision).toBe("yes");
  });

  it("defaults missing decision metadata to null", () => {
    const record = buildAuditRecord({ marketId: "7", votes: [] });
    expect(record).toMatchObject({ decision: null, txHash: null, finalizedAt: null, totalVoters: 0 });
  });
});

describe("toAuditJson", () => {
  it("serialises records to pretty JSON that round-trips", () => {
    const parsed = JSON.parse(toAuditJson([RECORD]));
    expect(parsed).toEqual([RECORD]);
  });
});

describe("toAuditCsv", () => {
  it("emits a stable header and one row per record", () => {
    const csv = toAuditCsv([RECORD]);
    const lines = csv.trimEnd().split("\n");

    expect(lines[0]).toBe("market_id,decision,tx_hash,finalized_at,yes_votes,no_votes,total_voters,votes");
    expect(lines[1]).toBe("42,yes,abc123,2026-07-29T00:00:00.000Z,2,1,3,GAAA=yes|GBBB=yes|GCCC=no");
  });

  it("quotes cells that contain commas or quotes", () => {
    const csv = toAuditCsv([
      { ...RECORD, txHash: 'a,b"c', votes: [] },
    ]);
    expect(csv).toContain('"a,b""c"');
  });
});

function createPool(finalizedRows: unknown[], voteRows: unknown[]): QueryablePool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("oracle_submissions")) return { rows: finalizedRows };
    if (sql.includes("council_votes")) return { rows: voteRows };
    return { rows: [] };
  });
  return { query } as unknown as QueryablePool;
}

describe("collectCouncilAudit", () => {
  it("joins finalized markets to their council votes", async () => {
    const pool = createPool(
      [{ market_id: "42", decision: "yes", tx_hash: "abc", finalized_at: "2026-07-29T00:00:00.000Z" }],
      [
        { market_id: "42", member: "GAAA", outcome: true },
        { market_id: "42", member: "GBBB", outcome: false },
      ],
    );

    const records = await collectCouncilAudit(pool);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ marketId: "42", decision: "yes", yesVotes: 1, noVotes: 1, totalVoters: 2 });
  });

  it("only exports finalized submissions", async () => {
    const pool = createPool([], []);
    await collectCouncilAudit(pool);

    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("status = 'finalized'");
  });
});

describe("exportCouncilAudit", () => {
  it("routes to CSV or JSON based on the requested format", async () => {
    const pool = createPool(
      [{ market_id: "42", decision: "yes", tx_hash: "abc", finalized_at: "t" }],
      [{ market_id: "42", member: "GAAA", outcome: true }],
    );

    expect(await exportCouncilAudit(pool, "csv")).toContain("market_id,decision");
    expect(JSON.parse(await exportCouncilAudit(pool, "json"))[0].marketId).toBe("42");
  });
});

// ── Retention (issue #646) ─────────────────────────────────────────────────
describe("council audit retention", () => {
  it("is audit-class with no automatic enforcement", () => {
    expect(COUNCIL_AUDIT_RETENTION.class).toBe("audit");
    expect(COUNCIL_AUDIT_RETENTION.automaticEnforcement).toBe(false);
    expect(COUNCIL_AUDIT_RETENTION.retentionYears).toBeGreaterThanOrEqual(5);
  });

  it("treats a missing or invalid finalized_at as not purgeable", () => {
    expect(isCouncilAuditRecordPurgeable(null)).toBe(false);
    expect(isCouncilAuditRecordPurgeable(undefined)).toBe(false);
    expect(isCouncilAuditRecordPurgeable("not-a-date")).toBe(false);
  });

  it("only allows purge past the retention window", () => {
    const now = new Date("2030-01-01T00:00:00Z");
    expect(isCouncilAuditRecordPurgeable("2029-01-01T00:00:00Z", now)).toBe(false); // 1y old
    expect(isCouncilAuditRecordPurgeable("2020-01-01T00:00:00Z", now)).toBe(true); // 10y old
  });
});
