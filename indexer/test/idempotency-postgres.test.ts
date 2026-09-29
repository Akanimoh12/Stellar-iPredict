import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { handleBetPlacedEvent } from "../src/handlers/bet_placed.js";
import { handleMarketCreatedEvent } from "../src/handlers/market_created.js";
import { handleMarketResolvedEvent } from "../src/handlers/market_resolved.js";
import { handleMarketCancelledEvent } from "../src/handlers/market_cancelled.js";
import { handleReferralRegisteredEvent } from "../src/handlers/referral_registered.js";
import { handleReferralRewardEvent } from "../src/handlers/referral_reward.js";
import { handleOracleChallengedEvent, handleOracleEscalatedEvent } from "../src/handlers/oracle_challenge.js";
import { handleOracleFinalizedEvent } from "../src/handlers/oracle_finalized.js";
import { dispatchEvent } from "../src/handlers/index.js";
import { withTransaction } from "../src/db.js";
import type { DbClient, DecodedContractEvent } from "../src/types.js";

const USER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM";
const OTHER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBNZ5H";
const redis = { async del() { return 1; } };
const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const schema = `idempotency_${process.pid}`;
const tables = ["events", "markets", "bets", "leaderboard", "token_balances", "oracle_submissions", "oracle_disputes"];
const event = (topics: string[], data: unknown): DecodedContractEvent => ({
  ledger: 100, txHash: "a".repeat(64), eventIndex: 0, topics, data,
});
const registry = async (e: DecodedContractEvent, db: DbClient) => dispatchEvent(
  { ...e, topics: [...e.topics] }, { db, redis, logger: { warn() {} } },
);
const cases = [
  { name: "bet", handler: handleBetPlacedEvent, event: event(["bet", "placed"], { market_id: 1, bettor: USER, is_yes: true, amount: "10000000", net_amount: "9800000", fee: "200000", is_increase: false }), sql: "SELECT total_yes::text AS value FROM markets WHERE id=1", expected: "9800000.0000000" },
  { name: "claim", handler: registry, event: event(["reward_claimed"], { market_id: 1, user: USER }), sql: "SELECT claimed AS value FROM bets WHERE market_id=1", expected: true },
  { name: "fees", handler: registry, event: event(["fees_withdrawn"], { admin: USER, amount: "5" }), sql: "SELECT count(*)::int AS value FROM events", expected: 1 },
  { name: "create", writes: 2, handler: handleMarketCreatedEvent, event: event(["mkt", "created"], { market_id: 2, question: "New market?", category: "Crypto", end_time: 1800000000, creator: USER }), sql: "SELECT question AS value FROM markets WHERE id=2", expected: "New market?" },
  { name: "resolve", handler: handleMarketResolvedEvent, event: event(["market_resolved"], { market_id: 1, outcome: true }), sql: "SELECT resolved AS value FROM markets WHERE id=1", expected: true },
  { name: "cancel", handler: handleMarketCancelledEvent, event: event(["mkt", "cancelled"], { market_id: 1 }), sql: "SELECT cancelled AS value FROM markets WHERE id=1", expected: true },
  { name: "submission", handler: registry, event: event(["submit_outcome"], { market_id: 1, submitter: USER, outcome: true, bond_amount: "100" }), sql: "SELECT count(*)::int AS value FROM oracle_submissions", expected: 1 },
  { name: "challenge", handler: handleOracleChallengedEvent, writes: 2, event: event(["oracle", "challenged"], { market_id: 1, submitter: USER, challenger: OTHER, outcome: false, bond: "200", submitter_bond: "100", challenged_at: 1700000100 }), sql: "SELECT status AS value FROM oracle_submissions", expected: "challenged" },
  { name: "escalate", handler: handleOracleEscalatedEvent, event: event(["oracle", "escalated"], { market_id: 1, submitter: USER, challenger: OTHER, outcome: false, total_bond: "300", escalated_at: 1700000100, council_deadline: 1700259200 }), sql: "SELECT status AS value FROM oracle_disputes", expected: "escalated" },
  { name: "finalize", handler: handleOracleFinalizedEvent, writes: 2, event: event(["oracle", "finalized"], { market_id: 1, outcome: true, challenged: false, submitter: USER, challenger: null, submitter_payout: "100", challenger_payout: "0", council_fee: "0", protocol_credit: "0", finalized_at: 1700259300 }), sql: "SELECT status AS value FROM oracle_submissions", expected: "finalized" },
  { name: "registration", handler: handleReferralRegisteredEvent, writes: 2, event: event(["referral", "registered"], { user: USER, display_name: "Alice", referrer: OTHER, welcome_points: 5, referrer_bonus_points: 7 }), sql: "SELECT points::int AS value FROM leaderboard ORDER BY points", expected: [5, 7] },
  { name: "referral", handler: handleReferralRewardEvent, event: event(["referral", "reward"], { referrer: OTHER, points: 3 }), sql: "SELECT points::int AS value FROM leaderboard", expected: 3 },
  { name: "points", handler: registry, event: event(["reward_points"], { user: USER, points: 30, is_winner: true }), sql: "SELECT points::int AS value FROM leaderboard", expected: 30 },
  { name: "mint", handler: registry, event: event(["token_mint"], { to: USER, amount: "25" }), sql: `SELECT balance::int AS value FROM token_balances WHERE address='${USER}'`, expected: 125 },
  { name: "transfer", handler: registry, writes: 2, event: event(["token_transfer"], { from: USER, to: OTHER, amount: "25" }), sql: "SELECT balance::int AS value FROM token_balances ORDER BY address", expected: [75, 35] },
];

describe.skipIf(!connectionString)("handler atomicity against PostgreSQL", () => {
  let admin: Pool;
  let pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
    const client = await pool.connect();
    try { await runMigrations(client); } finally { client.release(); }
  }, 30000);
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE ${tables.join(",")} RESTART IDENTITY CASCADE`);
    await pool.query("INSERT INTO markets(id,question,category,end_time,creator) VALUES(1,'Existing?', 'Crypto',1800000000,$1)", [USER]);
    await pool.query("INSERT INTO bets(market_id,bettor,net_amount,gross_amount,is_yes) VALUES(1,$1,0,0,true)", [USER]);
    await pool.query("INSERT INTO token_balances(address,balance) VALUES($1,100),($2,10)", [USER,OTHER]);
  });
  async function prepare(name: string) {
    if (["challenge", "escalate", "finalize"].includes(name)) {
      await pool.query("INSERT INTO oracle_submissions(market_id,submitter,outcome,bond_amount) VALUES(1,$1,'YES',100)", [USER]);
    }
    if (name === "escalate") {
      await pool.query("INSERT INTO oracle_disputes(market_id,submitter,challenger,outcome,submitter_bond,challenger_bond,status) VALUES(1,$1,$2,'NO',100,200,'challenged')", [USER,OTHER]);
    }
  }
  async function snapshot() {
    return Promise.all(tables.map(async table => (await pool.query(`SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`)).rows));
  }
  for (const spec of cases) {
    it(`${spec.name}: correct first result and unchanged state on replay`, async () => {
      await prepare(spec.name);
      const run = () => spec.handler(spec.event, pool as unknown as DbClient, redis);
      await run();
      const values = (await pool.query(spec.sql)).rows.map(row => row.value);
      expect(values).toEqual(Array.isArray(spec.expected) ? spec.expected : [spec.expected]);
      if (spec.name === "points") expect((await pool.query("SELECT won_bets,lost_bets FROM leaderboard")).rows).toEqual([{won_bets:1,lost_bets:0}]);
      const first = await snapshot();
      await run();
      expect(await snapshot()).toEqual(first);
    });
    if (spec.name === "fees") continue; // No derived database writes.
    it(`${spec.name}: failed effects roll back the marker and retry succeeds`, async () => {
      await prepare(spec.name);
      const before = await snapshot();
      let writes = 0;
      const faulty = {
        query: pool.query.bind(pool),
        async connect() {
          const client = await pool.connect();
          return {
            async query(sql: string, params?: unknown[]) {
              if ((/^(INSERT|UPDATE|WITH)/.test(sql.trim())) && !sql.includes("INSERT INTO events (ledger_seq") && ++writes === (spec.writes ?? 1)) {
                throw new Error("injected effect failure");
              }
              // The bet handler performs every write in a single CTE.
              if (sql.trim().startsWith("WITH input AS")) throw new Error("injected effect failure");
              return client.query(sql, params);
            },
            release: () => client.release(),
          };
        },
      };
      // bet_placed is a single statement and does not lease a connection.
      if (spec.name === "bet") faulty.query = async () => { throw new Error("injected effect failure"); };
      await expect(spec.handler(spec.event, faulty as unknown as DbClient, redis)).rejects.toThrow("injected effect failure");
      expect(await snapshot()).toEqual(before);
      await spec.handler(spec.event, pool as unknown as DbClient, redis);
      const values = (await pool.query(spec.sql)).rows.map(row => row.value);
      expect(values).toEqual(Array.isArray(spec.expected) ? spec.expected : [spec.expected]);
      expect((await pool.query("SELECT count(*)::int AS n FROM events")).rows[0].n).toBe(1);
    });
  }
  it("concurrent delivery on separate pool connections credits a reward once", async () => {
    const spec = cases.find(c => c.name === "referral")!;
    await Promise.all(Array.from({length: 4}, () => spec.handler(spec.event, pool as unknown as DbClient, redis)));
    expect((await pool.query(spec.sql)).rows[0].value).toBe(3);
  });
  it("an outer batch rollback also rolls back a successful handler", async () => {
    const before = await snapshot();
    const spec = cases.find(c => c.name === "referral")!;
    await expect(withTransaction(pool, async client => {
      await spec.handler(spec.event, client as DbClient, redis);
      throw new Error("batch failed");
    })).rejects.toThrow("batch failed");
    expect(await snapshot()).toEqual(before);
  });
});
