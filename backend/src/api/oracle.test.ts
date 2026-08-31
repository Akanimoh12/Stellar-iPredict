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

const TEST_API_KEY = "test-oracle-secret-key-123";

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
    process.env.ORACLE_API_KEY = TEST_API_KEY;
    submissions = [];
    app = Fastify();
    registerErrorHandler(app);
    registerOracleRoutes(app, undefined, mockDb);
  });

  it("returns 401 when ORACLE_API_KEY is unset in the environment", async () => {
    delete process.env.ORACLE_API_KEY;

    const res = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: {
        authorization: `Bearer ${TEST_API_KEY}`,
      },
      payload: {
        marketId: 1,
        outcome: "YES",
        signature: "0x123",
        provider: "provider_1",
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
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
        authorization: `Bearer ${TEST_API_KEY}`,
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
        authorization: `Bearer ${TEST_API_KEY}`,
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
        authorization: `Bearer ${TEST_API_KEY}`,
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
        authorization: `Bearer ${TEST_API_KEY}`,
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
        authorization: `API-Key ${TEST_API_KEY}`,
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
        authorization: `Bearer ${TEST_API_KEY}`,
      },
      payload: signedSubmission(provider, 99, "YES"),
    });

    expect(res1.statusCode).toBe(200);

    // Second submission for same market should fail with 409
    // Mock the duplicate constraint error
    const originalQuery = mockDb.query;
    mockDb.query = async <T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> => {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (normalized.includes("INSERT INTO oracle_submissions")) {
        const error: any = new Error(
          "duplicate key value violates unique constraint",
        );
        error.code = "23505";
        error.constraint = "uq_oracle_submissions_market_id";
        throw error;
      }
      return originalQuery.call(mockDb, text, values) as Promise<{ rows: T[] }>;
    };

    const res2 = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: {
        authorization: `Bearer ${TEST_API_KEY}`,
      },
      payload: signedSubmission(provider, 99, "NO"),
    });

    expect(res2.statusCode).toBe(409);
    const body = res2.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toContain("market 99");
  });
});

describe("POST /api/oracle/submit — outcome validation (issue #650)", () => {
  let app: FastifyInstance;
  let submissions: OracleSubmissionRow[];
  const provider = Keypair.random();

  const mockDb = {
    async query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
      const t = text.replace(/\s+/g, " ").trim();
      if (t.includes("INSERT INTO oracle_submissions")) {
        const [market_id, submitter, outcome, bond_amount] = (values ?? []) as [
          number,
          string,
          string,
          string,
        ];
        const row: OracleSubmissionRow = {
          id: submissions.length + 1,
          market_id,
          submitter,
          outcome,
          bond_amount,
          submitted_at: new Date(),
          status: "submitted",
        };
        submissions.push(row);
        return { rows: [row as unknown as T] };
      }
      if (t.includes("SELECT COUNT(*)::text AS count FROM oracle_submissions")) {
        return { rows: [{ count: "0" } as unknown as T] };
      }
      return { rows: [] };
    },
  };

  /** Sign over the *canonical* outcome (what the handler verifies against). */
  function submissionSignedCanonical(
    marketId: number,
    rawOutcome: unknown,
    canonical: "YES" | "NO",
  ): Record<string, unknown> {
    return {
      marketId,
      outcome: rawOutcome,
      provider: provider.publicKey(),
      signature: signOracleMessage(
        { marketId, outcome: canonical, provider: provider.publicKey() },
        provider,
      ),
    };
  }

  beforeEach(() => {
    submissions = [];
    app = Fastify();
    registerErrorHandler(app);
    registerOracleRoutes(app, undefined, mockDb);
  });

  it("rejects an outcome outside the permitted set with 400", async () => {
    for (const bad of ["maybe", "YES!", "yesno", "2", "  "]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/oracle/submit",
        headers: { authorization: "Bearer test-oracle-api-key" },
        payload: {
          marketId: 7,
          outcome: bad,
          provider: provider.publicKey(),
          signature: "irrelevant-rejected-before-verification",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("BAD_REQUEST");
    }
    expect(submissions.length).toBe(0);
  });

  it("persists boolean and string spellings of the same outcome identically", async () => {
    const a = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: { authorization: "Bearer test-oracle-api-key" },
      payload: submissionSignedCanonical(11, true, "YES"),
    });
    const b = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: { authorization: "Bearer test-oracle-api-key" },
      payload: submissionSignedCanonical(12, "yes", "YES"),
    });
    const c = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: { authorization: "Bearer test-oracle-api-key" },
      payload: submissionSignedCanonical(13, "YES ", "YES"),
    });

    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([200, 200, 200]);
    expect(submissions.map((s) => s.outcome)).toEqual(["YES", "YES", "YES"]);
  });

  it("normalises false / no to the canonical NO", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: { authorization: "Bearer test-oracle-api-key" },
      payload: submissionSignedCanonical(21, false, "NO"),
    });
    expect(res.statusCode).toBe(200);
    expect(submissions[0]?.outcome).toBe("NO");
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
    process.env.ORACLE_API_KEY = TEST_API_KEY;
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
        authorization: `Bearer ${TEST_API_KEY}`,
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
        authorization: `Bearer ${TEST_API_KEY}`,
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
        authorization: `Bearer ${TEST_API_KEY}`,
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
        authorization: `Bearer ${TEST_API_KEY}`,
      },
      payload: signedSubmission(provider, 5, "YES", { nonce, timestamp }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(true);
  });
});
