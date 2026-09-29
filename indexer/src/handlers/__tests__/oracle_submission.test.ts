import { describe, expect, it, vi } from "vitest";
import {
  decodeOracleSubmission,
  handleOracleSubmission,
  ORACLE_SUBMISSION_TOPIC,
} from "../oracle_submission.js";
import type { DecodedEvent, HandlerContext } from "../types.js";

const SUBMITTER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM";
const MARKET_ID = 42;
const BOND = "1000000000";

function createEvent(data: unknown): DecodedEvent {
  return {
    ledger: 200n,
    txHash: "a".repeat(64),
    topics: [ORACLE_SUBMISSION_TOPIC, MARKET_ID, SUBMITTER],
    data,
  };
}

function createContext(inserted = true): HandlerContext {
  return {
    db: { query: vi.fn().mockResolvedValue({ rowCount: inserted ? 1 : 0 }) },
    logger: { warn: vi.fn() },
  };
}

describe("decodeOracleSubmission", () => {
  it("decodes a submit_outcome payload from data fields", () => {
    expect(
      decodeOracleSubmission(createEvent({ market_id: MARKET_ID, submitter: SUBMITTER, outcome: true, bond: BOND })),
    ).toEqual({ market_id: MARKET_ID, submitter: SUBMITTER, outcome: "yes", bond_amount: BOND });
  });

  it("normalises a false outcome to 'no'", () => {
    expect(
      decodeOracleSubmission(createEvent({ market_id: MARKET_ID, submitter: SUBMITTER, outcome: false, bond: 0n })),
    ).toEqual({ market_id: MARKET_ID, submitter: SUBMITTER, outcome: "no", bond_amount: "0" });
  });

  it("falls back to topics for market_id and submitter", () => {
    expect(
      decodeOracleSubmission(createEvent({ outcome: "yes", bond_amount: BOND })),
    ).toEqual({ market_id: MARKET_ID, submitter: SUBMITTER, outcome: "yes", bond_amount: BOND });
  });

  it("rejects invalid payloads", () => {
    expect(() => decodeOracleSubmission(createEvent({ market_id: -1, submitter: SUBMITTER, outcome: true, bond: BOND }))).toThrow(
      "market_id",
    );
    expect(() => decodeOracleSubmission(createEvent({ market_id: MARKET_ID, submitter: "bad", outcome: true, bond: BOND }))).toThrow(
      "valid Stellar address",
    );
  });
});

describe("handleOracleSubmission", () => {
  it("records the raw event and upserts the submission", async () => {
    const context = createContext();
    const event = createEvent({ market_id: MARKET_ID, submitter: SUBMITTER, outcome: true, bond: BOND });

    await handleOracleSubmission(event, context);

    expect(context.db.query).toHaveBeenCalledTimes(2);
    expect(context.db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO events"),
      [event.ledger, event.txHash, 0, ORACLE_SUBMISSION_TOPIC, MARKET_ID, SUBMITTER, {
        market_id: MARKET_ID,
        submitter: SUBMITTER,
        outcome: "yes",
        bond_amount: BOND,
      }],
    );
    expect(context.db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO oracle_submissions"),
      [MARKET_ID, SUBMITTER, "yes", BOND],
    );
  });

  it("uses ON CONFLICT DO NOTHING so a market is never double-submitted", async () => {
    const context = createContext();
    const event = createEvent({ market_id: MARKET_ID, submitter: SUBMITTER, outcome: true, bond: BOND });

    await handleOracleSubmission(event, context);

    const insertSql = (context.db.query as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(insertSql).toContain("ON CONFLICT (market_id) DO NOTHING");
  });

  it("is idempotent — a replayed event does not touch oracle_submissions", async () => {
    const context = createContext(false);
    const event = createEvent({ market_id: MARKET_ID, submitter: SUBMITTER, outcome: true, bond: BOND });

    await handleOracleSubmission(event, context);

    // Only the events insert ran; the submission upsert was skipped.
    expect(context.db.query).toHaveBeenCalledTimes(1);
  });
});
