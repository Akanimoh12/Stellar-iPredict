import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import pg from "pg";
import { handleBetPlacedEvents } from "../../handlers/bet_placed.js";
import { processLedgerBatchWithCheckpoint } from "../../db.js";
import type { DbClient, DecodedContractEvent, RedisClient } from "../../types.js";

const { Pool } = pg;
const ALICE = "G" + "A".repeat(55);
const BOB = "G" + "B".repeat(55);

const SCHEMA = `
  CREATE TABLE markets (
    id BIGINT PRIMARY KEY,
    total_yes NUMERIC(30,7) NOT NULL DEFAULT 0,
    total_no NUMERIC(30,7) NOT NULL DEFAULT 0,
    bet_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE bets (
    market_id BIGINT NOT NULL REFERENCES markets(id),
    bettor CHAR(56) NOT NULL,
    net_amount NUMERIC(30,7) NOT NULL,
    gross_amount NUMERIC(30,7) NOT NULL,
    is_yes BOOLEAN NOT NULL,
    PRIMARY KEY (market_id, bettor)
  );
  CREATE TABLE events (
    id BIGSERIAL PRIMARY KEY,
    ledger_seq BIGINT NOT NULL,
    tx_hash CHAR(64) NOT NULL,
    event_index BIGINT NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    market_id BIGINT,
    actor CHAR(56),
    payload JSONB,
    UNIQUE (tx_hash, event_index)
  );
  CREATE TABLE checkpoints (
    id INTEGER PRIMARY KEY,
    last_ledger_seq BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

let container: StartedTestContainer;
let pool: pg.Pool;
const redis: RedisClient = { del: vi.fn().mockResolvedValue(1) };

function bet(
  txCharacter: string,
  eventIndex: number,
  bettor: string,
  netAmount: string,
  isYes = true,
  marketId = 7,
): DecodedContractEvent {
  return {
    ledger: 900,
    txHash: txCharacter.repeat(64),
    eventIndex,
    topics: ["bet_placed", marketId, bettor],
    data: {
      is_yes: isYes,
      amount: String(BigInt(netAmount) + 2n),
      net_amount: netAmount,
      fee: "2",
      is_increase: eventIndex > 0,
    },
  };
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "ipredict_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  pool = new Pool({
    connectionString: `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/ipredict_test`,
  });
  await pool.query(SCHEMA);
});

beforeEach(async () => {
  vi.clearAllMocks();
  await pool.query("TRUNCATE events, bets, checkpoints, markets RESTART IDENTITY CASCADE");
  await pool.query("INSERT INTO markets (id) VALUES (7)");
});

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

describe("bet placement ledger batches", () => {
  it("applies a multi-event ledger once and preserves additive ordering semantics", async () => {
    const events = [
      bet("a", 0, ALICE, "98"),
      bet("b", 1, ALICE, "48"),
      bet("c", 2, BOB, "28"),
    ];

    await handleBetPlacedEvents(events, pool as unknown as DbClient, redis);

    const first = await pool.query(
      "SELECT bettor, net_amount, is_yes FROM bets ORDER BY bettor",
    );
    expect(first.rows).toEqual([
      { bettor: ALICE, net_amount: "146.0000000", is_yes: true },
      { bettor: BOB, net_amount: "28.0000000", is_yes: true },
    ]);
    const market = await pool.query(
      "SELECT total_yes, total_no, bet_count FROM markets WHERE id = 7",
    );
    expect(market.rows[0]).toEqual({
      total_yes: "174.0000000",
      total_no: "0.0000000",
      bet_count: 2,
    });
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM events")).rows[0].count).toBe(3);

    await handleBetPlacedEvents(events, pool as unknown as DbClient, redis);

    expect((await pool.query("SELECT net_amount FROM bets WHERE bettor = $1", [ALICE])).rows[0].net_amount)
      .toBe("146.0000000");
    expect((await pool.query("SELECT total_yes FROM markets WHERE id = 7")).rows[0].total_yes)
      .toBe("174.0000000");
  });

  it("rolls back all effects and the checkpoint when one batch event is invalid", async () => {
    await pool.query(
      "INSERT INTO checkpoints (id, last_ledger_seq) VALUES (0, 899)",
    );
    const events = [bet("a", 0, ALICE, "98"), bet("b", 1, BOB, "48", true, 999)];

    await expect(
      processLedgerBatchWithCheckpoint(pool, events, 900, (batch, client) =>
        handleBetPlacedEvents(batch, client as DbClient, redis)),
    ).rejects.toThrow();

    expect((await pool.query("SELECT COUNT(*)::int AS count FROM events")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM bets")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT last_ledger_seq FROM checkpoints WHERE id = 0")).rows[0].last_ledger_seq)
      .toBe("899");
  });

  it("rejects opposite-side placements for one position without poisoning deduplication", async () => {
    const events = [bet("a", 0, ALICE, "98", true), bet("b", 1, ALICE, "48", false)];

    await expect(
      handleBetPlacedEvents(events, pool as unknown as DbClient, redis),
    ).rejects.toThrow();

    expect((await pool.query("SELECT COUNT(*)::int AS count FROM events")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM bets")).rows[0].count).toBe(0);

    await expect(
      handleBetPlacedEvents([events[0]], pool as unknown as DbClient, redis),
    ).resolves.toHaveLength(1);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM events")).rows[0].count).toBe(1);
  });
});
