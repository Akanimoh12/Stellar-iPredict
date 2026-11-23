import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import pg from "pg";
import {
  buildLeaderboardSnapshot,
  rebuildLeaderboardTable,
} from "../../leaderboard-rebuild.js";

const { Pool } = pg;

// Stellar addresses are exactly 56 chars — use padded test addresses so
// CHAR(56) storage doesn't introduce trailing-space keys in the player Map.
const ALICE = "GALICE" + "A".repeat(50); // 56 chars
const BOB   = "GBOB"   + "B".repeat(52); // 56 chars
const CAROL = "GCAROL" + "C".repeat(50); // 56 chars
const DAVE  = "GDAVE"  + "D".repeat(51); // 56 chars
const EVE   = "GEVE"   + "E".repeat(52); // 56 chars

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id          BIGSERIAL PRIMARY KEY,
    ledger_seq  BIGINT NOT NULL,
    tx_hash     CHAR(64) NOT NULL DEFAULT '',
    event_type  VARCHAR(50) NOT NULL,
    market_id   BIGINT,
    actor       CHAR(56),
    payload     JSONB,
    created_at  TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS leaderboard (
    address      CHAR(56) PRIMARY KEY,
    display_name VARCHAR(50),
    points       BIGINT NOT NULL DEFAULT 0,
    won_bets     INTEGER NOT NULL DEFAULT 0,
    lost_bets    INTEGER NOT NULL DEFAULT 0,
    updated_at   TIMESTAMP DEFAULT NOW()
  );
`;

let container: StartedTestContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "ipredict_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage("database system is ready to accept connections", 2),
    )
    .start();

  pool = new Pool({
    connectionString: `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/ipredict_test`,
  });

  await pool.query(SCHEMA);
});

afterAll(async () => {
  if (pool) {
    await pool.end();
  }
  if (container) {
    await container.stop();
  }
});

describe("leaderboard-rebuild integration", () => {
  it("rebuildLeaderboardTable writes correct rows to a real Postgres", async () => {
    await pool.query("DELETE FROM leaderboard");
    await pool.query("DELETE FROM events");

    await pool.query(
      `INSERT INTO events (ledger_seq, event_type, market_id, actor, payload) VALUES
        ($1, 'referral_registered', NULL, $2, $3::jsonb),
        ($4, 'reward_claimed',      1,    NULL, $5::jsonb),
        ($6, 'referral_credited',   1,    $7,   $8::jsonb),
        ($9, 'reward_claimed',      2,    NULL, $10::jsonb)`,
      [
        100, ALICE,
        JSON.stringify({ user: ALICE, display_name: "Alice", referrer: BOB }),
        101, JSON.stringify({ user: ALICE, is_winner: true, points: 50 }),
        102, ALICE,
        JSON.stringify({ referrer: BOB, bonus_points: 5 }),
        103, JSON.stringify({ user: CAROL, is_winner: false }),
      ],
    );

    const snapshot = await rebuildLeaderboardTable(pool);

    expect(snapshot.eventCount).toBe(4);
    expect(snapshot.lastLedgerSeq).toBe(103);
    expect(snapshot.players).toHaveLength(3);

    const alice = snapshot.players.find((p) => p.address.trim() === ALICE);
    expect(alice).toBeDefined();
    expect(alice!.points).toBe(55);
    expect(alice!.wonBets).toBe(1);
    expect(alice!.displayName).toBe("Alice");

    const bob = snapshot.players.find((p) => p.address.trim() === BOB);
    expect(bob).toBeDefined();
    expect(bob!.points).toBe(10);

    const { rows: dbRows } = await pool.query<{ points: string }>(
      "SELECT points FROM leaderboard ORDER BY points DESC",
    );
    expect(dbRows).toHaveLength(3);
    expect(dbRows[0]!.points).toBe("55");
  });

  it("dry-run does not mutate the leaderboard table", async () => {
    await pool.query("DELETE FROM leaderboard");
    await pool.query("DELETE FROM events");

    await pool.query(
      `INSERT INTO events (ledger_seq, event_type, market_id, actor, payload) VALUES
        ($1, 'reward_claimed', 3, NULL, $2::jsonb)`,
      [200, JSON.stringify({ user: DAVE, is_winner: true, points: 20 })],
    );

    const snapshot = await rebuildLeaderboardTable(pool, { dryRun: true });

    expect(snapshot.players).toHaveLength(1);
    expect(snapshot.players[0]!.points).toBe(20);

    const { rows } = await pool.query("SELECT * FROM leaderboard");
    expect(rows).toHaveLength(0);
  });

  it("sinceLedger filters events before the given ledger", async () => {
    await pool.query("DELETE FROM leaderboard");
    await pool.query("DELETE FROM events");

    await pool.query(
      `INSERT INTO events (ledger_seq, event_type, market_id, actor, payload) VALUES
        ($1, 'reward_claimed', 1, NULL, $2::jsonb),
        ($3, 'reward_claimed', 2, NULL, $4::jsonb)`,
      [
        10, JSON.stringify({ user: EVE, is_winner: true, points: 30 }),
        20, JSON.stringify({ user: EVE, is_winner: true, points: 40 }),
      ],
    );

    const snapshot = await rebuildLeaderboardTable(pool, { sinceLedger: 15 });

    expect(snapshot.eventCount).toBe(1);
    expect(snapshot.players[0]!.points).toBe(40);
  });

  it("buildLeaderboardSnapshot produces stable sorted output for ties", () => {
    const snapshot = buildLeaderboardSnapshot([
      {
        id: 1,
        ledgerSeq: 1,
        eventType: "reward_claimed",
        marketId: 1,
        actor: null,
        payload: { user: "GA", is_winner: true, points: 10 },
      },
      {
        id: 2,
        ledgerSeq: 2,
        eventType: "reward_claimed",
        marketId: 1,
        actor: null,
        payload: { user: "GB", is_winner: true, points: 10 },
      },
    ]);

    expect(snapshot.players).toHaveLength(2);
    expect(snapshot.players[0]!.address).toBe("GA");
    expect(snapshot.players[1]!.address).toBe("GB");
  });
});
