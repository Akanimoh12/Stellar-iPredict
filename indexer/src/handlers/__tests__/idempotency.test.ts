import { describe, expect, it, vi } from "vitest";
import { handleRewardPoints, REWARD_POINTS_TOPIC } from "../reward_points.js";
import { handleTokenMint, TOKEN_MINT_TOPIC } from "../token_mint.js";
import type { DecodedEvent, HandlerContext } from "../types.js";

const USER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TX_HASH = "1".repeat(64);

function createReplayContext() {
  const processedEvents = new Set<string>();
  const state = {
    leaderboard: new Map<string, { points: number; won_bets: number; lost_bets: number }>(),
    tokenBalances: new Map<string, number>(),
  };

  const context: HandlerContext = {
    db: {
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("INSERT INTO events")) {
          const eventKey = `${String(params[1])}:${String(params[2])}`;
          if (processedEvents.has(eventKey)) return { rows: [], rowCount: 0 };
          processedEvents.add(eventKey);
          return { rows: [], rowCount: 1 };
        }

        if (sql.includes("INSERT INTO leaderboard")) {
          const address = String(params[0]);
          const current = state.leaderboard.get(address) ?? { points: 0, won_bets: 0, lost_bets: 0 };
          state.leaderboard.set(address, {
            points: current.points + Number(params[1]),
            won_bets: current.won_bets + Number(params[2]),
            lost_bets: current.lost_bets + Number(params[3]),
          });
          return { rows: [], rowCount: 1 };
        }

        if (sql.includes("INSERT INTO token_balances")) {
          const address = String(params[0]);
          const current = state.tokenBalances.get(address) ?? 0;
          state.tokenBalances.set(address, current + Number(params[1]));
          return { rows: [], rowCount: 1 };
        }

        return { rows: [], rowCount: 1 };
      }),
    },
    redis: { del: vi.fn().mockResolvedValue(undefined) },
    logger: { warn: vi.fn() },
  };

  return {
    context,
    snapshot: () => ({
      leaderboard: Array.from(state.leaderboard.entries()),
      tokenBalances: Array.from(state.tokenBalances.entries()),
      processedEvents: Array.from(processedEvents.values()),
    }),
  };
}

describe("handler event idempotency", () => {
  it("replays a batch twice without drifting derived state", async () => {
    const { context, snapshot } = createReplayContext();
    const batch: DecodedEvent[] = [
      {
        ledger: 100,
        txHash: TX_HASH,
        eventIndex: 0,
        topics: [REWARD_POINTS_TOPIC, USER, 30],
        data: { user: USER, points: 30, is_winner: true },
      },
      {
        ledger: 100,
        txHash: TX_HASH,
        eventIndex: 1,
        topics: [TOKEN_MINT_TOPIC],
        data: { to: USER, amount: "15" },
      },
    ];

    for (const event of batch) {
      if (event.topics[0] === REWARD_POINTS_TOPIC) await handleRewardPoints(event, context);
      if (event.topics[0] === TOKEN_MINT_TOPIC) await handleTokenMint(event, context);
    }
    const afterFirstReplay = snapshot();

    for (const event of batch) {
      if (event.topics[0] === REWARD_POINTS_TOPIC) await handleRewardPoints(event, context);
      if (event.topics[0] === TOKEN_MINT_TOPIC) await handleTokenMint(event, context);
    }

    expect(snapshot()).toEqual(afterFirstReplay);
  });
});
