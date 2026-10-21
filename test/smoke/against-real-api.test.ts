/**
 * The smoke suite, run against the *real* Fastify server.
 *
 * `test/smoke/smoke.test.ts` proves the checks detect broken responses, but
 * against a hand-written stub — which means it would keep passing if the real
 * server's response shape drifted away from what the checks expect. This file
 * closes that gap: it boots the actual application with an injected database
 * and asserts the suite's verdict against real responses.
 *
 * ## What is and is not faked here
 *
 * `buildServer({ pool })` injects a pool into the market and oracle routes, so
 * those paths are exercised for real. `/readyz` and `/resolution-status` read
 * the module-level `pg` and `ioredis` singletons instead — there is no
 * injection seam for them, and inventing one just to make a test green would
 * hide a genuine property of the service. Those two checks are therefore
 * asserted as *dependency-backed*: they are evaluated, and here they fail
 * because the test process has no database, which is a different fact from
 * "the check is broken".
 *
 * Nothing in this file reaches the network, a database, or a provider.
 */

import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../../backend/src/server.js";
import { createTestRedis } from "../../backend/src/test/fakeRedis.js";
import { runSmokeSuite, type CheckContext, type CheckOutcome, type FetchLike } from "./checks.js";

const MARKET_ROW = {
  id: 1,
  question: "Will Bitcoin reach $100,000?",
  image_url: null,
  category: "Crypto",
  end_time: "9999999999",
  // Well past Number.MAX_SAFE_INTEGER once counted in stroops. The smoke
  // suite asserts this reaches the client as an exact string, which is the
  // only way a release that reparses NUMERIC as a number gets caught.
  total_yes: "99999999999999.9999999",
  total_no: "1234.5678901",
  resolved: false,
  outcome: null,
  cancelled: false,
  creator: "G".padEnd(56, "A"),
  bet_count: 3,
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: new Date("2026-01-01T00:00:00.000Z"),
};

/**
 * A pool that can be made to fail on demand.
 *
 * `failWith` reproduces the deployment defect that is hardest to eyeball: the
 * process is up and serving, but every query errors — which is what a missing
 * `DATABASE_URL`, an unmigrated database, or a severed connection all look
 * like from the outside.
 *
 * The by-id lookup is honoured rather than answered for every id, so the
 * 404-handling check exercises the server's 404 path and not the fake's.
 */
function createControllablePool(): Pool & { failWith(error: Error): void; recover(): void } {
  let failure: Error | undefined;

  const query = async (text: string, params?: unknown[]) => {
    if (failure) throw failure;

    if (text.includes("WHERE id =")) {
      return { rows: params?.[0] === MARKET_ROW.id ? [MARKET_ROW] : [] };
    }
    if (text.includes("FROM markets")) {
      // `getMarkets` appends its own COUNT(*) OVER () column.
      return { rows: [{ ...MARKET_ROW, total_count: 1 }] };
    }
    return { rows: [] };
  };

  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
    on: () => {},
    end: async () => {},
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
    failWith: (error: Error) => {
      failure = error;
    },
    recover: () => {
      failure = undefined;
    },
  } as unknown as Pool & { failWith(error: Error): void; recover(): void };

  return pool;
}

/**
 * Checks whose answer depends on a live Postgres/Redis, which this process
 * does not have. See the file header.
 */
const DEPENDENCY_BACKED = new Set(["health.readiness", "health.resolution"]);

let server: FastifyInstance;
let baseUrl: string;
let pool: ReturnType<typeof createControllablePool>;
let redis: ReturnType<typeof createTestRedis>;

function outcome(outcomes: CheckOutcome[], id: string): CheckOutcome {
  const found = outcomes.find((o) => o.id === id);
  if (!found) throw new Error(`no outcome for ${id}`);
  return found;
}

/** Failures that are not explained by this process lacking a live database. */
function unexplained(outcomes: CheckOutcome[]): string[] {
  return outcomes
    .filter((o) => o.result.status === "fail" && !DEPENDENCY_BACKED.has(o.id))
    .map((o) => `${o.id}: ${o.result.detail}`);
}

async function run(overrides: Partial<CheckContext> = {}) {
  const context: CheckContext = { baseUrl, timeoutMs: 5_000, strict: false, ...overrides };
  return runSmokeSuite(context, { fetchImpl: fetch as FetchLike });
}

beforeAll(async () => {
  // Unreachable on purpose: the module-level health probes should fail fast
  // and deterministically rather than hang on a connection attempt.
  process.env.DATABASE_URL ??= "postgres://nobody:nobody@127.0.0.1:1/none";
  process.env.REDIS_URL ??= "redis://127.0.0.1:1";

  pool = createControllablePool();
  redis = createTestRedis();
  server = buildServer({
    corsOrigins: ["http://localhost:3000"],
    pool,
    redis: redis as never,
    logger: false,
  });
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await server.close();
});

describe("smoke suite against the real API", () => {
  it("passes every check that does not need a live database", async () => {
    const result = await run();

    expect(unexplained(result.outcomes)).toEqual([]);
    expect(result.passed).toBeGreaterThanOrEqual(6);
  });

  it("evaluates the dependency-backed checks rather than skipping them", async () => {
    const result = await run();

    for (const id of DEPENDENCY_BACKED) {
      // Not a `skip`: they ran and reported the real answer for this process.
      expect(outcome(result.outcomes, id).result.status).not.toBe("skip");
    }
  });

  it("reads a market list whose amounts survive as exact strings", async () => {
    const response = await fetch(`${baseUrl}/api/markets?filter=all&limit=5`);
    const body = (await response.json()) as { markets: { total_yes: string }[] };

    expect(response.status).toBe(200);
    expect(body.markets[0]!.total_yes).toBe(MARKET_ROW.total_yes);
    expect(outcome((await run()).outcomes, "markets.list").result.status).toBe("pass");
  });

  it("reads a market by id and its odds", async () => {
    const detail = outcome((await run()).outcomes, "markets.detail");

    expect(detail.result.status).toBe("pass");
    expect(detail.result.data?.marketId).toBe(1);
  });

  it("rejects an unauthenticated oracle submission", async () => {
    const result = await run();

    expect(outcome(result.outcomes, "oracle.authRejected").result.status).toBe("pass");
    expect(outcome(result.outcomes, "oracle.badKeyRejected").result.status).toBe("pass");
  });

  it("returns 404 for an unknown market rather than 500", async () => {
    const response = await fetch(`${baseUrl}/api/markets/999999999`);

    expect(response.status).toBe(404);
    expect(outcome((await run()).outcomes, "markets.notFound").result.status).toBe("pass");
  });

  it("skips the authenticated submission check when no key is supplied", async () => {
    const signature = outcome((await run()).outcomes, "oracle.badSignatureRejected");

    // A skip is not a pass: the report must say what was not exercised.
    expect(signature.result.status).toBe("skip");
    expect(signature.result.detail).toMatch(/--oracle-api-key/);
  });

  it("catches the deployment when the database stops answering", async () => {
    // The market routes read through a Redis cache, so an earlier green run
    // would otherwise answer these requests without touching the database at
    // all — and the outage would be invisible to the suite.
    await redis.flushall();
    pool.failWith(new Error("connection terminated unexpectedly"));

    let result;
    try {
      result = await run();
    } finally {
      pool.recover();
    }

    // The API is still serving; every read is broken. This is the failure a
    // manual spot check of the homepage would not catch.
    expect(result.exitCode).toBe(1);
    const failing = result.outcomes.filter((o) => o.result.status === "fail").map((o) => o.id);
    expect(failing).toContain("markets.list");
    expect(failing).toContain("markets.detail");

    // ...and green again once the dependency is back, which shows the
    // failures above were about the deployment and not the suite itself.
    await redis.flushall();
    const recovered = await run();
    expect(unexplained(recovered.outcomes)).toEqual([]);
  });
});
