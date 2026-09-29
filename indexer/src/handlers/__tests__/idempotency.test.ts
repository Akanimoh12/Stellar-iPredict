import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleBetPlacedEvent } from "../bet_placed.js";
import { handleClaim } from "../claim.js";
import { handleFeeWithdrawn } from "../fee_withdrawn.js";
import { handleMarketCreatedEvent } from "../market_created.js";
import { handleMarketResolvedEvent } from "../market_resolved.js";
import { handleMarketCancelledEvent } from "../market_cancelled.js";
import { handleOracleSubmission } from "../oracle_submission.js";
import { handleOracleChallengedEvent, handleOracleEscalatedEvent } from "../oracle_challenge.js";
import { handleOracleFinalizedEvent } from "../oracle_finalized.js";
import { handleReferralRegisteredEvent } from "../referral_registered.js";
import { handleReferralRewardEvent } from "../referral_reward.js";
import { handleRewardPoints } from "../reward_points.js";
import { handleTokenMint } from "../token_mint.js";
import { handleTokenTransfer } from "../token.js";
import type { DecodedEvent, HandlerContext } from "../types.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../../types.js";

const USER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM";
const REFERRER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBNZ5H";
const TX_HASH = "1".repeat(64);
const REDIS_MOCK: RedisClient = { del: vi.fn().mockResolvedValue(1) };

function createReplayHarness() {
  const processedEvents = new Set<string>();
  const dbState = {
    events: new Map<string, any>(),
    markets: new Map<number, any>(),
    bets: new Map<string, any>(),
    leaderboard: new Map<string, any>(),
    tokenBalances: new Map<string, number>(),
    oracleSubmissions: new Map<number, any>(),
    oracleDisputes: new Map<number, any>(),
  };

  const db: DbClient = {
    query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
      const queryText = sql.trim();

      // CTE query used by bet_placed
      if (queryText.includes("WITH input AS")) {
        const txHash = String(params[1]);
        const eventIndex = Number(params[2]);
        const eventKey = `${txHash}:${eventIndex}`;
        const marketId = Number(params[5]);
        const bettor = String(params[6]);
        const netAmount = Number(params[7]);
        const grossAmount = Number(params[8]);
        const isYes = Boolean(params[9]);

        if (processedEvents.has(eventKey)) {
          return {
            rowCount: 1,
            rows: [{ side_valid: true, event_inserted: false, applied: false }],
          };
        }

        processedEvents.add(eventKey);
        const betKey = `${marketId}:${bettor}`;
        const existingBet = dbState.bets.get(betKey);
        const isNewBettor = !existingBet;

        dbState.bets.set(betKey, {
          market_id: marketId,
          bettor,
          net_amount: (existingBet?.net_amount ?? 0) + netAmount,
          gross_amount: (existingBet?.gross_amount ?? 0) + grossAmount,
          is_yes: isYes,
        });

        const currentMkt = dbState.markets.get(marketId) ?? {
          id: marketId,
          total_yes: 0,
          total_no: 0,
          bet_count: 0,
        };

        dbState.markets.set(marketId, {
          ...currentMkt,
          total_yes: currentMkt.total_yes + (isYes ? netAmount : 0),
          total_no: currentMkt.total_no + (isYes ? 0 : netAmount),
          bet_count: currentMkt.bet_count + (isNewBettor ? 1 : 0),
        });

        return {
          rowCount: 1,
          rows: [{ side_valid: true, event_inserted: true, applied: true }],
        };
      }

      // INSERT INTO events
      if (queryText.startsWith("INSERT INTO events")) {
        const txHash = String(params[1]);
        const eventIndex = Number(params[2]);
        const eventKey = `${txHash}:${eventIndex}`;

        if (processedEvents.has(eventKey)) {
          return { rowCount: 0, rows: [] };
        }
        processedEvents.add(eventKey);
        dbState.events.set(eventKey, { txHash, eventIndex, type: params[3] });
        return { rowCount: 1, rows: [] };
      }

      // Markets inserts/updates
      if (queryText.includes("INSERT INTO markets")) {
        const id = Number(params[0]);
        dbState.markets.set(id, {
          id,
          question: params[1],
          imageUrl: params[2],
          category: params[3],
          endTime: params[4],
          creator: params[5],
        });
        return { rowCount: 1, rows: [] };
      }

      if (queryText.includes("UPDATE markets") && queryText.includes("resolved = TRUE")) {
        const id = Number(params[0]);
        const current = dbState.markets.get(id) ?? {};
        dbState.markets.set(id, { ...current, resolved: true, outcome: params[1] });
        return { rowCount: 1, rows: [] };
      }

      if (queryText.includes("UPDATE markets") && queryText.includes("cancelled = TRUE")) {
        const id = Number(params[0]);
        const current = dbState.markets.get(id) ?? {};
        dbState.markets.set(id, { ...current, cancelled: true });
        return { rowCount: 1, rows: [] };
      }

      // Bets updates
      if (queryText.includes("UPDATE bets") && queryText.includes("SET claimed = true")) {
        const marketId = Number(params[0]);
        const bettor = String(params[1]);
        const betKey = `${marketId}:${bettor}`;
        const current = dbState.bets.get(betKey) ?? {};
        dbState.bets.set(betKey, { ...current, claimed: true });
        return { rowCount: 1, rows: [] };
      }

      // Leaderboard updates
      if (queryText.includes("INSERT INTO leaderboard")) {
        const address = String(params[0]);
        const named = queryText.includes("VALUES ($1, $2, $3");
        const displayName = named && params[1] != null ? String(params[1]) : null;
        const points = Number(params[named ? 2 : 1] ?? 0);
        const tracksWins = queryText.includes("VALUES ($1, NULL, $2, $3, $4");
        const wonBets = tracksWins ? Number(params[2]) : 0;
        const lostBets = tracksWins ? Number(params[3]) : 0;

        const current = dbState.leaderboard.get(address) ?? {
          address,
          display_name: null,
          points: 0,
          won_bets: 0,
          lost_bets: 0,
        };

        dbState.leaderboard.set(address, {
          address,
          display_name: displayName ?? current.display_name,
          points: current.points + points,
          won_bets: current.won_bets + wonBets,
          lost_bets: current.lost_bets + lostBets,
        });
        return { rowCount: 1, rows: [] };
      }

      // Token balance updates
      if (queryText.includes("INSERT INTO token_balances")) {
        const address = String(params[0]);
        const amount = Number(params[1]);
        const current = dbState.tokenBalances.get(address) ?? 0;
        dbState.tokenBalances.set(address, current + (queryText.includes("-$2") ? -amount : amount));
        return { rowCount: 1, rows: [] };
      }

      // Oracle submissions
      if (queryText.includes("INSERT INTO oracle_submissions")) {
        const marketId = Number(params[0]);
        if (!dbState.oracleSubmissions.has(marketId)) {
          dbState.oracleSubmissions.set(marketId, {
            marketId,
            submitter: params[1],
            outcome: params[2],
            bond: params[3],
            status: "submitted",
          });
        }
        return { rowCount: 1, rows: [] };
      }

      if (queryText.includes("UPDATE oracle_submissions") && queryText.includes("status = 'challenged'")) {
        const marketId = Number(params[0]);
        const current = dbState.oracleSubmissions.get(marketId);
        if (current) current.status = "challenged";
        return { rowCount: 1, rows: [] };
      }

      if (queryText.includes("UPDATE oracle_submissions") && queryText.includes("status = 'finalized'")) {
        const marketId = Number(params[0]);
        const current = dbState.oracleSubmissions.get(marketId);
        if (current) {
          current.status = "finalized";
          current.decision = params[1];
        }
        return { rowCount: 1, rows: [] };
      }

      // Oracle disputes
      if (queryText.includes("INSERT INTO oracle_disputes")) {
        const marketId = Number(params[0]);
        if (!dbState.oracleDisputes.has(marketId)) {
          dbState.oracleDisputes.set(marketId, {
            marketId,
            submitter: params[1],
            challenger: params[2],
            outcome: params[3],
            status: "challenged",
          });
        }
        return { rowCount: 1, rows: [] };
      }

      if (queryText.includes("UPDATE oracle_disputes") && queryText.includes("status = 'escalated'")) {
        const marketId = Number(params[0]);
        const current = dbState.oracleDisputes.get(marketId);
        if (current) current.status = "escalated";
        return { rowCount: 1, rows: [] };
      }

      return { rowCount: 1, rows: [] };
    }),
  };

  const context: HandlerContext = {
    db,
    redis: REDIS_MOCK,
    logger: { warn: vi.fn(), info: vi.fn() },
  };

  return {
    db,
    context,
    state: dbState,
    snapshot: () => JSON.parse(JSON.stringify({
      events: Array.from(dbState.events.entries()),
      markets: Array.from(dbState.markets.entries()),
      bets: Array.from(dbState.bets.entries()),
      leaderboard: Array.from(dbState.leaderboard.entries()),
      tokenBalances: Array.from(dbState.tokenBalances.entries()),
      oracleSubmissions: Array.from(dbState.oracleSubmissions.entries()),
      oracleDisputes: Array.from(dbState.oracleDisputes.entries()),
    })),
  };
}

describe("Indexer Event Handlers Idempotency Suite (#500)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handleBetPlacedEvent: double-processing produces identical state without double counting", async () => {
    const { db, snapshot } = createReplayHarness();
    const event: DecodedContractEvent = {
      ledger: 100,
      txHash: TX_HASH,
      eventIndex: 0,
      topics: ["bet", "placed", 1, USER],
      data: { market_id: 1, bettor: USER, is_yes: true, amount: "10000000", net_amount: "9800000", fee: "200000", is_increase: false },
    };

    await handleBetPlacedEvent(event, db, REDIS_MOCK);
    const snap1 = snapshot();

    await handleBetPlacedEvent(event, db, REDIS_MOCK);
    const snap2 = snapshot();

    expect(snap2).toEqual(snap1);
  });

  it("handleClaim: double-processing produces identical state", async () => {
    const { db, context, snapshot } = createReplayHarness();
    const event: DecodedEvent = {
      ledger: 100,
      txHash: TX_HASH,
      eventIndex: 0,
      topics: ["reward_claimed", 1, USER],
      data: { market_id: 1, user: USER, payout_xlm: 500000000 },
    };

    await handleClaim(event, context);
    const snap1 = snapshot();

    await handleClaim(event, context);
    const snap2 = snapshot();

    expect(snap2).toEqual(snap1);
  });

  it("handleFeeWithdrawn: double-processing is idempotent", async () => {
    const { context, snapshot } = createReplayHarness();
    const event: DecodedEvent = {
      ledger: 100,
      txHash: TX_HASH,
      eventIndex: 0,
      topics: ["fees_withdrawn"],
      data: { admin: USER, amount: "5000000" },
    };

    await handleFeeWithdrawn(event, context);
    const snap1 = snapshot();

    await handleFeeWithdrawn(event, context);
    const snap2 = snapshot();

    expect(snap2).toEqual(snap1);
  });

  it("handleMarketCreatedEvent: double-processing produces identical market state", async () => {
    const { db, snapshot } = createReplayHarness();
    const event: DecodedContractEvent = {
      ledger: 100,
      txHash: TX_HASH,
      eventIndex: 0,
      topics: ["mkt", "created"],
      data: { market_id: 1, question: "Will XLM reach $1?", category: "Crypto", end_time: 1770000000, creator: USER },
    };

    await handleMarketCreatedEvent(event, db, REDIS_MOCK);
    const snap1 = snapshot();

    await handleMarketCreatedEvent(event, db, REDIS_MOCK);
    const snap2 = snapshot();

    expect(snap2).toEqual(snap1);
  });

  it("handleMarketResolvedEvent: double-processing produces identical resolution state", async () => {
    const { db, snapshot } = createReplayHarness();
    const event: DecodedContractEvent = {
      ledger: 100,
      txHash: TX_HASH,
      eventIndex: 0,
      topics: ["market_resolved"],
      data: { market_id: 1, outcome: true },
    };

    await handleMarketResolvedEvent(event, db, REDIS_MOCK);
    const snap1 = snapshot();

    await handleMarketResolvedEvent(event, db, REDIS_MOCK);
    const snap2 = snapshot();

    expect(snap2).toEqual(snap1);
  });

  it("handleMarketCancelledEvent: double-processing produces identical cancellation state", async () => {
    const { db, snapshot } = createReplayHarness();
    const event: DecodedContractEvent = {
      ledger: 100,
      txHash: TX_HASH,
      eventIndex: 0,
      topics: ["mkt", "cancelled"],
      data: { market_id: 1 },
    };

    await handleMarketCancelledEvent(event, db, REDIS_MOCK);
    const snap1 = snapshot();

    await handleMarketCancelledEvent(event, db, REDIS_MOCK);
    const snap2 = snapshot();

    expect(snap2).toEqual(snap1);
  });

  it("handleRewardPoints: double-processing does NOT double-increment leaderboard points or win/loss counts", async () => {
    const { context, snapshot } = createReplayHarness();
    const event: DecodedEvent = {
      ledger: 100,
      txHash: TX_HASH,
      eventIndex: 0,
      topics: ["reward_points", USER, 30],
      data: { user: USER, points: 30, is_winner: true },
    };

    await handleRewardPoints(event, context);
    const snap1 = snapshot();

    await handleRewardPoints(event, context);
    const snap2 = snapshot();

    expect(snap2).toEqual(snap1);
  });

  it("handleTokenMint: double-processing does NOT double-increment token balances", async () => {
    const { context, snapshot } = createReplayHarness();
    const event: DecodedEvent = {
      ledger: 100,
      txHash: TX_HASH,
      eventIndex: 0,
      topics: ["token_mint"],
      data: { to: USER, amount: "100" },
    };

    await handleTokenMint(event, context);
    const snap1 = snapshot();

    await handleTokenMint(event, context);
    const snap2 = snapshot();

    expect(snap2).toEqual(snap1);
  });

  it("handleTokenTransfer: double-processing does NOT double-debit sender or double-credit recipient", async () => {
    const { context, snapshot, state } = createReplayHarness();
    state.tokenBalances.set(USER, 100);
    const event: DecodedEvent = {
      ledger: 100,
      txHash: TX_HASH,
      eventIndex: 0,
      topics: ["token_transfer"],
      data: { from: USER, to: REFERRER, amount: "25" },
    };

    await handleTokenTransfer(event, context);
    expect(state.tokenBalances.get(USER)).toBe(75);
    expect(state.tokenBalances.get(REFERRER)).toBe(25);
    const snap1 = snapshot();

    await handleTokenTransfer(event, context);
    const snap2 = snapshot();

    expect(snap2).toEqual(snap1);
  });

  it("handleReferralRegisteredEvent: double-processing produces identical leaderboard bonus points", async () => {
    const { db, snapshot } = createReplayHarness();
    const event: DecodedContractEvent = {
      ledger: 100,
      txHash: TX_HASH,
      eventIndex: 0,
      topics: ["referral", "registered"],
      data: { user: USER, display_name: "CryptoKing", referrer: REFERRER, welcome_points: 5, referrer_points: 5 },
    };

    await handleReferralRegisteredEvent(event, db, REDIS_MOCK);
    const snap1 = snapshot();

    await handleReferralRegisteredEvent(event, db, REDIS_MOCK);
    const snap2 = snapshot();

    expect(snap2).toEqual(snap1);
  });

  it("handleReferralRewardEvent: double-processing produces identical referrer bonus points", async () => {
    const { db, snapshot } = createReplayHarness();
    const event: DecodedContractEvent = {
      ledger: 100,
      txHash: TX_HASH,
      eventIndex: 0,
      topics: ["referral", "reward"],
      data: { referrer: REFERRER, points: 3 },
    };

    await handleReferralRewardEvent(event, db, REDIS_MOCK);
    const snap1 = snapshot();

    await handleReferralRewardEvent(event, db, REDIS_MOCK);
    const snap2 = snapshot();

    expect(snap2).toEqual(snap1);
  });

  it("handleOracleSubmission: double-processing produces identical submission state", async () => {
    const { context, snapshot } = createReplayHarness();
    const event: DecodedEvent = {
      ledger: 100,
      txHash: TX_HASH,
      eventIndex: 0,
      topics: ["submit_outcome", 1, USER],
      data: { market_id: 1, submitter: USER, outcome: true, bond_amount: "100000000" },
    };

    await handleOracleSubmission(event, context);
    const snap1 = snapshot();

    await handleOracleSubmission(event, context);
    const snap2 = snapshot();

    expect(snap2).toEqual(snap1);
  });

  it("handleOracleChallengedEvent & handleOracleEscalatedEvent: double-processing produces identical dispute state", async () => {
    const { db, snapshot } = createReplayHarness();
    const challengedEvent: DecodedContractEvent = {
      ledger: 100,
      txHash: TX_HASH,
      eventIndex: 0,
      topics: ["oracle", "challenged"],
      data: { market_id: 1, challenger: REFERRER, outcome: false, bond: "200000000", submitter: USER, submitter_bond: "100000000", challenged_at: "1700000100" },
    };

    const escalatedEvent: DecodedContractEvent = {
      ledger: 100,
      txHash: TX_HASH,
      eventIndex: 1,
      topics: ["oracle", "escalated"],
      data: { market_id: 1, submitter: USER, challenger: REFERRER, outcome: true, total_bond: "300000000", escalated_at: "1700000100", council_deadline: "1700259200" },
    };

    await handleOracleChallengedEvent(challengedEvent, db, REDIS_MOCK);
    await handleOracleEscalatedEvent(escalatedEvent, db, REDIS_MOCK);
    const snap1 = snapshot();

    await handleOracleChallengedEvent(challengedEvent, db, REDIS_MOCK);
    await handleOracleEscalatedEvent(escalatedEvent, db, REDIS_MOCK);
    const snap2 = snapshot();

    expect(snap2).toEqual(snap1);
  });

  it("handleOracleFinalizedEvent: double-processing produces identical finalized outcome state", async () => {
    const { db, snapshot } = createReplayHarness();
    const event: DecodedContractEvent = {
      ledger: 100,
      txHash: TX_HASH,
      eventIndex: 0,
      topics: ["oracle", "finalized"],
      data: { market_id: 1, outcome: true, challenged: false, submitter: USER, challenger: null, submitter_payout: "100000000", challenger_payout: "0", council_fee: "0", protocol_credit: "0", finalized_at: "1700259300" },
    };

    await handleOracleFinalizedEvent(event, db, REDIS_MOCK);
    const snap1 = snapshot();

    await handleOracleFinalizedEvent(event, db, REDIS_MOCK);
    const snap2 = snapshot();

    expect(snap2).toEqual(snap1);
  });
});
