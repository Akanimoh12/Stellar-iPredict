import { describe, expect, it, vi } from "vitest";
import {
  boundRawPayload,
  buildAuditRecord,
  collectCouncilAudit,
  COUNCIL_AUDIT_RETENTION,
  exportCouncilAudit,
  isCouncilAuditRecordPurgeable,
  MAX_RAW_PAYLOAD_BYTES,
  persistRawPayloads,
  rawPayloadByteLength,
  toAuditCsv,
  toAuditJson,
  toRawPayloadCsv,
  type CouncilAuditRecord,
  type RawPayloadRecord,
} from "../src/aggregator/council-audit.js";
import type { QueryablePool } from "../src/aggregator/tally.js";
import type { SourceResult } from "../src/adapters/resolve.js";

const PAYLOAD: RawPayloadRecord = {
  provider: "binance",
  request: { url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT" },
  response: { symbol: "BTCUSDT", price: "64231.87" },
  responseBytes: 47,
  truncated: false,
  outcome: true,
  confidence: 1,
  respondedAt: "2026-07-29T00:00:00.000Z",
  receivedAt: "2026-07-29T00:00:01.000Z",
};

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
  rawPayloads: [],
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

    expect(lines[0]).toBe(
      "market_id,decision,tx_hash,finalized_at,yes_votes,no_votes,total_voters,votes,raw_payload_providers,raw_payload_count",
    );
    expect(lines[1]).toBe("42,yes,abc123,2026-07-29T00:00:00.000Z,2,1,3,GAAA=yes|GBBB=yes|GCCC=no,,0");
  });

  it("quotes cells that contain commas or quotes", () => {
    const csv = toAuditCsv([
      { ...RECORD, txHash: 'a,b"c', votes: [] },
    ]);
    expect(csv).toContain('"a,b""c"');
  });
});

function createPool(finalizedRows: unknown[], voteRows: unknown[], payloadRows: unknown[] = []): QueryablePool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("adapter_raw_payloads")) return { rows: payloadRows };
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

// ── Raw provider payload evidence ──────────────────────────────────────────
describe("raw payload persistence", () => {
  function source(over: Partial<SourceResult> = {}): SourceResult {
    return {
      adapterId: "binance",
      outcome: true,
      confidence: 1,
      raw: { symbol: "BTCUSDT", price: "64231.87" },
      provider: "binance",
      respondedAt: "2026-07-29T00:00:00.000Z",
      ...over,
    };
  }

  it("persists provider identity, the request made, and the response time", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as QueryablePool;

    const written = await persistRawPayloads(pool, "42", [
      source({
        provider: "reuters",
        request: { url: "https://reuters.test/politics" },
        respondedAt: "2026-07-29T00:00:00.000Z",
      }),
    ]);

    expect(written).toBe(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO adapter_raw_payloads");
    expect(sql).toContain("market_id, provider, raw_request, raw_response");
    // provider | request | response | bytes | truncated | outcome | confidence | respondedAt
    expect(params[0]).toBe("42");
    expect(params[1]).toBe("reuters");
    expect(params[2]).toEqual({ url: "https://reuters.test/politics" });
    expect(params[3]).toEqual({ symbol: "BTCUSDT", price: "64231.87" });
    expect(params[8]).toBe("2026-07-29T00:00:00.000Z");
  });

  it("appends one row per provider rather than overwriting, keeping each observation", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as QueryablePool;

    await persistRawPayloads(pool, "42", [
      source({ provider: "binance", raw: { attempt: 1 } }),
      source({ provider: "coinmarketcap", raw: { attempt: 2 } }),
    ]);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    // Two rows, two value tuples in a single statement.
    expect(sql.match(/\(\$\d+, \$\d+, \$\d+, \$\d+, \$\d+, \$\d+, \$\d+, \$\d+, \$\d+\)/g)).toHaveLength(2);
    expect(params).toHaveLength(18);
    // Re-fetching the same provider must not clobber the earlier reading.
    expect(sql).not.toContain("ON CONFLICT");
  });

  it("refuses to store a payload with no attributable provider", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as QueryablePool;

    // An anonymous payload cannot be attributed in a dispute, so it is dropped.
    const written = await persistRawPayloads(pool, "42", [source({ provider: undefined })]);

    expect(written).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("skips sources that errored, which have no response to evidence", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as QueryablePool;

    const written = await persistRawPayloads(pool, "42", [
      source({ error: "Data source is unavailable", raw: undefined }),
    ]);

    expect(written).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("issues no query when a resolution consulted no providers", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as QueryablePool;

    expect(await persistRawPayloads(pool, "42", [])).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("raw payload size bounding", () => {
  it("leaves a payload within the limit untouched", () => {
    const result = boundRawPayload({ price: "64231.87" });
    expect(result.truncated).toBe(false);
    expect(result.response).toEqual({ price: "64231.87" });
    expect(result.responseBytes).toBe(rawPayloadByteLength({ price: "64231.87" }));
  });

  it("shortens an oversized payload and marks it truncated", () => {
    const huge = { blob: "x".repeat(MAX_RAW_PAYLOAD_BYTES + 1024) };
    const result = boundRawPayload(huge);

    expect(result.truncated).toBe(true);
    // A truncated record must be recognisable as incomplete, never mistaken
    // for the provider's full response.
    expect(result.response).toMatchObject({ truncated: true });
    // Still valid JSON (not a mid-token slice), so the record stays readable.
    expect(() => JSON.stringify(result.response)).not.toThrow();
    // The recorded size is the size actually measured, not the substitute's.
    expect(result.responseBytes).toBeGreaterThan(MAX_RAW_PAYLOAD_BYTES);
  });

  it("keeps a preview so a truncated payload is still identifiable", () => {
    const result = boundRawPayload({ venue: "binance", blob: "x".repeat(MAX_RAW_PAYLOAD_BYTES * 2) });
    expect(JSON.stringify(result.response)).toContain("binance");
  });

  it("treats a null payload as zero-length rather than throwing", () => {
    const result = boundRawPayload(null);
    expect(result.truncated).toBe(false);
    expect(rawPayloadByteLength(null)).toBe(4); // the string "null"
  });
});

describe("council audit export includes raw payloads", () => {
  it("joins persisted payloads onto the finalized market they back", async () => {
    const pool = createPool(
      [{ market_id: "42", decision: "yes", tx_hash: "abc", finalized_at: "2026-07-29T00:00:00.000Z" }],
      [{ market_id: "42", member: "GAAA", outcome: true }],
      [
        {
          market_id: "42",
          provider: "binance",
          raw_request: { url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT" },
          raw_response: { symbol: "BTCUSDT", price: "64231.87" },
          response_bytes: 47,
          truncated: false,
          outcome: true,
          confidence: "1.0000",
          responded_at: "2026-07-29T00:00:00.000Z",
          received_at: "2026-07-29T00:00:01.000Z",
        },
      ],
    );

    const records = await collectCouncilAudit(pool);

    expect(records[0].rawPayloads).toHaveLength(1);
    expect(records[0].rawPayloads[0]).toEqual({
      provider: "binance",
      request: { url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT" },
      response: { symbol: "BTCUSDT", price: "64231.87" },
      responseBytes: 47,
      truncated: false,
      outcome: true,
      // NUMERIC arrives as a string to avoid lossy float parsing.
      confidence: 1,
      respondedAt: "2026-07-29T00:00:00.000Z",
      receivedAt: "2026-07-29T00:00:01.000Z",
    });
  });

  it("reports an empty payload list for a market resolved before payloads were stored", async () => {
    const pool = createPool(
      [{ market_id: "42", decision: "yes", tx_hash: "abc", finalized_at: "t" }],
      [],
    );

    const records = await collectCouncilAudit(pool);

    // Empty, not absent: a consumer can tell "none recorded" from "not asked".
    expect(records[0].rawPayloads).toEqual([]);
  });

  it("includes the full payloads in the JSON export", () => {
    const json = toAuditJson([{ ...RECORD, rawPayloads: [PAYLOAD] }]);
    const parsed = JSON.parse(json);

    expect(parsed[0].rawPayloads[0].response).toEqual({ symbol: "BTCUSDT", price: "64231.87" });
    expect(parsed[0].rawPayloads[0].provider).toBe("binance");
    expect(parsed[0].rawPayloads[0].respondedAt).toBe("2026-07-29T00:00:00.000Z");
  });

  it("summarises providers per market in the main CSV without inlining bodies", () => {
    const csv = toAuditCsv([{ ...RECORD, rawPayloads: [PAYLOAD, { ...PAYLOAD, provider: "reuters" }] }]);
    const [, row] = csv.trimEnd().split("\n");

    // One row per market stays one row per market — payloads are not inlined.
    expect(row).toContain("binance|reuters");
    expect(row).toContain(",2");
    expect(row).not.toContain("64231.87");
  });

  it("exports every payload in long-format CSV for reviewers", () => {
    const csv = toRawPayloadCsv([{ ...RECORD, rawPayloads: [PAYLOAD] }]);
    const lines = csv.trimEnd().split("\n");

    expect(lines[0]).toBe(
      "market_id,provider,responded_at,received_at,outcome,confidence,response_bytes,truncated,request,response",
    );
    expect(lines[1]).toContain("42,binance,2026-07-29T00:00:00.000Z");
    // The evidence itself is present here.
    expect(lines[1]).toContain("64231.87");
  });

  it("flags a truncated payload in the long-format export", () => {
    const csv = toRawPayloadCsv([{ ...RECORD, rawPayloads: [{ ...PAYLOAD, truncated: true }] }]);
    expect(csv).toContain(",true,");
  });

  it("routes raw-csv through the export entry point", async () => {
    const pool = createPool(
      [{ market_id: "42", decision: "yes", tx_hash: "abc", finalized_at: "t" }],
      [],
      [
        {
          market_id: "42",
          provider: "binance",
          raw_request: null,
          raw_response: { price: "1" },
          response_bytes: 12,
          truncated: false,
          outcome: true,
          confidence: null,
          responded_at: null,
          received_at: "t",
        },
      ],
    );

    const csv = await exportCouncilAudit(pool, "raw-csv");
    expect(csv.startsWith("market_id,provider,")).toBe(true);
    expect(csv).toContain("binance");
  });
});
