import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("@/db/health", () => ({ pingDb: vi.fn() }));
vi.mock("@/db/redis", () => ({ pingRedis: vi.fn() }));

import { pingDb } from "@/db/health";
import { pingRedis } from "@/db/redis";
import { buildServer } from "@/server";
import { INDEXER_STALE_AFTER_SECONDS, STATUS_CACHE_TTL_SECONDS } from "@/api/status";

const pingDbMock = vi.mocked(pingDb);
const pingRedisMock = vi.mocked(pingRedis);

let server: FastifyInstance | undefined;

/** Minimal pg stub: the status feed only ever runs the two SELECTs below. */
function makePool(rows: { events?: unknown; market?: unknown }) {
  return {
    query: vi.fn(async (text: string) => {
      if (text.includes("FROM events")) {
        return { rows: rows.events === undefined ? [] : [rows.events] };
      }
      if (text.includes("FROM markets")) {
        return { rows: rows.market === undefined ? [] : [rows.market] };
      }
      return { rows: [] };
    }),
  } as never;
}

function secondsAgo(seconds: number): Date {
  return new Date(Date.now() - seconds * 1000);
}

async function getStatus(pool?: unknown) {
  server = buildServer({ corsOrigins: [], pool: pool as never });
  const res = await server.inject({ method: "GET", url: "/status" });
  return { res, body: res.json() };
}

beforeEach(() => {
  pingDbMock.mockReset();
  pingRedisMock.mockReset();
  pingDbMock.mockResolvedValue({ ok: true, latencyMs: 2 });
  pingRedisMock.mockResolvedValue({ ok: true, latencyMs: 1 });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("GET /status", () => {
  it("summarises API, indexer and last resolved market in one response", async () => {
    const { res, body } = await getStatus(
      makePool({
        events: { last_ledger: "5150", last_event_at: secondsAgo(10) },
        market: {
          id: "42",
          question: "Will it rain tomorrow?",
          outcome: true,
          updated_at: new Date("2026-01-02T03:04:05.000Z"),
        },
      })
    );

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.api).toEqual({
      ok: true,
      db: { ok: true, latencyMs: 2 },
      redis: { ok: true, latencyMs: 1 },
    });
    expect(body.indexer.ok).toBe(true);
    expect(body.indexer.lastIndexedLedger).toBe(5150);
    expect(body.indexer.lagSeconds).toBeGreaterThanOrEqual(9);
    expect(body.lastResolvedMarket).toEqual({
      id: 42,
      question: "Will it rain tomorrow?",
      outcome: "yes",
      resolvedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(typeof body.generatedAt).toBe("string");
  });

  it("reports outcome 'no' when the market resolved false", async () => {
    const { body } = await getStatus(
      makePool({
        events: { last_ledger: "1", last_event_at: secondsAgo(1) },
        market: { id: "7", question: "Q", outcome: false, updated_at: new Date() },
      })
    );

    expect(body.lastResolvedMarket.outcome).toBe("no");
  });

  // ── Acceptance criterion: cacheable ────────────────────────────────────────

  it("sends a public, cacheable Cache-Control header", async () => {
    const { res } = await getStatus(
      makePool({ events: { last_ledger: "1", last_event_at: secondsAgo(1) } })
    );

    const cacheControl = res.headers["cache-control"];
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain(`max-age=${STATUS_CACHE_TTL_SECONDS}`);
    expect(cacheControl).toContain("stale-while-revalidate");
  });

  // ── Acceptance criterion: no sensitive data ────────────────────────────────

  it("never leaks dependency error details", async () => {
    pingDbMock.mockResolvedValue({
      ok: false,
      error: "connect ECONNREFUSED 10.0.0.5:5432 user=ipredict password=hunter2",
    });
    pingRedisMock.mockResolvedValue({
      ok: false,
      error: "redis://cache.internal:6379 unreachable",
    });

    const { res, body } = await getStatus(makePool({}));

    expect(body.api.db).toEqual({ ok: false });
    expect(body.api.redis).toEqual({ ok: false });

    const serialised = res.body;
    expect(serialised).not.toContain("ECONNREFUSED");
    expect(serialised).not.toContain("hunter2");
    expect(serialised).not.toContain("10.0.0.5");
    expect(serialised).not.toContain("cache.internal");
    expect(serialised).not.toMatch(/error/i);
  });

  it("exposes no fields beyond the documented shape", async () => {
    const { body } = await getStatus(
      makePool({
        events: { last_ledger: "9", last_event_at: secondsAgo(1) },
        market: {
          id: "3",
          question: "Q",
          outcome: true,
          updated_at: new Date(),
          // Columns a careless `SELECT *` would drag in. Neither may surface.
          creator: "GABC000000000000000000000000000000000000000000000000000A",
          total_yes: "1000",
        },
      })
    );

    expect(Object.keys(body).sort()).toEqual([
      "api",
      "generatedAt",
      "indexer",
      "lastResolvedMarket",
      "status",
    ]);
    expect(Object.keys(body.lastResolvedMarket).sort()).toEqual([
      "id",
      "outcome",
      "question",
      "resolvedAt",
    ]);
    expect(JSON.stringify(body)).not.toContain("GABC");
  });

  // ── Degradation ────────────────────────────────────────────────────────────

  it("is 'degraded' when the indexer has stalled", async () => {
    const { res, body } = await getStatus(
      makePool({
        events: {
          last_ledger: "100",
          last_event_at: secondsAgo(INDEXER_STALE_AFTER_SECONDS + 60),
        },
      })
    );

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.indexer.ok).toBe(false);
    expect(body.indexer.lagSeconds).toBeGreaterThan(INDEXER_STALE_AFTER_SECONDS);
  });

  it("is 'degraded' when Redis is down but the database is up", async () => {
    pingRedisMock.mockResolvedValue({ ok: false, error: "nope" });

    const { body } = await getStatus(
      makePool({ events: { last_ledger: "1", last_event_at: secondsAgo(1) } })
    );

    expect(body.status).toBe("degraded");
    expect(body.api.ok).toBe(true);
  });

  it("is 'down' when the database is unreachable", async () => {
    pingDbMock.mockResolvedValue({ ok: false, error: "nope" });

    const { res, body } = await getStatus(makePool({}));

    // Still 200: a status page must be readable during an outage.
    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("down");
    expect(body.api.ok).toBe(false);
  });

  it("stays up when a status query throws", async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error("relation \"events\" does not exist");
      }),
    } as never;

    const { res, body } = await getStatus(pool);

    expect(res.statusCode).toBe(200);
    expect(body.indexer).toEqual({
      ok: false,
      lastIndexedLedger: null,
      lastEventAt: null,
      lagSeconds: null,
    });
    expect(body.lastResolvedMarket).toBeNull();
    expect(res.body).not.toContain("does not exist");
  });

  it("reports an empty database without inventing a lag", async () => {
    const { body } = await getStatus(makePool({ events: { last_ledger: null, last_event_at: null } }));

    expect(body.indexer.lastIndexedLedger).toBeNull();
    expect(body.indexer.lastEventAt).toBeNull();
    expect(body.indexer.lagSeconds).toBeNull();
    expect(body.indexer.ok).toBe(false);
    expect(body.lastResolvedMarket).toBeNull();
  });

  it("is published in the OpenAPI spec", async () => {
    // Registration order is easy to break: a route added straight onto the
    // instance loads before the OpenAPI plugin's onRoute hook and vanishes
    // from the spec. Pin it so a refactor cannot silently undocument the feed.
    server = buildServer({ corsOrigins: [] });
    const res = await server.inject({ method: "GET", url: "/api/docs" });

    expect(Object.keys(res.json().paths ?? {})).toContain("/status");
  });

  it("answers even with no database configured", async () => {
    const { res, body } = await getStatus(undefined);

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.indexer.ok).toBe(false);
  });
});
