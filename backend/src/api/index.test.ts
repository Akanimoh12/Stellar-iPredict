import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";

const { getBetsByBettorMock, poolQueryMock } = vi.hoisted(() => ({
  getBetsByBettorMock: vi.fn(),
  poolQueryMock: vi.fn(),
}));

vi.mock("../db/bets.js", () => ({ getBetsByBettor: getBetsByBettorMock }));
vi.mock("../db/pool.js", () => ({ pool: { query: poolQueryMock } }));

import { buildServer, EXPECTED_SECURITY_HEADERS } from "../server.js";
import { API_PREFIX, API_VERSION, routers } from "./index.js";
import { createFakePool } from "../test/fakePool.js";

const ADDRESS = Keypair.random().publicKey();

let server: FastifyInstance | undefined;

function makeServer(): FastifyInstance {
  server = buildServer({ corsOrigins: [], pool: createFakePool(poolQueryMock) });
  return server;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
  getBetsByBettorMock.mockReset();
  poolQueryMock.mockReset();
});

describe("route index", () => {
  it("versions the prefix", () => {
    expect(API_VERSION).toBe("v1");
    expect(API_PREFIX).toBe("/api/v1");
  });

  it("registers at least one feature router", () => {
    expect(routers.length).toBeGreaterThan(0);
  });
});

describe("mounting", () => {
  it("serves feature routes under /api/v1", async () => {
    getBetsByBettorMock.mockResolvedValueOnce([]);
    poolQueryMock.mockResolvedValueOnce({ rows: [] });

    const res = await makeServer().inject({
      method: "GET",
      url: `${API_PREFIX}/profile/${ADDRESS}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ bets: [] });
  });

  it("reaches the route's own validation, not a router miss", async () => {
    const res = await makeServer().inject({
      method: "GET",
      url: `${API_PREFIX}/profile/not-a-stellar-address`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Invalid Stellar address format",
    });
  });

  it("does not serve feature routes off the unversioned prefix", async () => {
    const res = await makeServer().inject({
      method: "GET",
      url: `/api/profile/${ADDRESS}`,
    });

    expect(res.statusCode).toBe(404);
    expect(getBetsByBettorMock).not.toHaveBeenCalled();
  });

  it("leaves the unversioned health probe alone", async () => {
    const res = await makeServer().inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

function assertSecurityHeaders(headers: Record<string, string | number | string[] | undefined>) {
  for (const [header, expectedValue] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
    expect(headers[header], `Mismatch on security header "${header}"`).toBe(expectedValue);
  }
  expect(headers["x-powered-by"]).toBeUndefined();
}

describe("security headers on API responses", () => {
  it("carries all configured security headers on successful feature responses (200 OK)", async () => {
    getBetsByBettorMock.mockResolvedValueOnce([]);
    poolQueryMock.mockResolvedValueOnce({ rows: [] });

    const res = await makeServer().inject({
      method: "GET",
      url: `${API_PREFIX}/profile/${ADDRESS}`,
    });

    expect(res.statusCode).toBe(200);
    assertSecurityHeaders(res.headers);
  });

  it("carries all configured security headers on client validation errors (400 Bad Request)", async () => {
    const res = await makeServer().inject({
      method: "GET",
      url: `${API_PREFIX}/profile/not-a-stellar-address`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
    assertSecurityHeaders(res.headers);
  });

  it("carries all configured security headers on route misses (404 Not Found)", async () => {
    const res = await makeServer().inject({
      method: "GET",
      url: `${API_PREFIX}/non-existent-endpoint`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    assertSecurityHeaders(res.headers);
  });

  it("carries all configured security headers on method not allowed (405 Method Not Allowed)", async () => {
    const res = await makeServer().inject({
      method: "POST",
      url: `${API_PREFIX}/profile/${ADDRESS}`,
    });

    expect(res.statusCode).toBe(405);
    expect(res.json().error.code).toBe("METHOD_NOT_ALLOWED");
    assertSecurityHeaders(res.headers);
  });

  it("carries all configured security headers on server failures (500 Internal Server Error)", async () => {
    getBetsByBettorMock.mockRejectedValueOnce(new Error("Simulated backend database error"));

    const res = await makeServer().inject({
      method: "GET",
      url: `${API_PREFIX}/profile/${ADDRESS}`,
    });

    expect(res.statusCode).toBe(500);
    assertSecurityHeaders(res.headers);
  });

  it("asserts exact locked-down CSP string and verifies no permissive defaults are merged", async () => {
    getBetsByBettorMock.mockResolvedValueOnce([]);
    poolQueryMock.mockResolvedValueOnce({ rows: [] });

    const res = await makeServer().inject({
      method: "GET",
      url: `${API_PREFIX}/profile/${ADDRESS}`,
    });

    const csp = res.headers["content-security-policy"];
    expect(csp).toBe("default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("style-src");
    expect(csp).not.toContain("img-src");
    expect(csp).not.toContain("font-src");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("object-src");
  });

  it("asserts exact HSTS directive with includeSubDomains and 180-day maxAge", async () => {
    const res = await makeServer().inject({
      method: "GET",
      url: `${API_PREFIX}/profile/not-a-stellar-address`,
    });

    expect(res.headers["strict-transport-security"]).toBe("max-age=15552000; includeSubDomains");
  });

  it("fails verification if any header directive is weakened or removed", () => {
    const weakened = {
      ...EXPECTED_SECURITY_HEADERS,
      "content-security-policy": "default-src 'none'; script-src 'self'",
    };

    expect(() => {
      assertSecurityHeaders(weakened);
    }).toThrow(/Mismatch on security header "content-security-policy"/);
  });
});

