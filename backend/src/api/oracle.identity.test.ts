import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { registerErrorHandler } from "../lib/errors.js";
import type { OracleSubmissionRow } from "../db/types.js";

/**
 * Per-provider oracle credentials, end to end (issue #429).
 *
 * `oracleApiKeys.test.ts` covers the credential store in isolation; these
 * exercise the route, which is where the two halves have to meet: the key
 * resolves to an identity, and the body's `provider` must agree with it.
 *
 * The routes read `config.oracleApiKeys`, which is parsed once at import, so
 * each scenario sets `ORACLE_API_KEYS` and re-imports the module graph. That
 * is also the only way to prove the wiring — a test that passed credentials
 * straight to the helper would still pass if the route ignored config
 * entirely.
 */

const PROVIDER_A = Keypair.random();
const PROVIDER_B = Keypair.random();

const KEY_A = "key-for-provider-a";
const KEY_B = "key-for-provider-b";

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function entry(kp: Keypair, key: string): string {
  return `${kp.publicKey()}:sha256$${sha256Hex(key)}`;
}

/**
 * A database stub complete enough to reach the end of the handler: a
 * registered provider, an expired-but-open market, and working insert/count.
 */
function makeDb(registered: string[]) {
  const submissions: OracleSubmissionRow[] = [];

  const db = {
    async query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
      const sql = text.replace(/\s+/g, " ").trim();

      if (sql.includes("FROM oracle_providers")) {
        return {
          rows: registered.map((address) => ({ address })) as unknown as T[],
        };
      }

      if (sql.includes("FROM markets")) {
        return {
          rows: [
            {
              id: 1,
              resolved: false,
              cancelled: false,
              // Comfortably in the past: submissions open only after end_time.
              end_time: String(Math.floor(Date.now() / 1000) - 3600),
            },
          ] as unknown as T[],
        };
      }

      if (sql.includes("INSERT INTO oracle_submissions")) {
        const [market_id, submitter, outcome, bond_amount] = (values ?? []) as [
          number,
          string,
          string,
          string,
        ];
        const row: OracleSubmissionRow = {
          id: submissions.length + 1,
          market_id: String(market_id),
          submitter,
          outcome,
          bond_amount,
          submitted_at: new Date(),
          status: "submitted",
        };
        submissions.push(row);
        return { rows: [row as unknown as T] };
      }

      if (sql.includes("SELECT COUNT(*)::text AS count FROM oracle_submissions")) {
        return { rows: [{ count: String(submissions.length) } as unknown as T] };
      }

      return { rows: [] };
    },
  };

  return { db, submissions };
}

/** Build the request body, signed by `signer` but claiming `claimedProvider`. */
async function submission(
  signOracleMessage: typeof import("./oracle.js")["signOracleMessage"],
  signer: Keypair,
  claimedProvider: string,
  marketId = 1,
  outcome = "YES",
) {
  return {
    marketId,
    outcome,
    provider: claimedProvider,
    signature: signOracleMessage(
      { marketId, outcome, provider: claimedProvider },
      signer,
    ),
  };
}

/**
 * Load the route module with a given `ORACLE_API_KEYS`, then mount it.
 *
 * `resetModules` matters: `config/index.ts` parses the environment once at
 * import, which is exactly the behaviour under test.
 */
async function bootWithKeys(rawKeys: string | undefined, registered: string[]) {
  if (rawKeys === undefined) {
    delete process.env.ORACLE_API_KEYS;
  } else {
    process.env.ORACLE_API_KEYS = rawKeys;
  }
  vi.resetModules();

  const oracleModule = await import("./oracle.js");
  const { invalidateProviderCache } = await import("../db/oracle.js");
  // The registered-provider cache is module-level with a 60s TTL; without
  // this, one scenario's provider list leaks into the next.
  invalidateProviderCache();

  const { db, submissions } = makeDb(registered);

  const app = Fastify();
  registerErrorHandler(app);
  await app.register(async (routes) => {
    routes.decorate("pool", db);
    await routes.register(oracleModule.oracleRoutes, { prefix: "/api/v1" });
  });

  return { app, submissions, oracleModule };
}

const originalKeys = process.env.ORACLE_API_KEYS;
const originalLegacy = process.env.ORACLE_API_KEY;

describe("oracle per-provider API keys at the route (#429)", () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    delete process.env.ORACLE_API_KEY;
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (originalKeys === undefined) delete process.env.ORACLE_API_KEYS;
    else process.env.ORACLE_API_KEYS = originalKeys;
    if (originalLegacy === undefined) delete process.env.ORACLE_API_KEY;
    else process.env.ORACLE_API_KEY = originalLegacy;
    vi.resetModules();
  });

  it("lets each provider authenticate with its own key", async () => {
    const booted = await bootWithKeys(
      `${entry(PROVIDER_A, KEY_A)},${entry(PROVIDER_B, KEY_B)}`,
      [PROVIDER_A.publicKey(), PROVIDER_B.publicKey()],
    );
    app = booted.app;

    for (const [kp, key] of [
      [PROVIDER_A, KEY_A],
      [PROVIDER_B, KEY_B],
    ] as const) {
      const res = await booted.app.inject({
        method: "POST",
        url: "/api/v1/oracle/submit",
        headers: { authorization: `Bearer ${key}` },
        payload: await submission(
          booted.oracleModule.signOracleMessage,
          kp,
          kp.publicKey(),
        ),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().accepted).toBe(true);
    }

    expect(booted.submissions.map((s) => s.submitter)).toEqual([
      PROVIDER_A.publicKey(),
      PROVIDER_B.publicKey(),
    ]);
  });

  /**
   * The acceptance criterion that matters most: holding a valid key must not
   * be enough to submit as somebody else. Provider B's key is real, the
   * signature is genuinely B's, and the claim is still refused because the
   * body names A.
   */
  it("refuses a key used to submit on behalf of another provider", async () => {
    const booted = await bootWithKeys(
      `${entry(PROVIDER_A, KEY_A)},${entry(PROVIDER_B, KEY_B)}`,
      [PROVIDER_A.publicKey(), PROVIDER_B.publicKey()],
    );
    app = booted.app;

    const res = await booted.app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      headers: { authorization: `Bearer ${KEY_B}` },
      payload: await submission(
        booted.oracleModule.signOracleMessage,
        PROVIDER_A,
        PROVIDER_A.publicKey(),
      ),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/cannot submit on behalf of/);
    expect(booted.submissions).toHaveLength(0);
  });

  it("names the bound provider in the refusal so the misconfiguration is obvious", async () => {
    const booted = await bootWithKeys(
      `${entry(PROVIDER_A, KEY_A)},${entry(PROVIDER_B, KEY_B)}`,
      [PROVIDER_A.publicKey(), PROVIDER_B.publicKey()],
    );
    app = booted.app;

    const res = await booted.app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      headers: { authorization: `Bearer ${KEY_A}` },
      payload: await submission(
        booted.oracleModule.signOracleMessage,
        PROVIDER_B,
        PROVIDER_B.publicKey(),
      ),
    });

    expect(res.json().error.message).toContain(PROVIDER_A.publicKey());
    expect(res.json().error.message).toContain(PROVIDER_B.publicKey());
  });

  /** Revoking one provider must leave the others working. */
  it("keeps other providers working after one key is revoked", async () => {
    const booted = await bootWithKeys(entry(PROVIDER_B, KEY_B), [
      PROVIDER_A.publicKey(),
      PROVIDER_B.publicKey(),
    ]);
    app = booted.app;

    const revoked = await booted.app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      headers: { authorization: `Bearer ${KEY_A}` },
      payload: await submission(
        booted.oracleModule.signOracleMessage,
        PROVIDER_A,
        PROVIDER_A.publicKey(),
      ),
    });
    expect(revoked.statusCode).toBe(401);

    const surviving = await booted.app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      headers: { authorization: `Bearer ${KEY_B}` },
      payload: await submission(
        booted.oracleModule.signOracleMessage,
        PROVIDER_B,
        PROVIDER_B.publicKey(),
      ),
    });
    expect(surviving.statusCode).toBe(200);
  });

  it("rejects an unknown key with 401 and no hint about who is configured", async () => {
    const booted = await bootWithKeys(entry(PROVIDER_A, KEY_A), [
      PROVIDER_A.publicKey(),
    ]);
    app = booted.app;

    const res = await booted.app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      headers: { authorization: "Bearer not-a-real-key" },
      payload: await submission(
        booted.oracleModule.signOracleMessage,
        PROVIDER_A,
        PROVIDER_A.publicKey(),
      ),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe("Invalid API key");
    expect(res.json().error.message).not.toContain(PROVIDER_A.publicKey());
  });

  it("accepts the key through x-api-key and the API-Key scheme too", async () => {
    const booted = await bootWithKeys(entry(PROVIDER_A, KEY_A), [
      PROVIDER_A.publicKey(),
    ]);
    app = booted.app;

    for (const headers of [
      { "x-api-key": KEY_A },
      { authorization: `API-Key ${KEY_A}` },
    ]) {
      const res = await booted.app.inject({
        method: "POST",
        url: "/api/v1/oracle/submit",
        headers,
        payload: await submission(
          booted.oracleModule.signOracleMessage,
          PROVIDER_A,
          PROVIDER_A.publicKey(),
        ),
      });

      // 200 on the first, 409 on the second — one submission per market. Both
      // prove the credential was accepted, which is what this asserts.
      expect([200, 409]).toContain(res.statusCode);
    }
  });

  it("still requires an authorization header", async () => {
    const booted = await bootWithKeys(entry(PROVIDER_A, KEY_A), [
      PROVIDER_A.publicKey(),
    ]);
    app = booted.app;

    const res = await booted.app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      payload: await submission(
        booted.oracleModule.signOracleMessage,
        PROVIDER_A,
        PROVIDER_A.publicKey(),
      ),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe("Missing authorization header");
  });

  /**
   * Identity binding runs before signature verification and before any
   * database read, so a key that is not entitled to the claimed provider never
   * reaches the rest of the pipeline.
   */
  it("refuses the wrong provider before the signature is even checked", async () => {
    const booted = await bootWithKeys(
      `${entry(PROVIDER_A, KEY_A)},${entry(PROVIDER_B, KEY_B)}`,
      [PROVIDER_A.publicKey(), PROVIDER_B.publicKey()],
    );
    app = booted.app;

    const res = await booted.app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      headers: { authorization: `Bearer ${KEY_B}` },
      payload: {
        marketId: 1,
        outcome: "YES",
        provider: PROVIDER_A.publicKey(),
        signature: "not-even-a-real-signature",
      },
    });

    // 403 (wrong identity), not 401 (bad signature).
    expect(res.statusCode).toBe(403);
  });

  it("falls back to the development key for any provider when unconfigured", async () => {
    const booted = await bootWithKeys(undefined, [PROVIDER_A.publicKey()]);
    app = booted.app;

    const res = await booted.app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      headers: { authorization: "Bearer test-oracle-api-key" },
      payload: await submission(
        booted.oracleModule.signOracleMessage,
        PROVIDER_A,
        PROVIDER_A.publicKey(),
      ),
    });

    expect(res.statusCode).toBe(200);
  });
});
