import { describe, expect, it, vi } from "vitest";
import {
  decodeOracleChallengedEvent,
  decodeOracleEscalatedEvent,
  handleOracleChallengedEvent,
  handleOracleEscalatedEvent,
} from "../handlers/oracle_challenge.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../types.js";

const SUBMITTER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM";
const CHALLENGER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBNZ5H";

function challengedEvent(data: unknown): DecodedContractEvent {
  return {
    topics: ["oracle", "challenged"],
    data,
    ledger: 555,
    txHash: "c".repeat(64),
  };
}

function escalatedEvent(data: unknown): DecodedContractEvent {
  return {
    topics: ["oracle", "escalated"],
    data,
    ledger: 556,
    txHash: "d".repeat(64),
  };
}

const challengedData = {
  market_id: 42,
  challenger: CHALLENGER,
  outcome: false,
  bond: 200_0000000n,
  submitter: SUBMITTER,
  submitter_bond: 100_0000000n,
  challenged_at: 1_700_000_000n,
};

const escalatedData = {
  market_id: 42,
  submitter: SUBMITTER,
  challenger: CHALLENGER,
  outcome: true,
  total_bond: 300_0000000n,
  escalated_at: 1_700_000_000n,
  council_deadline: 1_700_259_200n,
};

describe("decodeOracleChallengedEvent", () => {
  it("decodes a challenged payload", () => {
    expect(decodeOracleChallengedEvent(challengedEvent(challengedData))).toEqual({
      market_id: 42,
      challenger: CHALLENGER,
      outcome: "no",
      bond: "2000000000",
      submitter: SUBMITTER,
      submitter_bond: "1000000000",
      challenged_at: new Date(1_700_000_000_000),
    });
  });

  it("rejects the wrong topic", () => {
    expect(() =>
      decodeOracleChallengedEvent({ topics: ["oracle", "escalated"], data: challengedData }),
    ).toThrow("Unexpected event topic");
  });

  it("rejects an invalid challenger address", () => {
    expect(() =>
      decodeOracleChallengedEvent(challengedEvent({ ...challengedData, challenger: "bad" })),
    ).toThrow("valid Stellar address");
  });
});

describe("decodeOracleEscalatedEvent", () => {
  it("decodes an escalated payload", () => {
    expect(decodeOracleEscalatedEvent(escalatedEvent(escalatedData))).toEqual({
      market_id: 42,
      submitter: SUBMITTER,
      challenger: CHALLENGER,
      outcome: "yes",
      total_bond: "3000000000",
      escalated_at: new Date(1_700_000_000_000),
      council_deadline: new Date(1_700_259_200_000),
    });
  });
});

describe("handleOracleChallengedEvent", () => {
  it("records the event and inserts a dispute row", async () => {
    const db: DbClient = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const redis: RedisClient = { del: vi.fn() };

    await handleOracleChallengedEvent(challengedEvent(challengedData), db, redis);

    expect(db.query).toHaveBeenCalledTimes(3);
    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("INSERT INTO events"), expect.any(Array));
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO oracle_disputes"),
      [42, SUBMITTER, CHALLENGER, "no", "1000000000", "2000000000", new Date(1_700_000_000_000)],
    );
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain("ON CONFLICT (market_id) DO NOTHING");
    expect(db.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("UPDATE oracle_submissions SET status = 'challenged'"),
      [42],
    );
  });

  it("is idempotent — a replayed challenge event never creates a second dispute row", async () => {
    const db: DbClient = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const redis: RedisClient = { del: vi.fn() };

    await handleOracleChallengedEvent(challengedEvent(challengedData), db, redis);

    // Only the events-table insert ran; the dedupe guard skipped the dispute write.
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

describe("handleOracleEscalatedEvent", () => {
  it("promotes an existing dispute to escalated without touching bonds twice", async () => {
    const db: DbClient = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const redis: RedisClient = { del: vi.fn() };

    await handleOracleEscalatedEvent(escalatedEvent(escalatedData), db, redis);

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE market_id = $1 AND status = 'challenged'"),
      // total_bond is a GENERATED column (submitter_bond + challenger_bond,
      // migration 0015) and is therefore never written by the handler.
      [42, new Date(1_700_000_000_000), new Date(1_700_259_200_000)],
    );
  });

  it("is idempotent — a replayed escalation is a no-op", async () => {
    const db: DbClient = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const redis: RedisClient = { del: vi.fn() };

    await handleOracleEscalatedEvent(escalatedEvent(escalatedData), db, redis);

    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
