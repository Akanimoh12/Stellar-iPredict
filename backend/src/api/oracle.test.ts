import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerOracleRoutes } from "./oracle.js";
import { registerErrorHandler } from "../lib/errors.js";
import type { OracleSubmissionRow } from "../db/types.js";

describe("POST /api/oracle/submit", () => {
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

      if (normalizedText.includes("SELECT COUNT(*)::text AS count FROM oracle_submissions")) {
        const [market_id] = (values ?? []) as [number];
        const count = submissions.filter(
          (s) => s.market_id === market_id && s.status === "submitted"
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
  });

  it("records submission and calculates remaining submissions to threshold", async () => {
    // 1st submission
    const res1 = await app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: {
        authorization: "Bearer test-oracle-api-key",
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
        authorization: "Bearer test-oracle-api-key",
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
        authorization: "Bearer test-oracle-api-key",
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
        authorization: "API-Key test-oracle-api-key",
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
});
