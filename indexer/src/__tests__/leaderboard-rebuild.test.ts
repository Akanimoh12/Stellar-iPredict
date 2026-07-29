import { describe, expect, it, vi } from "vitest";
import { buildLeaderboardSnapshot, rebuildLeaderboardTable } from "../leaderboard-rebuild.js";

describe("buildLeaderboardSnapshot", () => {
  it("replays claim and referral events into a sorted leaderboard snapshot", () => {
    const snapshot = buildLeaderboardSnapshot([
      {
        id: 1,
        ledgerSeq: 10,
        eventType: "referral_registered",
        marketId: null,
        actor: "GUSER1",
        payload: {
          display_name: "Ada",
          referrer: "GREF",
        },
      },
      {
        id: 2,
        ledgerSeq: 11,
        eventType: "reward_claimed",
        marketId: 7,
        actor: null,
        payload: {
          user: "GUSER1",
          is_winner: true,
          points: 30,
        },
      },
      {
        id: 3,
        ledgerSeq: 12,
        eventType: "referral_credited",
        marketId: 7,
        actor: "GUSER1",
        payload: {
          referrer: "GREF",
          bonus_points: 3,
        },
      },
      {
        id: 4,
        ledgerSeq: 13,
        eventType: "reward_claimed",
        marketId: 8,
        actor: null,
        payload: {
          user: "GUSER2",
          is_winner: false,
        },
      },
    ]);

    expect(snapshot.eventCount).toBe(4);
    expect(snapshot.lastLedgerSeq).toBe(13);
    expect(snapshot.players).toEqual([
      {
        address: "GUSER1",
        displayName: "Ada",
        points: 35,
        wonBets: 1,
        lostBets: 0,
      },
      {
        address: "GUSER2",
        displayName: "",
        points: 10,
        wonBets: 0,
        lostBets: 1,
      },
      {
        address: "GREF",
        displayName: "",
        points: 8,
        wonBets: 0,
        lostBets: 0,
      },
    ]);
  });
});

describe("rebuildLeaderboardTable", () => {
  it("loads events, clears the leaderboard, and inserts the rebuilt rows", async () => {
    const queries: Array<{ text: string; params?: readonly unknown[] }> = [];
    const db = {
      query: vi.fn(async (text: string, params?: readonly unknown[]) => {
        queries.push({ text, params });

        if (text.startsWith("SELECT id, ledger_seq")) {
          return {
            rows: [
              {
                id: 1,
                ledger_seq: 1,
                event_type: "reward_claimed",
                market_id: 1,
                actor: null,
                payload: { user: "GALICE", is_winner: true, points: 30 },
              },
              {
                id: 2,
                ledger_seq: 2,
                event_type: "referral_credited",
                market_id: 1,
                actor: "GALICE",
                payload: { referrer: "GBOB", bonus_points: 3 },
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };

    const snapshot = await rebuildLeaderboardTable(db);

    expect(snapshot.players).toEqual([
      {
        address: "GALICE",
        displayName: "",
        points: 30,
        wonBets: 1,
        lostBets: 0,
      },
      {
        address: "GBOB",
        displayName: "",
        points: 3,
        wonBets: 0,
        lostBets: 0,
      },
    ]);

    expect(queries[0]?.text).toContain("FROM events");
    expect(queries[1]?.text).toBe("DELETE FROM leaderboard");
    expect(queries[2]?.text).toContain("INSERT INTO leaderboard");
    expect(queries[2]?.params).toEqual([
      "GALICE",
      null,
      30,
      1,
      0,
      "GBOB",
      null,
      3,
      0,
      0,
    ]);
  });
});
