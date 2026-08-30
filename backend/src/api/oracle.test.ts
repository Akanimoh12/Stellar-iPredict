import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import {
  registerOracleRoutes,
  oracleRoutes,
  compareSecretValues,
  buildCanonicalOracleMessage,
  verifyOracleSubmissionSignature,
  signOracleMessage,
} from "./oracle.js";
import { registerErrorHandler } from "../lib/errors.js";
import type { OracleSubmissionRow } from "../db/types.js";

/**
 * Produce a valid submission signature for a provider keypair. The canonical
 * message is built from the exact fields that will appear in the request body,
 * so provider and message stay in lockstep with the handler.
 */
function signedSubmission(
  kp: Keypair,
  marketId: number,
  outcome: string,
  opts: { timestamp?: number; nonce?: string } = {},
): object {
  return {
    marketId,
    outcome,
    signature: signOracleMessage(
      { marketId, outcome, provider: kp.publicKey(), timestamp: opts.timestamp, nonce: opts.nonce },
      kp,
    ),
    provider: kp.publicKey(),
    ...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
    ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
  };
}

describe("compareSecretValues", () => {
  it("uses fixed-width hash comparison for secret values", () => {
    expect(compareSecretValues("test-oracle-api-key", "test-oracle-api-key")).toBe(true);
    expect(compareSecretValues("test-oracle-api-key", "other-key")).toBe(false);
    expect(compareSecretValues("short", "much-longer-secret-key")).toBe(false);
  });
});

describe("oracle submission signature (canonical message)", () => {
  const providerA = Keypair.random();
  const providerB = Keypair.random();

  it("builds a deterministic canonical message", () => {
    const input = {
      marketId: 42,
      outcome: "YES",
      provider: providerA.publicKey(),
      timestamp: 1_700_000_000,
      nonce: "abc",
    };
    expect(buildCanonicalOracleMessage(input)).toBe(
      [
        "ipredict-oracle-submit",
        "market_id:42",
        "outcome:YES",
        `provider:${providerA.publicKey()}`,
        "timestamp:1700000000",
        "nonce:abc",
      ].join("\n"),
    );

    // Missing timestamp/nonce serialise deterministically.
    expect(
      buildCanonicalOracleMessage({ marketId: 42, outcome: "YES", provider: providerA.publicKey() }),
    ).toBe(
      [
        "ipredict-oracle-submit",
        "market_id:42",
        "outcome:YES",
        `provider:${providerA.publicKey()}`,
        "timestamp:0",
        "nonce:",
      ].join("\n"),
    );
  });

  it("accepts a signature produced by the claimed provider", () => {
    const input = {
      marketId: 7,
      outcome: "NO",
      provider: providerA.publicKey(),
      timestamp: 1_700_000_000,
    };
    const sig = signOracleMessage(input, providerA);
    expect(verifyOracleSubmissionSignature(input, sig)).toBe(true);
  });

  it("rejects a signature from a different keypair", () => {
    const input = {
      marketId: 7,
      outcome: "NO",
      provider: providerA.publicKey(),
      timestamp: 1_700_000_000,
    };
    const sig = signOracleMessage(input, providerB);
    expect(verifyOracleSubmissionSignature(input, sig)).toBe(false);
  });

  it("rejects a signature over a tampered message", () => {
    const input = {
      marketId: 7,
      outcome: "NO",
      provider: providerA.publicKey(),
      timestamp: 1_700_000_000,
    };
    const sig = signOracleMessage(input, providerA);
    const tampered = { ...input, outcome: "YES" };
    expect(verifyOracleSubmissionSignature(tampered, sig)).toBe(false);
  });

  it("rejects empty or malformed signatures without throwing", () => {
    const input = {
      marketId: 7,
      outcome: "NO",
      provider: providerA.publicKey(),
    };
    expect(verifyOracleSubmissionSignature(input, "")).toBe(false);
    expect(verifyOracleSubmissionSignature(input, "not-a-real-signature")).toBe(false);
  });
});

describe("POST /api/oracle/submit (legacy)", () => {
  let app: FastifyInstance;
  let submissions: OracleSubmissionRow[];
  const provider = Keypair.random();

  const mockDb = {
    async query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
      const normalizedText = text.replace(/\s+/g, " ").trim();

      if (normalizedText.includes("INSERT INTO oracle_submissions")) {
        const [market_id, submitter, outcome, bond_amount] = (values ?? []) as [
          number,
          string,
          string,
          string,
        ];
        const newRow: OracleSubmissionRow = {
          id: submissions.length + 1,
          market_id,
          submitter,
          outcome,
          bond_amount,
          submitted_at: new Date(),
          status: "submitted",
        };
        submissions.push(newRow);
        return { rows: [newRow as unknown as T] };
      }

      if (
        normalizedText.includes(
          "SELECT COUNT(*)::text AS count FROM oracle_submissions",
        )
      ) {
        const [market_id] = (values ?? []) as [number];
        const count = submissions.filter(
          (s) => s.market_id === market_id && s.status === "submitted",
        ).length;
        return { rows: [{ count: String(count) } as unknown as T] };
      }

      return { rows: [] };
    },
  };

  beforeEach(() => {
    submissions = [];
    app = Fastify();
    registerErrorHandler(app);
    registerOracleRoutes(app, undefined, mockDb);
  });

  it("returns 401 when authorization header is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      payload: signedSubmission(provider, 1, "YES"),
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(submissions.length).toBe(0);
  });

  it("returns 401 when authorization token is invalid", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: {
        authorization: "Bearer invalid-token",
      },
      payload: signedSubmission(provider, 1, "YES"),
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(submissions.length).toBe(0);
  });

  it("returns 400 when body validation fails", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: {
        authorization: "Bearer test-oracle-api-key",
      },
      payload: {
        marketId: "invalid", // should be positive number
        outcome: "YES",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(submissions.length).toBe(0);
  });

  it("returns 401 and records nothing for an invalid signature", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: {
        authorization: "Bearer test-oracle-api-key",
      },
      payload: {
        marketId: 50,
        outcome: "YES",
        signature: "garbage-signature",
        provider: provider.publicKey(),
      },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(submissions.length).toBe(0);
  });

  it("returns 401 when signed by a key other than the claimed provider", async () => {
    const other = Keypair.random();
    const res = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: {
        authorization: "Bearer test-oracle-api-key",
      },
      payload: {
        marketId: 51,
        outcome: "YES",
        signature: signOracleMessage(
          { marketId: 51, outcome: "YES", provider: other.publicKey() },
          other,
        ),
        provider: provider.publicKey(), // claims a different provider
      },
    });

    expect(res.statusCode).toBe(401);
    expect(submissions.length).toBe(0);
  });

  it("records submission and calculates remaining submissions to threshold", async () => {
    // 1st submission
    const res1 = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: {
        authorization: "Bearer test-oracle-api-key",
      },
      payload: signedSubmission(provider, 42, "YES"),
    });

    expect(res1.statusCode).toBe(200);
    expect(res1.json()).toEqual({
      accepted: true,
      submissionsNeeded: 2,
    });

    // 2nd submission
    const res2 = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: {
        authorization: "Bearer test-oracle-api-key",
      },
      payload: signedSubmission(provider, 42, "YES"),
    });

    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual({
      accepted: true,
      submissionsNeeded: 1,
    });

    // 3rd submission (meets threshold of 3)
    const res3 = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: {
        authorization: "Bearer test-oracle-api-key",
      },
      payload: signedSubmission(provider, 42, "YES"),
    });

    expect(res3.statusCode).toBe(200);
    expect(res3.json()).toEqual({
      accepted: true,
      submissionsNeeded: 0,
    });
  });

  it("accepts API-Key prefix in authorization header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: {
        authorization: "API-Key test-oracle-api-key",
      },
      payload: signedSubmission(provider, 10, "NO"),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(true);
  });

  it("returns 409 when duplicate market submission is attempted", async () => {
    // First submission succeeds
    const res1 = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: {
        authorization: "Bearer test-oracle-api-key",
      },
      payload: signedSubmission(provider, 99, "YES"),
    });

    expect(res1.statusCode).toBe(200);

    // Second submission for same market should fail with 409
    // Mock the duplicate constraint error
    const originalQuery = mockDb.query;
    mockDb.query = async (text: string) => {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (normalized.includes("INSERT INTO oracle_submissions")) {
        const error: any = new Error(
          "duplicate key value violates unique constraint",
        );
        error.code = "23505";
        error.constraint = "uq_oracle_submissions_market_id";
        throw error;
      }
      return originalQuery.call(mockDb, text);
    };

    const res2 = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: {
        authorization: "Bearer test-oracle-api-key",
      },
      payload: signedSubmission(provider, 99, "NO"),
    });

    expect(res2.statusCode).toBe(409);
    const body = res2.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toContain("market 99");
  });
});

describe("POST /api/v1/oracle/submit (versioned)", () => {
  let app: FastifyInstance;
  let submissions: OracleSubmissionRow[];
  const provider = Keypair.random();

  const mockDb = {
    async query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
      const normalizedText = text.replace(/\s+/g, " ").trim();

      if (normalizedText.includes("INSERT INTO oracle_submissions")) {
        const [market_id, submitter, outcome, bond_amount] = (values ?? []) as [
          number,
          string,
          string,
          string,
        ];
        const newRow: OracleSubmissionRow = {
          id: submissions.length + 1,
          market_id,
          submitter,
          outcome,
          bond_amount,
          submitted_at: new Date(),
          status: "submitted",
        };
        submissions.push(newRow);
        return { rows: [newRow as unknown as T] };
      }

      if (
        normalizedText.includes(
          "SELECT COUNT(*)::text AS count FROM oracle_submissions",
        )
      ) {
        const [market_id] = (values ?? []) as [number];
        const count = submissions.filter(
          (s) => s.market_id === market_id && s.status === "submitted",
        ).length;
        return { rows: [{ count: String(count) } as unknown as T] };
      }

      if (
        normalizedText.includes("SELECT 1 FROM oracle_submissions WHERE nonce")
      ) {
        const [nonce] = (values ?? []) as [string];
        const exists = submissions.some((s: any) => s.nonce === nonce);
        return { rows: exists ? [{ exists: true } as unknown as T] : [] };
      }

      return { rows: [] };
    },
  };

  beforeEach(async () => {
    submissions = [];
    app = Fastify();
    registerErrorHandler(app);

    // Register versioned API
    await app.register(async (routes) => {
      // Mock pool decorator
      routes.decorate("pool", mockDb);
      await routes.register(oracleRoutes, { prefix: "/api/v1" });
    });
  });

  it("rejects submission with expired timestamp", async () => {
    const expiredTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      headers: {
        authorization: "Bearer test-oracle-api-key",
      },
      payload: signedSubmission(provider, 1, "YES", {
        timestamp: expiredTimestamp,
      }),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.message).toContain("Timestamp outside acceptance window");
    expect(submissions.length).toBe(0);
  });

  it("accepts a correctly signed submission even when signing a different market", async () => {
    // A signature over a different market is invalid for the claimed payload.
    const wrongMarketSig = signOracleMessage(
      { marketId: 999, outcome: "YES", provider: provider.publicKey() },
      provider,
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      headers: {
        authorization: "Bearer test-oracle-api-key",
      },
      payload: {
        marketId: 1,
        outcome: "YES",
        signature: wrongMarketSig,
        provider: provider.publicKey(),
      },
    });

    expect(res.statusCode).toBe(401);
    expect(submissions.length).toBe(0);
  });

  it("rejects submission with duplicate nonce", async () => {
    const nonce = "unique-nonce-123";
    const timestamp = Math.floor(Date.now() / 1000);

    // First submission
    const res1 = await app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      headers: {
        authorization: "Bearer test-oracle-api-key",
      },
      payload: signedSubmission(provider, 1, "YES", { nonce, timestamp }),
    });

    expect(res1.statusCode).toBe(200);

    // Store the nonce in our mock
    (submissions[0] as any).nonce = nonce;

    // Second submission with same nonce should fail
    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      headers: {
        authorization: "Bearer test-oracle-api-key",
      },
      payload: signedSubmission(provider, 2, "NO", { nonce, timestamp }),
    });

    expect(res2.statusCode).toBe(400);
    const body = res2.json();
    expect(body.error.message).toContain("already been used");
  });

  it("accepts valid submission with nonce and timestamp", async () => {
    const nonce = "unique-nonce-456";
    const timestamp = Math.floor(Date.now() / 1000);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      headers: {
        authorization: "Bearer test-oracle-api-key",
      },
      payload: signedSubmission(provider, 5, "YES", { nonce, timestamp }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(true);
  });
});
