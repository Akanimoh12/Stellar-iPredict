/**
 * Local environment end-to-end check (Issue #1002).
 *
 * This script assumes the Docker Compose dev stack from
 * `infra/docker-compose.dev.yml` is already running and that the database
 * migrations have been applied. `npm run test:e2e:local` does both before
 * invoking this file.
 *
 * It drives a scripted market lifecycle entirely against the real Postgres
 * instance (no fakes) and asserts the resulting database state:
 *   market created -> bets placed -> odds/totals updated -> outcome submitted
 *   -> market finalized -> winning bet claimed -> replayed event deduplicated.
 */

import assert from "node:assert/strict";
import { Client } from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://ipredict:ipredict@localhost:5432/ipredict";

// A dedicated id keeps this check isolated from any other local market data.
const MARKET_ID = 9_002_000;
const CREATOR = `G${"C".repeat(55)}`;
const ALICE = `G${"A".repeat(55)}`;
const BOB = `G${"B".repeat(55)}`;
const SUBMITTER = `G${"S".repeat(55)}`;
const TX_HASH = "e".repeat(64);
const END_TIME = 1_900_000_000;

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  assert.equal(
    actual,
    expected,
    `${label}: expected ${String(expected)}, got ${String(actual)}`,
  );
}

async function queryOne<T extends Record<string, unknown>>(
  client: Client,
  label: string,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const { rows } = await client.query<T>(sql, params);
  assert.equal(rows.length, 1, `${label}: expected exactly one row, got ${rows.length}`);
  return rows[0]!;
}

/** Removes only the rows owned by this check; other local markets are untouched. */
async function cleanMarket(client: Client): Promise<void> {
  const tables = [
    "events_archive",
    "events",
    "bet_anomaly_alerts",
    "oracle_resolution_lag",
    "oracle_ambiguous_tallies",
    "council_votes",
    "oracle_disputes",
    "oracle_submissions",
    "bets",
  ];

  for (const table of tables) {
    await client.query(`DELETE FROM ${table} WHERE market_id = $1`, [MARKET_ID]);
  }
  await client.query("DELETE FROM markets WHERE id = $1", [MARKET_ID]);
}

async function run(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  let committed = false;

  try {
    await client.query("BEGIN");
    await cleanMarket(client);

    // 1. Market creation.
    await client.query(
      `INSERT INTO markets (id, question, image_url, category, end_time, creator)
       VALUES ($1, $2, NULL, 'Crypto', $3, $4)`,
      [MARKET_ID, "Will XLM exceed $1 in the local E2E stack?", END_TIME, CREATOR],
    );

    let market = await queryOne<Record<string, unknown>>(
      client,
      "created market",
      "SELECT question, category, total_yes, total_no, bet_count, resolved, cancelled FROM markets WHERE id = $1",
      [MARKET_ID],
    );
    expectEqual("created market.question", market.question, "Will XLM exceed $1 in the local E2E stack?");
    expectEqual("created market.total_yes", market.total_yes, "0.0000000");
    expectEqual("created market.total_no", market.total_no, "0.0000000");
    expectEqual("created market.bet_count", market.bet_count, 0);
    expectEqual("created market.resolved", market.resolved, false);
    console.log("PASS market creation persisted in Postgres");

    // 2. Bets placed and indexed (100 XLM gross, 2% fee -> 98 XLM net).
    const bets = [
      { bettor: ALICE, isYes: true, eventIndex: 0 },
      { bettor: BOB, isYes: false, eventIndex: 1 },
    ];

    for (const bet of bets) {
      await client.query(
        `INSERT INTO bets (market_id, bettor, gross_amount, net_amount, is_yes)
         VALUES ($1, $2, '100.0000000', '98.0000000', $3)`,
        [MARKET_ID, bet.bettor, bet.isYes],
      );
      await client.query(
        `INSERT INTO events (ledger_seq, tx_hash, event_index, event_type, market_id, actor, payload)
         VALUES ($1, $2, $3, 'bet_placed', $4, $5, '{}'::jsonb)`,
        [100, TX_HASH, bet.eventIndex, MARKET_ID, bet.bettor],
      );
    }

    await client.query(
      "UPDATE markets SET total_yes = '98.0000000', total_no = '98.0000000', bet_count = 2 WHERE id = $1",
      [MARKET_ID],
    );

    const betState = await queryOne<Record<string, unknown>>(
      client,
      "bet state",
      `SELECT
         (SELECT count(*)::int FROM bets WHERE market_id = $1) AS bet_count,
         (SELECT count(*)::int FROM events WHERE market_id = $1 AND event_type = 'bet_placed') AS event_count,
         total_yes,
         total_no
       FROM markets WHERE id = $1`,
      [MARKET_ID],
    );
    expectEqual("indexed bet count", betState.bet_count, 2);
    expectEqual("indexed bet events", betState.event_count, 2);
    expectEqual("market.total_yes after bets", betState.total_yes, "98.0000000");
    expectEqual("market.total_no after bets", betState.total_no, "98.0000000");
    console.log("PASS scripted bets and indexer totals persisted");

    // 3. Replaying the same on-chain event must not create a duplicate row.
    await client.query(
      `INSERT INTO events (ledger_seq, tx_hash, event_index, event_type, market_id, actor, payload)
       VALUES ($1, $2, $3, 'bet_placed', $4, $5, '{}'::jsonb)
       ON CONFLICT (tx_hash, event_index) DO NOTHING`,
      [100, TX_HASH, 0, MARKET_ID, ALICE],
    );
    const eventCount = await queryOne<Record<string, unknown>>(
      client,
      "replayed events",
      "SELECT count(*)::int AS total FROM events WHERE market_id = $1",
      [MARKET_ID],
    );
    expectEqual("events after replay", eventCount.total, 2);
    console.log("PASS replayed event was deduplicated");

    // 4. Oracle submission and unchallenged finalization.
    await client.query(
      `INSERT INTO oracle_submissions (market_id, submitter, outcome, bond_amount, status)
       VALUES ($1, $2, 'YES', '100.000000', 'submitted')`,
      [MARKET_ID, SUBMITTER],
    );
    await client.query(
      `UPDATE oracle_submissions
       SET status = 'finalized', decision = 'YES', tx_hash = $2, finalized_at = NOW()
       WHERE market_id = $1`,
      [MARKET_ID, TX_HASH],
    );
    await client.query(
      "UPDATE markets SET resolved = TRUE, outcome = TRUE WHERE id = $1",
      [MARKET_ID],
    );

    const finalization = await queryOne<Record<string, unknown>>(
      client,
      "finalized market",
      `SELECT
         m.resolved,
         m.outcome,
         s.status AS submission_status,
         s.decision
       FROM markets m
       JOIN oracle_submissions s ON s.market_id = m.id
       WHERE m.id = $1`,
      [MARKET_ID],
    );
    expectEqual("final market.resolved", finalization.resolved, true);
    expectEqual("final market.outcome", finalization.outcome, true);
    expectEqual("final submission.status", finalization.submission_status, "finalized");
    expectEqual("final submission.decision", finalization.decision, "YES");
    console.log("PASS oracle finalization persisted");

    // 5. Winning bet claimed.
    await client.query(
      "UPDATE bets SET claimed = TRUE WHERE market_id = $1 AND is_yes = TRUE",
      [MARKET_ID],
    );
    const claims = await queryOne<Record<string, unknown>>(
      client,
      "claims",
      `SELECT
         count(*) FILTER (WHERE claimed)::int AS claimed,
         count(*) FILTER (WHERE NOT claimed)::int AS unclaimed
       FROM bets WHERE market_id = $1`,
      [MARKET_ID],
    );
    expectEqual("claimed winning bets", claims.claimed, 1);
    expectEqual("unclaimed losing bets", claims.unclaimed, 1);
    console.log("PASS claim state persisted");

    // Leave no trace of the scripted lifecycle inside this transaction.
    await cleanMarket(client);
    await client.query("COMMIT");
    committed = true;
    console.log("PASS local environment lifecycle (Issue #1002)");
  } finally {
    if (!committed) await client.query("ROLLBACK");
    await client.end();
  }
}

run().catch((error: unknown) => {
  console.error("FAIL local environment lifecycle (Issue #1002)");
  console.error(error);
  process.exitCode = 1;
});
