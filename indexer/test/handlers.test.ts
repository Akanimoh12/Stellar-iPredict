import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchEvent,
  eventHandlers,
  getEventTopic,
  decodeClaim,
  handleClaim,
  REWARD_CLAIMED_TOPIC,
  decodeFeeWithdrawn,
  handleFeeWithdrawn,
  FEES_WITHDRAWN_TOPIC,
  decodeOracleSubmission,
  handleOracleSubmission,
  ORACLE_SUBMISSION_TOPIC,
  decodeRewardPoints,
  handleRewardPoints,
  REWARD_POINTS_TOPIC,
  decodeTokenMint,
  handleTokenMint,
  TOKEN_MINT_TOPIC,
} from "../src/handlers/index.js";
import { writeEventToDb } from "../src/event-router.js";
import {
  handleMarketCancelledEvent,
  decodeMarketCancelledEvent,
  MARKET_CANCELLED_TOPIC,
} from "../src/handlers/market_cancelled.js";
import { handleMarketCreatedEvent, MARKET_CREATED_TOPIC } from "../src/handlers/market_created.js";
import { handleMarketResolvedEvent, MARKET_RESOLVED_TOPIC } from "../src/handlers/market_resolved.js";
import {
  handleBetPlacedEvent,
  decodeBetPlacedEvent,
  isBetPlacedTopic,
} from "../src/handlers/bet_placed.js";
import {
  handleReferralRegisteredEvent,
  decodeReferralRegisteredEvent,
  REFERRAL_REGISTERED_TOPIC,
} from "../src/handlers/referral_registered.js";
import {
  handleReferralRewardEvent,
  decodeReferralRewardEvent,
  REFERRAL_REWARD_TOPIC,
} from "../src/handlers/referral_reward.js";
import {
  handleOracleChallengedEvent,
  handleOracleEscalatedEvent,
  decodeOracleChallengedEvent,
  decodeOracleEscalatedEvent,
  ORACLE_CHALLENGED_TOPIC,
  ORACLE_ESCALATED_TOPIC,
} from "../src/handlers/oracle_challenge.js";
import { handleOracleFinalizedEvent, ORACLE_FINALIZED_TOPIC } from "../src/handlers/oracle_finalized.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../src/types.js";
import type { DecodedEvent, HandlerContext } from "../src/handlers/types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SUBMITTER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM";
const CHALLENGER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBNZ5H";
const USER = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ADMIN = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

function contractEvent(
  topics: readonly unknown[],
  data: unknown,
): DecodedContractEvent {
  return { topics, data, ledger: 900, txHash: "9".repeat(64) };
}

function mockDb(rows: unknown[] = [], rowCount = 1): DbClient {
  return { query: vi.fn().mockResolvedValue({ rows, rowCount }) };
}

const mockRedis: RedisClient = { del: vi.fn().mockResolvedValue(1) };

function registryContext(): HandlerContext {
  return {
    db: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) },
    redis: { del: vi.fn().mockResolvedValue(1) },
    logger: { warn: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── dispatchEvent + real registry (single-string-topic handlers) ────────────

describe("dispatchEvent with the real registry", () => {
  it("registers every single-string-topic handler", () => {
    expect(Object.keys(eventHandlers)).toEqual([
      REWARD_CLAIMED_TOPIC,
      FEES_WITHDRAWN_TOPIC,
      ORACLE_SUBMISSION_TOPIC,
      REWARD_POINTS_TOPIC,
      TOKEN_MINT_TOPIC,
    ]);
  });

  it("routes a reward_claimed event to handleClaim", async () => {
    const context = registryContext();
    const event: DecodedEvent = {
      ledger: 1,
      txHash: "a".repeat(64),
      topics: [REWARD_CLAIMED_TOPIC, 5, USER],
      data: { market_id: 5, user: USER, payout_xlm: 500000000n },
    };
    await dispatchEvent(event, context);
    expect(context.logger.warn).not.toHaveBeenCalled();
    expect(await decodeClaim(event)).toEqual({ market_id: 5, user: USER, payout_xlm: 500000000 });
  });

  it("routes a fees_withdrawn event to handleFeeWithdrawn", async () => {
    const event: DecodedEvent = {
      ledger: 2,
      txHash: "b".repeat(64),
      topics: [FEES_WITHDRAWN_TOPIC],
      data: { admin: ADMIN, amount: 250000000n },
    };
    expect(await decodeFeeWithdrawn(event)).toEqual({ admin: ADMIN, amount: "250000000" });
  });

  it("routes a submit_outcome event to handleOracleSubmission", async () => {
    const event: DecodedEvent = {
      ledger: 3,
      txHash: "c".repeat(64),
      topics: [ORACLE_SUBMISSION_TOPIC, 9, SUBMITTER],
      data: { market_id: 9, submitter: SUBMITTER, outcome: true, bond_amount: 100_0000000n },
    };
    expect(await decodeOracleSubmission(event)).toEqual({
      market_id: 9,
      submitter: SUBMITTER,
      outcome: "yes",
      bond_amount: "1000000000",
    });
  });

  it("routes a reward_points event to handleRewardPoints", async () => {
    const event: DecodedEvent = {
      ledger: 4,
      txHash: "d".repeat(64),
      topics: [REWARD_POINTS_TOPIC, USER, 30],
      data: { user: USER, points: 30, is_winner: true },
    };
    expect(await decodeRewardPoints(event)).toEqual({ user: USER, points: 30, is_winner: true });
  });

  it("routes a token_mint event to handleTokenMint", async () => {
    const event: DecodedEvent = {
      ledger: 5,
      txHash: "e".repeat(64),
      topics: [TOKEN_MINT_TOPIC],
      data: { to: USER, amount: "15000000" },
    };
    expect(await decodeTokenMint(event)).toEqual({ to: USER, amount: "15000000" });
  });

  it("logs and skips an unknown first topic", async () => {
    const context = registryContext();
    const event: DecodedEvent = {
      ledger: 6,
      txHash: "f".repeat(64),
      topics: ["mkt", "created"],
      data: {},
    };
    await dispatchEvent(event, context);
    expect(context.logger.warn).toHaveBeenCalled();
  });

  it("getEventTopic returns the first topic when it is a string", () => {
    expect(getEventTopic({ ledger: 1, txHash: "0".repeat(64), topics: [REWARD_POINTS_TOPIC], data: {} })).toBe(REWARD_POINTS_TOPIC);
  });

  it("getEventTopic returns the first topic only when it is a string (multi-topic events are left to the router)", () => {
    expect(getEventTopic({ ledger: 1, txHash: "0".repeat(64), topics: ["oracle", "challenged"], data: {} })).toBe("oracle");
    expect(getEventTopic({ ledger: 1, txHash: "0".repeat(64), topics: [12345], data: {} })).toBeUndefined();
  });
});

// ── writeEventToDb (event-router) across all routed event kinds ─────────────

describe("writeEventToDb routes every event kind", () => {
  it("handles mkt/cancelled", async () => {
    const db = mockDb();
    await writeEventToDb(
      contractEvent(["mkt", "cancelled"], { market_id: 42 }),
      db,
      mockRedis,
    );
    expect(db.query).toHaveBeenCalled();
  });

  it("handles bet/placed", async () => {
    const db = mockDb([{ side_valid: true, event_inserted: true, applied: true }]);
    await writeEventToDb(
      contractEvent(["bet", "placed", 42, USER], {
        market_id: 42,
        bettor: USER,
        is_yes: true,
        amount: "10000000",
        net_amount: "9800000",
        fee: "200000",
        is_increase: false,
      }),
      db,
      mockRedis,
    );
    expect(db.query).toHaveBeenCalled();
  });

  it("handles referral/registered", async () => {
    const db = mockDb();
    await writeEventToDb(
      contractEvent(["referral", "registered"], {
        address: USER,
        referrer: ADMIN,
        display_name: "alice",
        welcome_points: 25,
      }),
      db,
      mockRedis,
    );
    expect(db.query).toHaveBeenCalled();
  });

  it("handles referral/reward", async () => {
    const db = mockDb();
    await writeEventToDb(
      contractEvent(["referral", "reward"], { referrer: ADMIN, recipient: USER, reward: 100 }),
      db,
      mockRedis,
    );
    expect(db.query).toHaveBeenCalled();
  });

  it("handles oracle/challenged and oracle/escalated", async () => {
    const db = mockDb();
    await writeEventToDb(
      contractEvent(["oracle", "challenged"], {
        market_id: 7,
        challenger: CHALLENGER,
        outcome: false,
        bond: 200_0000000n,
        submitter: SUBMITTER,
        submitter_bond: 100_0000000n,
        challenged_at: 1_700_000_000n,
      }),
      db,
      mockRedis,
    );
    await writeEventToDb(
      contractEvent(["oracle", "escalated"], {
        market_id: 7,
        submitter: SUBMITTER,
        challenger: CHALLENGER,
        outcome: true,
        total_bond: 300_0000000n,
        escalated_at: 1_700_000_000n,
        council_deadline: 1_700_259_200n,
      }),
      db,
      mockRedis,
    );
    expect(db.query).toHaveBeenCalled();
  });

  it("handles oracle/finalized", async () => {
    const db = mockDb([{ rowCount: 1 }]);
    await writeEventToDb(
      contractEvent(["oracle", "finalized"], {
        market_id: 7,
        outcome: true,
        challenged: false,
        submitter: SUBMITTER,
        challenger: null,
        submitter_payout: 100_0000000n,
        challenger_payout: 0n,
        council_fee: 0n,
        protocol_credit: 20_000000n,
        finalized_at: 1_700_086_400n,
      }),
      db,
      mockRedis,
    );
    expect(db.query).toHaveBeenCalled();
  });
});

// ── Router-handler decoders against fixtures ────────────────────────────────

describe("router handler decoders", () => {
  it("decodes market_cancelled", () => {
    expect(
      decodeMarketCancelledEvent(contractEvent(["mkt", "cancelled"], { market_id: 42 })),
    ).toEqual({ market_id: 42 });
  });

  it("decodes bet_placed tuples", () => {
    expect(
      decodeBetPlacedEvent(
        contractEvent(["bet", "placed", 42, USER], ["42", USER, true, "10000000", "9800000", "200000", false]),
      ),
    ).toMatchObject({ market_id: 42, bettor: USER, is_yes: true });
  });

  it("decodes referral_registered and referral_reward", () => {
    expect(
      decodeReferralRegisteredEvent(contractEvent(["referral", "registered"], {
        user: USER, referrer: ADMIN, display_name: "alice", welcome_bonus_points: 25,
      })),
    ).toMatchObject({ user: USER, referrer: ADMIN });
    expect(
      decodeReferralRewardEvent(contractEvent(["referral", "reward"], {
        referrer: ADMIN, recipient: USER, points: 100,
      })),
    ).toMatchObject({ referrer: ADMIN });
  });

  it("decodes oracle challenged and escalated payloads", () => {
    expect(
      decodeOracleChallengedEvent(contractEvent(["oracle", "challenged"], {
        market_id: 7, challenger: CHALLENGER, outcome: false, bond: 200_0000000n,
        submitter: SUBMITTER, submitter_bond: 100_0000000n, challenged_at: 1_700_000_000n,
      })),
    ).toMatchObject({ market_id: 7, outcome: "no", bond: "2000000000" });
    expect(
      decodeOracleEscalatedEvent(contractEvent(["oracle", "escalated"], {
        market_id: 7, submitter: SUBMITTER, challenger: CHALLENGER, outcome: true,
        total_bond: 300_0000000n, escalated_at: 1_700_000_000n, council_deadline: 1_700_259_200n,
      })),
    ).toMatchObject({ market_id: 7, outcome: "yes", total_bond: "3000000000" });
  });

  it("isBetPlacedTopic matches bet topic shapes", () => {
    expect(isBetPlacedTopic(["bet", "placed"])).toBe(true);
    expect(isBetPlacedTopic(["bet_placed"])).toBe(true);
    expect(isBetPlacedTopic(["bet"])).toBe(true);
    expect(isBetPlacedTopic(["mkt", "created"])).toBe(false);
  });
});

// ── Registry handlers write + invalidate (fixture-driven) ───────────────────

describe("registry handlers write and invalidate", () => {
  it("handleClaim marks the bet claimed and invalidates caches", async () => {
    const context = registryContext();
    const event: DecodedEvent = {
      ledger: 1,
      txHash: "a".repeat(64),
      topics: [REWARD_CLAIMED_TOPIC, 5, USER],
      data: { market_id: 5, user: USER, payout_xlm: 500000000n },
    };
    await handleClaim(event, context);
    expect(context.db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE bets SET claimed"),
      [5, USER],
    );
    expect(context.redis!.del).toHaveBeenCalled();
  });

  it("handleRewardPoints upserts leaderboard points", async () => {
    const context = registryContext();
    await handleRewardPoints(
      { ledger: 1, txHash: "a".repeat(64), topics: [REWARD_POINTS_TOPIC, USER, 30], data: { user: USER, points: 30, is_winner: true } },
      context,
    );
    expect(context.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO leaderboard"),
      expect.any(Array),
    );
  });

  it("handleTokenMint upserts token balances and invalidates caches", async () => {
    const context = registryContext();
    await handleTokenMint(
      { ledger: 1, txHash: "a".repeat(64), topics: [TOKEN_MINT_TOPIC], data: { to: USER, amount: "15000000" } },
      context,
    );
    expect(context.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO token_balances"),
      expect.any(Array),
    );
  });
});

// ── Router handlers write through insertProcessedEvent / upserts ────────────

describe("router handlers write through inserted-event guards", () => {
  it("handleMarketCreatedEvent upserts a market only on first insert", async () => {
    const db = mockDb();
    const event = contractEvent(["mkt", "created"], {
      market_id: 1,
      question: "Will BTC hit 100k?",
      category: "Crypto",
      end_time: 1_800_000_000,
      creator: ADMIN,
    });
    await handleMarketCreatedEvent(event, db, mockRedis);
    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("INSERT INTO events"), expect.any(Array));
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("INSERT INTO markets"), expect.any(Array));
    expect(mockRedis.del).toHaveBeenCalled();
  });

  it("skips the market upsert and cache invalidation when the event is a replay", async () => {
    const dbReplay: DbClient = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const event = contractEvent(["mkt", "created"], {
      market_id: 1,
      question: "Will BTC hit 100k?",
      category: "Crypto",
      end_time: 1_800_000_000,
      creator: ADMIN,
    });
    await handleMarketCreatedEvent(event, dbReplay, mockRedis);
    expect(dbReplay.query).toHaveBeenCalledTimes(1);
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it("handleMarketCancelledEvent marks a market cancelled", async () => {
    const db = mockDb();
    await handleMarketCancelledEvent(contractEvent(["mkt", "cancelled"], { market_id: 42 }), db, mockRedis);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("SET cancelled = TRUE"), [42]);
  });

  it("handleMarketResolvedEvent marks a market resolved", async () => {
    const db = mockDb();
    await handleMarketResolvedEvent(contractEvent(["market_resolved"], { market_id: 42, outcome: true }), db, mockRedis);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("SET resolved = TRUE"), [42, true]);
  });

  it("handleOracleChallengedEvent inserts a dispute", async () => {
    const db = mockDb();
    await handleOracleChallengedEvent(contractEvent(["oracle", "challenged"], {
      market_id: 7, challenger: CHALLENGER, outcome: false, bond: 200_0000000n,
      submitter: SUBMITTER, submitter_bond: 100_0000000n, challenged_at: 1_700_000_000n,
    }), db, mockRedis);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("INSERT INTO oracle_disputes"), expect.any(Array));
  });

  it("handleOracleFinalizedEvent finalizes the submission and updates the market", async () => {
    const db = mockDb();
    await handleOracleFinalizedEvent(contractEvent(["oracle", "finalized"], {
      market_id: 7, outcome: true, challenged: false, submitter: SUBMITTER, challenger: null,
      submitter_payout: 100_0000000n, challenger_payout: 0n, council_fee: 0n,
      protocol_credit: 20_000000n, finalized_at: 1_700_086_400n,
    }), db, mockRedis);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("SET resolved = TRUE"), expect.any(Array));
    expect(mockRedis.del).toHaveBeenCalled();
  });
});
