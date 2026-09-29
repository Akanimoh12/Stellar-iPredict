import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { CouncilVoteManager } from "../src/aggregator/council-votes.js";
import {
  MarketAlreadyFinalizedError,
  finalizeMarketDecision,
  queryMarketState,
} from "../src/aggregator/market-finalizer.js";

const hasIntegrationEnv = Boolean(
  process.env.DATABASE_URL &&
  process.env.SOROBAN_RPC_URL &&
  process.env.MARKET_CONTRACT_ID &&
  process.env.ORACLE_SECRET_KEY &&
  process.env.MARKET_ID,
);
const integrationIt = hasIntegrationEnv ? it : it.skip;

let pool: Pool | null = null;
let server: rpc.Server | null = null;
let contractId = "";
let marketId = 0;
let resolverSecret = "";
let networkPassphrase = Networks.TESTNET;
let resolverPublicKey = "";
const threshold = Number(process.env.COUNCIL_THRESHOLD ?? 4);

async function ensureOracleSubmissionsSchema(db: Pool): Promise<void> {
  await db.query(
    `CREATE TYPE IF NOT EXISTS oracle_submission_status AS ENUM (
      'submitted',
      'challenged',
      'finalized',
      'rejected'
    );`,
  );

  await db.query(`
    CREATE TABLE IF NOT EXISTS oracle_submissions (
      id SERIAL PRIMARY KEY,
      market_id INTEGER NOT NULL,
      submitter VARCHAR(255) NOT NULL,
      outcome VARCHAR(255) NOT NULL,
      bond_amount NUMERIC NOT NULL DEFAULT 0,
      submitted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      status oracle_submission_status NOT NULL DEFAULT 'finalized',
      decision VARCHAR(255),
      tx_hash CHAR(64),
      finalized_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      council_votes JSONB DEFAULT '{}'::jsonb
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_oracle_submissions_market_id ON oracle_submissions(market_id);`);
}

beforeAll(async () => {
  if (!hasIntegrationEnv) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  server = new rpc.Server(process.env.SOROBAN_RPC_URL!);
  contractId = process.env.MARKET_CONTRACT_ID!;
  marketId = Number(process.env.MARKET_ID!);
  resolverSecret = process.env.ORACLE_SECRET_KEY!;
  resolverPublicKey = Keypair.fromSecret(resolverSecret).publicKey();
  networkPassphrase = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
  await pool.connect();
  await ensureOracleSubmissionsSchema(pool);
});

afterAll(async () => {
  await pool?.end();
});

describe("Council flow integration", () => {
  integrationIt("submits council votes, finalizes on-chain, and persists the final decision", async () => {
    if (!pool || !server) return;

    const current = await queryMarketState(server, contractId, marketId, resolverSecret, networkPassphrase);
    expect(current.cancelled).toBe(false);
    expect(current.resolved).toBe(false);
    expect(current.endTime).toBeLessThan(Math.floor(Date.now() / 1000));

    const votes = new CouncilVoteManager();
    const voteMembers = Array.from({ length: threshold }, (_, index) => `council-member-${index + 1}`);
    for (const member of voteMembers) {
      const vote = votes.submitVote(member, true);
      expect(vote).toEqual({ member, outcome: true });
    }

    const outcome = votes.getAgreedOutcome(threshold);
    expect(outcome).toBe(true);

    const txHash = await finalizeMarketDecision(
      pool,
      server,
      contractId,
      resolverSecret,
      marketId,
      outcome,
      votes.getVotes(),
      networkPassphrase,
    );

    expect(txHash).toMatch(/^[0-9A-Fa-f]{64}$/);

    const result = await pool.query(
      `SELECT market_id, decision, tx_hash, finalized_at, council_votes FROM oracle_submissions WHERE market_id = $1`,
      [marketId],
    );
    expect(result.rowCount).toBe(1);
    const row = result.rows[0];
    expect(row.market_id).toBe(marketId);
    expect(row.decision).toBe("yes");
    expect(row.tx_hash).toBe(txHash);
    expect(row.finalized_at).toBeTruthy();
    expect(row.council_votes).toEqual(votes.getVotes());

    await expect(
      finalizeMarketDecision(
        pool,
        server,
        contractId,
        resolverSecret,
        marketId,
        outcome,
        votes.getVotes(),
        networkPassphrase,
      ),
    ).rejects.toThrow(MarketAlreadyFinalizedError);

    const after = await queryMarketState(server, contractId, marketId, resolverSecret, networkPassphrase);
    expect(after.resolved).toBe(true);
    expect(after.outcome).toBe(true);
  });
});
