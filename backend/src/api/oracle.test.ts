import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerOracleRoutes, oracleRoutes } from "./oracle.js";
import { registerErrorHandler } from "../lib/errors.js";
import type { OracleSubmissionRow } from "../db/types.js";

const TEST_API_KEY = "test-oracle-secret-key-123";

describe("POST /api/oracle/submit (legacy)", () => {
  let app: FastifyInstance;
  let submissions: OracleSubmissionRow[];

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
      payload: {
        marketId: 1,
        outcome: "YES",
        signature: "0x123",
        provider: "provider_1",
      },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when authorization token is invalid", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: {
        authorization: "Bearer invalid-token",
      },
      payload: {
        marketId: 1,
        outcome: "YES",
        signature: "0x123",
        provider: "provider_1",
      },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
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
  });

  it("records submission and calculates remaining submissions to threshold", async () => {
    // 1st submission
    const res1 = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: {
        authorization: `Bearer ${TEST_API_KEY}`,
      },
      payload: {
        marketId: 42,
        outcome: "YES",
        signature: "sig1",
        provider: "provider_alpha",
      },
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
      payload: {
        marketId: 42,
        outcome: "YES",
        signature: "sig2",
        provider: "provider_beta",
      },
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
      payload: {
        marketId: 42,
        outcome: "YES",
        signature: "sig3",
        provider: "provider_gamma",
      },
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
      payload: {
        marketId: 10,
        outcome: "NO",
        signature: "sig_key",
        provider: "provider_delta",
      },
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
      payload: {
        marketId: 99,
        outcome: "YES",
        signature: "sig1",
        provider: "provider_test",
      },
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
      payload: {
        marketId: 99,
        outcome: "NO",
        signature: "sig2",
        provider: "provider_test2",
      },
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
      payload: {
        marketId: 1,
        outcome: "YES",
        signature: "sig1",
        provider: "provider_test",
        timestamp: expiredTimestamp,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.message).toContain("Timestamp outside acceptance window");
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
      payload: {
        marketId: 1,
        outcome: "YES",
        signature: "sig1",
        provider: "provider_test",
        nonce,
        timestamp,
      },
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
      payload: {
        marketId: 2,
        outcome: "NO",
        signature: "sig2",
        provider: "provider_test",
        nonce,
        timestamp,
      },
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
      payload: {
        marketId: 5,
        outcome: "YES",
        signature: "sig1",
        provider: "provider_test",
        nonce,
        timestamp,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(true);
  });
});
