import { describe, expect, it, vi } from "vitest";
import { decodeOracleFinalizedEvent, handleOracleFinalizedEvent } from "../handlers/oracle_finalized.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";

const SUBMITTER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM";
const CHALLENGER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBNZ5H";

function finalizedEvent(data: unknown, txHash = "e".repeat(64)): DecodedContractEvent {
  return {
    topics: ["oracle", "finalized"],
    data,
    ledger: 777,
    txHash,
  };
}

const unchallengedData = {
  market_id: 42,
  outcome: true,
  challenged: false,
  submitter: SUBMITTER,
  challenger: null,
  submitter_payout: 100_0000000n,
  challenger_payout: 0n,
  council_fee: 0n,
  protocol_credit: 0n,
  finalized_at: 1_700_300_000n,
};

const challengedData = {
  market_id: 43,
  outcome: false,
  challenged: true,
  submitter: SUBMITTER,
  challenger: CHALLENGER,
  submitter_payout: 0n,
  challenger_payout: 280_0000000n,
  council_fee: 10_0000000n,
  protocol_credit: 20_0000000n,
  finalized_at: 1_700_300_100n,
};

describe("decodeOracleFinalizedEvent", () => {
  it("decodes an unchallenged auto-finalize with no challenger", () => {
    expect(decodeOracleFinalizedEvent(finalizedEvent(unchallengedData))).toEqual({
      market_id: 42,
      outcome: "yes",
      challenged: false,
      submitter: SUBMITTER,
      challenger: null,
      submitter_payout: "1000000000",
      challenger_payout: "0",
      council_fee: "0",
      protocol_credit: "0",
      finalized_at: new Date(1_700_300_000_000),
    });
  });

  it("decodes a council ruling with a challenger", () => {
    expect(decodeOracleFinalizedEvent(finalizedEvent(challengedData))).toEqual({
      market_id: 43,
      outcome: "no",
      challenged: true,
      submitter: SUBMITTER,
      challenger: CHALLENGER,
      submitter_payout: "0",
      challenger_payout: "2800000000",
      council_fee: "100000000",
      protocol_credit: "200000000",
      finalized_at: new Date(1_700_300_100_000),
    });
  });

  it("rejects the wrong topic", () => {
    expect(() =>
      decodeOracleFinalizedEvent({ topics: ["oracle", "escalated"], data: unchallengedData }),
    ).toThrow("Unexpected event topic");
  });

  it("rejects an invalid challenger address", () => {
    expect(() =>
      decodeOracleFinalizedEvent(finalizedEvent({ ...challengedData, challenger: "bad" })),
    ).toThrow("valid Stellar address");
  });
});

describe("handleOracleFinalizedEvent", () => {
  it("resolves the market, finalizes the submission, and invalidates the cache", async () => {
    const db: DbClient = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const redis: RedisClient = { del: vi.fn() };

    await handleOracleFinalizedEvent(finalizedEvent(unchallengedData), db, redis);

    expect(db.query).toHaveBeenCalledTimes(3);
    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("INSERT INTO events"), expect.any(Array));
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE markets"),
      [42, "yes"],
    );
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain(
      "WHERE id = $1 AND resolved = FALSE AND cancelled = FALSE",
    );
    expect(db.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("UPDATE oracle_submissions"),
      [42, "yes", "e".repeat(64), new Date(1_700_300_000_000)],
    );
    expect(redis.del).toHaveBeenCalled();
  });

  it("does not touch the cache when the market was already resolved or cancelled", async () => {
    const db: DbClient = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const redis: RedisClient = { del: vi.fn() };

    await handleOracleFinalizedEvent(finalizedEvent(unchallengedData), db, redis);

    expect(redis.del).not.toHaveBeenCalled();
  });

  it("is idempotent — a replayed finalize event cannot double-apply a resolution or payout", async () => {
    // rowCount: 0 on the events insert simulates the ON CONFLICT DO NOTHING
    // dedupe branch (a replayed event), which must short-circuit before any
    // market/submission write is attempted.
    const query = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const db: DbClient = { query };
    const redis: RedisClient = { del: vi.fn() };

    await handleOracleFinalizedEvent(finalizedEvent(unchallengedData), db, redis);

    expect(query).toHaveBeenCalledTimes(1);
    expect(redis.del).not.toHaveBeenCalled();
  });
});
