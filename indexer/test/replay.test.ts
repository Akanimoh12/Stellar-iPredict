import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeEventToDb } from "../src/event-router.js";
import { dispatchEvent } from "../src/handlers/index.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../src/types.js";
import type { DecodedEvent, HandlerContext } from "../src/handlers/types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ADMIN = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM";
const BETTOR = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBNZ5H";
const CHALLENGER = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

// A representative sequenced ledger batch: market lifecycle plus reward/mint
// events that touch the distinct write paths (markets, bets, leaderboard,
// token_balances, oracle_disputes, oracle_submissions, events).
function ledgerBatch(): DecodedContractEvent[] {
  const tx = (n: number) => n.toString().padStart(64, "0");
  return [
    {
      ledger: 100,
      txHash: tx(1),
      eventIndex: 0,
      topics: ["mkt", "cancelled"],
      data: { market_id: 7 },
    },
    {
      ledger: 100,
      txHash: tx(1),
      eventIndex: 1,
      topics: ["bet", "placed", 7, BETTOR],
      data: { market_id: 7, bettor: BETTOR, is_yes: true, amount: "10000000", net_amount: "9800000", fee: "200000", is_increase: false },
    },
    {
      ledger: 111,
      txHash: tx(3),
      eventIndex: 0,
      topics: ["oracle", "challenged"],
      data: { market_id: 7, challenger: CHALLENGER, outcome: false, bond: 200_0000000n, submitter: ADMIN, submitter_bond: 100_0000000n, challenged_at: 1_700_000_100n },
    },
    {
      ledger: 111,
      txHash: tx(3),
      eventIndex: 1,
      topics: ["oracle", "escalated"],
      data: { market_id: 7, submitter: ADMIN, challenger: CHALLENGER, outcome: true, total_bond: 300_0000000n, escalated_at: 1_700_000_100n, council_deadline: 1_700_259_200n },
    },
    {
      ledger: 200,
      txHash: tx(4),
      eventIndex: 0,
      topics: ["oracle", "finalized"],
      data: { market_id: 7, outcome: true, challenged: true, submitter: ADMIN, challenger: CHALLENGER, submitter_payout: 200_0000000n, challenger_payout: 0n, council_fee: 100_000000n, protocol_credit: 100_000000n, finalized_at: 1_700_259_300n },
    },
  ];
}

// A second batch flowing through the registry-based (dispatchEvent) handlers.
function registryBatch(): DecodedEvent[] {
  const tx = (n: number) => n.toString().padStart(64, "0");
  return [
    {
      ledger: 300,
      txHash: tx(5),
      eventIndex: 0,
      topics: ["reward_points", BETTOR, 30],
      data: { user: BETTOR, points: 30, is_winner: true },
    },
    {
      ledger: 300,
      txHash: tx(5),
      eventIndex: 1,
      topics: ["token_mint"],
      data: { to: BETTOR, amount: "100000000" },
    },
  ];
}

// An in-memory database that models the incremental writes each handler makes,
// so a replayed batch either no-ops (idempotent) or converges to the same state.
function createInMemoryDb() {
  const state = {
    events: new Set<string>(),
    markets: new Map<number, { cancelled: boolean; resolved: boolean; outcome: boolean | null }>(),
    bets: new Map<string, { is_yes: boolean }>(),
    oracleSubmissions: new Map<number, { status: string; decision: boolean | null }>(),
    oracleDisputes: new Map<number, { status: string }>(),
    leaderboard: new Map<string, { points: number; won_bets: number; lost_bets: number }>(),
    tokenBalances: new Map<string, number>(),
  };

  const db: DbClient = {
    query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
      const has = (needle: string) => sql.includes(needle);

      if (has("INSERT INTO events")) {
        const key = `${String(params[1])}:${String(params[2])}`;
        if (state.events.has(key)) return { rowCount: 0, rows: [] };
        state.events.add(key);
        return { rowCount: 1, rows: [] };
      }

      if (has("INSERT INTO markets") || has("UPDATE markets")) {
        const id = Number(params[0]);
        const current = state.markets.get(id) ?? { cancelled: false, resolved: false, outcome: null };
        state.markets.set(id, {
          cancelled: has("cancelled = TRUE") ? true : current.cancelled,
          resolved: has("resolved = TRUE") ? true : current.resolved,
          outcome: has("outcome = $2") ? Boolean(params[1]) : current.outcome,
        });
        return { rowCount: 1, rows: [] };
      }

      if (has("INSERT INTO bets") || has("UPDATE bets")) {
        const key = `${String(params[0])}:${String(params[1])}`;
        if (has("SET claimed")) {
          return { rowCount: 1, rows: [] };
        }
        state.bets.set(key, { is_yes: Boolean(params[4]) });
        return { rowCount: 1, rows: [] };
      }

      if (has("INSERT INTO oracle_submissions")) {
        const id = Number(params[0]);
        state.oracleSubmissions.set(id, { status: String(params[4]), decision: null });
        return { rowCount: 1, rows: [] };
      }

      if (has("UPDATE oracle_submissions SET status = 'challenged'")) {
        const id = Number(params[0]);
        state.oracleSubmissions.set(id, { status: "challenged", decision: null });
        return { rowCount: 1, rows: [] };
      }

      if (has("UPDATE oracle_submissions") && has("decision")) {
        const id = Number(params[0]);
        state.oracleSubmissions.set(id, { status: "finalized", decision: Boolean(params[1]) });
        return { rowCount: 1, rows: [] };
      }

      if (has("INSERT INTO oracle_disputes")) {
        const id = Number(params[0]);
        state.oracleDisputes.set(id, { status: "challenged" });
        return { rowCount: 1, rows: [] };
      }

      if (has("UPDATE oracle_disputes") && has("status = 'escalated'")) {
        const id = Number(params[0]);
        state.oracleDisputes.set(id, { status: "escalated" });
        return { rowCount: 1, rows: [] };
      }

      if (has("INSERT INTO leaderboard")) {
        const address = String(params[0]);
        const current = state.leaderboard.get(address) ?? { points: 0, won_bets: 0, lost_bets: 0 };
        state.leaderboard.set(address, {
          points: current.points + Number(params[1] ?? 0),
          won_bets: current.won_bets + Number(params[2] ?? 0),
          lost_bets: current.lost_bets + Number(params[3] ?? 0),
        });
        return { rowCount: 1, rows: [] };
      }

      if (has("INSERT INTO token_balances")) {
        const address = String(params[0]);
        state.tokenBalances.set(address, (state.tokenBalances.get(address) ?? 0) + Number(params[1]));
        return { rowCount: 1, rows: [] };
      }

      return { rowCount: 1, rows: [] };
    }),
  };

  return {
    db,
    state,
    snapshot: () => ({
      events: Array.from(state.events.values()).sort(),
      markets: Array.from(state.markets.entries()).sort(),
      bets: Array.from(state.bets.entries()).sort(),
      oracleSubmissions: Array.from(state.oracleSubmissions.entries()).sort(),
      oracleDisputes: Array.from(state.oracleDisputes.entries()).sort(),
      leaderboard: Array.from(state.leaderboard.entries()).sort(),
      tokenBalances: Array.from(state.tokenBalances.entries()).sort(),
    }),
  };
}

const redis: RedisClient = { del: vi.fn().mockResolvedValue(1) };

function registryContext(db: DbClient): HandlerContext {
  return {
    db,
    redis: { del: vi.fn().mockResolvedValue(1) },
    logger: { warn: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Issue #231: replay a ledger batch twice, assert no drift ────────────────

describe("idempotent replay of a ledger batch", () => {
  it("produces identical state after replaying the router batch twice", async () => {
    const { db, snapshot } = createInMemoryDb();
    const batch = ledgerBatch();

    for (const event of batch) {
      await writeEventToDb(event, db, redis);
    }
    const afterFirstReplay = snapshot();

    for (const event of batch) {
      await writeEventToDb(event, db, redis);
    }
    const afterSecondReplay = snapshot();

    expect(afterSecondReplay).toEqual(afterFirstReplay);

    // The oracle dispute and submission should be in their terminal states.
    expect(afterSecondReplay.oracleDisputes).toContainEqual([7, { status: "escalated" }]);
    expect(afterSecondReplay.oracleSubmissions).toContainEqual([7, { status: "finalized", decision: true }]);
  });

  it("produces identical derived state after replaying the registry batch twice", async () => {
    const { db, snapshot } = createInMemoryDb();
    const context = registryContext(db);
    const batch = registryBatch();

    for (const event of batch) {
      await dispatchEvent(event, context);
    }
    const afterFirstReplay = snapshot();

    for (const event of batch) {
      await dispatchEvent(event, context);
    }
    const afterSecondReplay = snapshot();

    expect(afterSecondReplay).toEqual(afterFirstReplay);

    // Points and minted balance are applied exactly once.
    expect(afterSecondReplay.leaderboard).toContainEqual([BETTOR, { points: 30, won_bets: 1, lost_bets: 0 }]);
    expect(afterSecondReplay.tokenBalances).toContainEqual([BETTOR, 100000000]);
  });

  it("never grows the events table on a replayed batch", async () => {
    const { db, snapshot } = createInMemoryDb();
    const batch = [...ledgerBatch(), ...ledgerBatch()];

    for (const event of batch) {
      await writeEventToDb(event, db, redis);
    }
    // A duplicated batch must not create duplicate event rows (idempotency by
    // tx_hash + event_index) nor drift any derived table.
    expect(snapshot().events).toHaveLength(ledgerBatch().length);
  });
});
