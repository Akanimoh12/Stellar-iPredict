/**
 * Integration tests for the oracle submission path (issue #227 follow-up).
 *
 * Runs against a REAL Postgres with REAL migrations applied — no mocked query
 * layer. Each test runs inside a single transaction that is rolled back on
 * teardown (see {@link TestTxn}), so the suite is order-independent and needs no
 * manual cleanup between runs.
 *
 * Gated on physical database availability: `describe.skipIf(!dbAvailable)` so a
 * machine with no Postgres still passes `npm test` rather than flaking.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

import { buildCanonicalOracleMessage } from "../src/api/oracle.js";
import {
  createTxnTestApp,
  closeTxnTestApp,
  isTestDatabaseAvailable,
  type TxnTestApp,
} from "./setup.js";

// Resolved once at collection time so every suite shares one probe.
const dbAvailable = await isTestDatabaseAvailable();

// One keypair for the whole suite — providers are identified by public key.
const provider = Keypair.random();
const providerPk = provider.publicKey();
const API_KEY = "test-oracle-api-key";

function sign(
  marketId: number,
  outcome: "YES" | "NO",
  timestamp: number,
  nonce: string,
): string {
  const payload = buildCanonicalOracleMessage({
    provider: providerPk,
    marketId,
    outcome,
    timestamp,
    nonce,
  });
  return provider.sign(Buffer.from(payload, "utf8")).toString("base64");
}

describe.skipIf(!dbAvailable)(
  "Integration: POST /api/v1/oracle/submit (real Postgres)",
  () => {
    let app: TxnTestApp;

    // Fresh transaction per test — rolled back on close so the suite is
    // order-independent and needs no manual cleanup between runs.
    beforeEach(async () => {
      app = await createTxnTestApp();
      // Seed everything the submission path requires inside the SAME
      // transaction the route will use — rolled back with everything else on
      // teardown, so no state leaks between runs.
      await app.txn.query(
        "INSERT INTO oracle_providers (address, active) VALUES ($1, TRUE) ON CONFLICT (address) DO UPDATE SET active = TRUE",
        [providerPk],
      );
      // An already-expired, unresolved market — submissions are only accepted
      // after the market end time.
      await app.txn.query(
        `INSERT INTO markets (id, question, category, end_time, creator)
         VALUES ($1, 'Integration test market', 'Crypto', $2, $3)
         ON CONFLICT (id) DO UPDATE SET resolved = FALSE, cancelled = FALSE, end_time = EXCLUDED.end_time`,
        [9999, Math.floor(Date.now() / 1000) - 3600, providerPk],
      );
    });

    afterEach(async () => {
      await closeTxnTestApp(app);
    });

    it("persists a submission and the API reports the correct count", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = `nonce-${Date.now()}-1`;

      const res = await app.server.inject({
        method: "POST",
        url: "/api/v1/oracle/submit",
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: {
          marketId: 9999,
          outcome: "YES",
          signature: sign(9999, "YES", timestamp, nonce),
          provider: providerPk,
          nonce,
          timestamp,
        },
      });

      // The API must accept the submission and report one still needed
      // (threshold defaults to 3).
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accepted).toBe(true);
      expect(body.submissionsNeeded).toBe(2);

      // Assert the persisted row matches what the API reports. The verification
      // reads through the SAME transaction the route wrote to — a separate pool
      // connection would not see the uncommitted INSERT.
      const { rows } = await app.txn.query<{
        market_id: number;
        submitter: string;
        outcome: string;
        status: string;
      }>(
        "SELECT market_id, submitter, outcome, status FROM oracle_submissions WHERE market_id = $1",
        [9999],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].submitter).toBe(providerPk);
      expect(rows[0].outcome).toBe("YES");
      expect(rows[0].status).toBe("submitted");
    });

    it("rejects a duplicate-market submission with 409 CONFLICT", async () => {
      const timestamp = Math.floor(Date.now() / 1000);

      // First submission for market 9999 — succeeds.
      const first = await app.server.inject({
        method: "POST",
        url: "/api/v1/oracle/submit",
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: {
          marketId: 9999,
          outcome: "YES",
          signature: sign(9999, "YES", timestamp, "dup-nonce-1"),
          provider: providerPk,
          nonce: "dup-nonce-1",
          timestamp,
        },
      });
      expect(first.statusCode).toBe(200);

      // Second submission for the SAME market — must hit the UNIQUE(market_id)
      // constraint and return 409, not 500.
      const second = await app.server.inject({
        method: "POST",
        url: "/api/v1/oracle/submit",
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: {
          marketId: 9999,
          outcome: "NO",
          signature: sign(9999, "NO", timestamp, "dup-nonce-2"),
          provider: providerPk,
          nonce: "dup-nonce-2",
          timestamp,
        },
      });

      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe("CONFLICT");

      // Only one row was ever persisted for this market.
      const { rows } = await app.txn.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM oracle_submissions WHERE market_id = $1",
        [9999],
      );
      expect(rows[0].count).toBe("1");
    });
  },
);
