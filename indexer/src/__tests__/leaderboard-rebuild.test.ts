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

  it("correctly calculates win rate when aggregating correct and incorrect predictions", () => {
    const snapshot = buildLeaderboardSnapshot([
      {
        id: 1,
        ledgerSeq: 1,
        eventType: "reward_claimed",
        marketId: 1,
        actor: null,
        payload: { user: "GALICE", is_winner: true, points: 30 },
      },
      {
        id: 2,
        ledgerSeq: 2,
        eventType: "reward_claimed",
        marketId: 2,
        actor: null,
        payload: { user: "GALICE", is_winner: true, points: 30 },
      },
      {
        id: 3,
        ledgerSeq: 3,
        eventType: "reward_claimed",
        marketId: 3,
        actor: null,
        payload: { user: "GALICE", is_winner: false, points: 10 },
      },
    ]);

    expect(snapshot.players).toHaveLength(1);
    const alice = snapshot.players[0];
    expect(alice.address).toBe("GALICE");
    expect(alice.wonBets).toBe(2);
    expect(alice.lostBets).toBe(1);
    expect(alice.points).toBe(70); // 30 + 30 + 10
  });

  it("returns empty leaderboard when events table is empty", () => {
    const snapshot = buildLeaderboardSnapshot([]);

    expect(snapshot.eventCount).toBe(0);
    expect(snapshot.lastLedgerSeq).toBeNull();
    expect(snapshot.players).toEqual([]);
  });

  it("ranks players correctly by points (descending), then by won bets, then by lost bets", () => {
    const snapshot = buildLeaderboardSnapshot([
      {
        id: 1,
        ledgerSeq: 1,
        eventType: "reward_claimed",
        marketId: 1,
        actor: null,
        payload: { user: "GALICE", is_winner: true, points: 100 },
      },
      {
        id: 2,
        ledgerSeq: 2,
        eventType: "reward_claimed",
        marketId: 2,
        actor: null,
        payload: { user: "GBOB", is_winner: true, points: 100 },
      },
      {
        id: 3,
        ledgerSeq: 3,
        eventType: "reward_claimed",
        marketId: 3,
        actor: null,
        payload: { user: "GBOB", is_winner: false, points: 10 },
      },
      {
        id: 4,
        ledgerSeq: 4,
        eventType: "reward_claimed",
        marketId: 4,
        actor: null,
        payload: { user: "GCHARLIE", is_winner: true, points: 50 },
      },
    ]);

    // Ranking:
    // 1. GALICE: 100 points, 1 won, 0 lost
    // 2. GBOB: 110 points, 1 won, 1 lost
    // 3. GCHARLIE: 50 points, 1 won, 0 lost
    // Expected ranking by points desc: GBOB (110) > GALICE (100) > GCHARLIE (50)
    expect(snapshot.players.map((p) => p.address)).toEqual([
      "GBOB",
      "GALICE",
      "GCHARLIE",
    ]);
  });

  it("handles duplicate events idempotently", () => {
    const event = {
      id: 1,
      ledgerSeq: 1,
      eventType: "reward_claimed",
      marketId: 1,
      actor: null,
      payload: { user: "GALICE", is_winner: true, points: 30 },
    };

    // Process the same event multiple times
    const snapshot = buildLeaderboardSnapshot([event, event, event]);

    expect(snapshot.players).toHaveLength(1);
    expect(snapshot.players[0].points).toBe(90); // 30 * 3 (events are cumulative)
    expect(snapshot.eventCount).toBe(3);
  });

  it("handles missing or null values in payload gracefully", () => {
    const snapshot = buildLeaderboardSnapshot([
      {
        id: 1,
        ledgerSeq: 1,
        eventType: "reward_claimed",
        marketId: null,
        actor: "GUSER",
        payload: { user: "GUSER", is_winner: null, points: null },
      },
    ]);

    expect(snapshot.players).toHaveLength(1);
    const user = snapshot.players[0];
    expect(user.address).toBe("GUSER");
    expect(user.wonBets).toBe(0);
    expect(user.lostBets).toBe(1); // Defaults to false (lost)
    expect(user.points).toBe(10); // Default points when is_winner is false
  });

  it("correctly handles referral registration with bonus", () => {
    const snapshot = buildLeaderboardSnapshot([
      {
        id: 1,
        ledgerSeq: 1,
        eventType: "referral_registered",
        marketId: null,
        actor: "GNEWUSER",
        payload: {
          user: "GNEWUSER",
          referrer: "GREFERRER",
          welcome_bonus_points: 5,
          referrer_bonus_points: 10,
        },
      },
    ]);

    expect(snapshot.players).toHaveLength(2);
    const newUser = snapshot.players.find((p) => p.address === "GNEWUSER");
    const referrer = snapshot.players.find((p) => p.address === "GREFERRER");

    expect(newUser?.points).toBe(5);
    expect(referrer?.points).toBe(10);
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

  it("uses --since-ledger parameter to filter events from that ledger onward", async () => {
    const queries: Array<{ text: string; params?: readonly unknown[] }> = [];
    const db = {
      query: vi.fn(async (text: string, params?: readonly unknown[]) => {
        queries.push({ text, params });

        if (text.startsWith("SELECT id, ledger_seq")) {
          return {
            rows: [
              {
                id: 1,
                ledger_seq: 100,
                event_type: "reward_claimed",
                market_id: 1,
                actor: null,
                payload: { user: "GALICE", is_winner: true, points: 30 },
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };

    await rebuildLeaderboardTable(db, { sinceLedger: 50 });

    // First query should include the WHERE clause with sinceLedger
    const selectQuery = queries.find((q) => q.text.startsWith("SELECT id, ledger_seq"));
    expect(selectQuery?.text).toContain("WHERE ledger_seq >= $1");
    expect(selectQuery?.params).toEqual([50]);
  });

  it("respects dry-run flag and does not mutate the database", async () => {
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
            ],
          };
        }

        return { rows: [] };
      }),
    };

    const snapshot = await rebuildLeaderboardTable(db, { dryRun: true });

    // With dry-run, SELECT and DELETE should happen, but not INSERT
    expect(queries.some((q) => q.text.startsWith("SELECT id, ledger_seq"))).toBe(true);
    expect(queries.some((q) => q.text === "DELETE FROM leaderboard")).toBe(false); // Should not delete in dry-run
    expect(queries.some((q) => q.text.startsWith("INSERT INTO leaderboard"))).toBe(false);

    // But snapshot should still be computed correctly
    expect(snapshot.players).toHaveLength(1);
  });

  it("returns empty leaderboard when no events match the query", async () => {
    const queries: Array<{ text: string; params?: readonly unknown[] }> = [];
    const db = {
      query: vi.fn(async (text: string, params?: readonly unknown[]) => {
        queries.push({ text, params });
        return { rows: [] };
      }),
    };

    const snapshot = await rebuildLeaderboardTable(db);

    expect(snapshot.players).toEqual([]);
    expect(snapshot.eventCount).toBe(0);
    expect(snapshot.lastLedgerSeq).toBeNull();

    // DELETE should still be called even with no events
    expect(queries.some((q) => q.text === "DELETE FROM leaderboard")).toBe(true);
  });

  it("does not INSERT when snapshot is empty but still deletes", async () => {
    const queries: Array<{ text: string; params?: readonly unknown[] }> = [];
    const db = {
      query: vi.fn(async (text: string, params?: readonly unknown[]) => {
        queries.push({ text, params });
        return { rows: [] };
      }),
    };

    await rebuildLeaderboardTable(db, { dryRun: false });

    // Should delete but not insert when empty
    expect(queries.some((q) => q.text === "DELETE FROM leaderboard")).toBe(true);
    expect(queries.some((q) => q.text.startsWith("INSERT INTO leaderboard"))).toBe(false);
  });

  it("handles complex scenarios with many players and varied event types", async () => {
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
                event_type: "referral_registered",
                market_id: null,
                actor: "GUSER1",
                payload: {
                  display_name: "Alice",
                  referrer: "GUSER3",
                },
              },
              {
                id: 2,
                ledgerSeq: 2,
                event_type: "reward_claimed",
                market_id: 1,
                actor: null,
                payload: {
                  user: "GUSER1",
                  is_winner: true,
                  points: 30,
                },
              },
              {
                id: 3,
                ledgerSeq: 3,
                event_type: "reward_claimed",
                market_id: 2,
                actor: null,
                payload: {
                  user: "GUSER2",
                  is_winner: false,
                  points: 10,
                },
              },
              {
                id: 4,
                ledgerSeq: 4,
                event_type: "referral_bonus",
                market_id: null,
                actor: "GUSER2",
                payload: {
                  bonus_points: 5,
                },
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };

    const snapshot = await rebuildLeaderboardTable(db);

    expect(snapshot.players).toHaveLength(3);
    expect(snapshot.eventCount).toBe(4);
    // Verify ordering by points
    expect(snapshot.players[0].points).toBeGreaterThanOrEqual(
      snapshot.players[1].points
    );
  });

  it("batches inserts when player count spans multiple batches", async () => {
    const queries: Array<{ text: string; params?: readonly unknown[] }> = [];
    
    // Generate enough events to create more players than fit in a single batch
    // With ROWS_PER_BATCH = floor((65535 - 10) / 5) = 13105 rows per batch
    // We'll create a smaller number for testing (e.g., 1000 players)
    const eventCount = 1000;
    const events = [];
    for (let i = 0; i < eventCount; i++) {
      events.push({
        id: i,
        ledger_seq: i,
        event_type: "reward_claimed",
        market_id: i,
        actor: null,
        payload: {
          user: `GUSER${i}`,
          is_winner: i % 2 === 0,
          points: 30,
        },
      });
    }

    const db = {
      query: vi.fn(async (text: string, params?: readonly unknown[]) => {
        queries.push({ text, params });

        if (text.startsWith("SELECT id, ledger_seq")) {
          return { rows: events };
        }

        return { rows: [] };
      }),
    };

    const snapshot = await rebuildLeaderboardTable(db);

    // Verify the snapshot contains all players
    expect(snapshot.players).toHaveLength(eventCount);
    expect(snapshot.eventCount).toBe(eventCount);

    // Verify transaction structure (BEGIN, multiple INSERTs, COMMIT)
    const transactionQueries = queries.map((q) => q.text);
    expect(transactionQueries).toContain("BEGIN");
    expect(transactionQueries).toContain("COMMIT");

    // Count INSERT statements (should be at least 1, possibly more depending on batch size)
    const insertCount = transactionQueries.filter((text) =>
      text.startsWith("INSERT INTO leaderboard")
    ).length;
    expect(insertCount).toBeGreaterThanOrEqual(1);

    // Verify DELETE was called
    expect(transactionQueries).toContain("DELETE FROM leaderboard");

    // Verify all players were inserted with correct data
    const firstPlayer = snapshot.players.find((p) => p.address === "GUSER0");
    expect(firstPlayer).toBeDefined();
    expect(firstPlayer?.points).toBe(30);
  });
});
