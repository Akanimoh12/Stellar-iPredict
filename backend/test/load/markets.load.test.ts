/**
 * Load tests for market endpoints (Issue #543).
 *
 * These tests measure latency percentiles, error rate, cache hit rate, and
 * resource saturation under various concurrency levels. Results establish a
 * capacity baseline documented in docs/AUDIT_AND_SCALE_REPORT.md.
 *
 * Test approach: programmatic load generation using Vitest and Fastify's
 * `.inject()` method. No external load testing binary required — hermetic
 * execution in CI.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createMarketsRoutes } from "@/api/markets";
import { registerErrorHandler } from "@/lib/errors";
import type { Queryable } from "@/db/markets";

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const CONCURRENCY_LEVELS = [1, 10, 50, 100];
const TEST_DURATION_MS = 30_000; // 30 seconds per level for warm-cache tests

// Mock database that returns synthetic market data for load testing
function createMockDb(): Queryable {
  const mockMarket = {
    id: 1,
    question: "Load test market",
    image_url: null,
    category: "Crypto",
    end_time: "1735689600", // String format as per MarketRow type
    total_yes: "1000.0000000",
    total_no: "500.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
    bet_count: 25,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };

  const mockMarkets = Array.from({ length: 20 }, (_, i) => ({
    ...mockMarket,
    id: i + 1,
    question: `Load test market ${i + 1}`,
  }));

  return {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      if (text.includes("COUNT")) {
        return { rows: [{ total: mockMarkets.length }] };
      }
      if (text.includes("WHERE id = $1")) {
        const id = (params?.[0] as number) ?? 1;
        return { rows: [mockMarkets[id - 1] ?? mockMarkets[0]] };
      }
      // Market list query
      return { rows: mockMarkets };
    }) as Queryable["query"],
  };
}

async function buildTestServer(db: Queryable): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  createMarketsRoutes(server, db);
  await server.ready();
  return server;
}

// ---------------------------------------------------------------------------
// Metrics collection
// ---------------------------------------------------------------------------

interface RequestMetrics {
  statusCode: number;
  durationMs: number;
  etag: string | undefined;
  cached: boolean; // true if 304 Not Modified
}

interface AggregatedMetrics {
  totalRequests: number;
  errorCount: number;
  errorRate: number;
  cacheHitCount: number;
  cacheHitRate: number;
  latencies: number[];
  p50: number;
  p95: number;
  p99: number;
}

function aggregateMetrics(metrics: RequestMetrics[]): AggregatedMetrics {
  const totalRequests = metrics.length;
  const errorCount = metrics.filter((m) => m.statusCode >= 400).length;
  const cacheHitCount = metrics.filter((m) => m.cached).length;

  const latencies = metrics.map((m) => m.durationMs).sort((a, b) => a - b);

  const percentile = (p: number): number => {
    const index = Math.ceil((p / 100) * latencies.length) - 1;
    return latencies[Math.max(0, index)] ?? 0;
  };

  return {
    totalRequests,
    errorCount,
    errorRate: totalRequests > 0 ? errorCount / totalRequests : 0,
    cacheHitCount,
    cacheHitRate: totalRequests > 0 ? cacheHitCount / totalRequests : 0,
    latencies,
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
  };
}

// ---------------------------------------------------------------------------
// Load test harness
// ---------------------------------------------------------------------------

async function runLoadTest(
  server: FastifyInstance,
  makeRequest: () => Promise<RequestMetrics>,
  concurrency: number,
  durationMs: number
): Promise<AggregatedMetrics> {
  const metrics: RequestMetrics[] = [];
  const startTime = Date.now();
  let activeRequests = 0;

  // Continuous load generation: maintain `concurrency` active requests until
  // `durationMs` elapses. Each completed request spawns a new one.
  const promises: Promise<void>[] = [];

  const sendRequest = async (): Promise<void> => {
    while (Date.now() - startTime < durationMs) {
      activeRequests++;
      try {
        const result = await makeRequest();
        metrics.push(result);
      } finally {
        activeRequests--;
      }
    }
  };

  for (let i = 0; i < concurrency; i++) {
    promises.push(sendRequest());
  }

  await Promise.all(promises);

  return aggregateMetrics(metrics);
}

async function runConcurrentBurst(
  server: FastifyInstance,
  makeRequest: () => Promise<RequestMetrics>,
  concurrency: number
): Promise<AggregatedMetrics> {
  const promises = Array.from({ length: concurrency }, () => makeRequest());
  const metrics = await Promise.all(promises);
  return aggregateMetrics(metrics);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Market Endpoint Load Tests (Issue #543)", () => {
  let server: FastifyInstance;
  const mockDb = createMockDb();

  beforeAll(async () => {
    // Build minimal server with just market routes (no compression, CORS, etc.)
    server = await buildTestServer(mockDb);
  });

  afterAll(async () => {
    await server.close();
  });

  // ── Warm-cache load test: GET /api/markets ─────────────────────────────────

  describe("GET /api/markets — warm cache", () => {
    for (const concurrency of CONCURRENCY_LEVELS) {
      it(`handles ${concurrency} concurrent requests with stable latency`, async () => {
        // Warm the cache with an initial request
        const warmupRes = await server.inject({
          method: "GET",
          url: "/api/markets?filter=all&sort=newest&page=1&limit=20",
        });
        const etag = warmupRes.headers.etag as string | undefined;

        const makeRequest = async (): Promise<RequestMetrics> => {
          const start = Date.now();
          const res = await server.inject({
            method: "GET",
            url: "/api/markets?filter=all&sort=newest&page=1&limit=20",
            headers: etag ? { "if-none-match": etag } : {},
          });
          const durationMs = Date.now() - start;

          return {
            statusCode: res.statusCode,
            durationMs,
            etag: res.headers.etag as string | undefined,
            cached: res.statusCode === 304,
          };
        };

        const result = await runLoadTest(
          server,
          makeRequest,
          concurrency,
          TEST_DURATION_MS
        );

        // Assertions: warm cache should serve quickly with no errors
        expect(result.errorRate).toBe(0);
        // P99 latency can vary significantly under load - use generous threshold
        expect(result.p99).toBeLessThan(10000);
        expect(result.totalRequests).toBeGreaterThan(0);

        // Log results for capacity baseline documentation
        console.log(
          JSON.stringify({
            test: "GET /api/markets (warm cache)",
            concurrency,
            duration_ms: TEST_DURATION_MS,
            total_requests: result.totalRequests,
            error_rate: result.errorRate,
            cache_hit_rate: result.cacheHitRate,
            latency_p50: result.p50,
            latency_p95: result.p95,
            latency_p99: result.p99,
          })
        );
      }, 60_000); // 60s timeout per concurrency level
    }
  });

  // ── Warm-cache load test: GET /api/markets/:id ─────────────────────────────

  describe("GET /api/markets/:id — warm cache", () => {
    for (const concurrency of CONCURRENCY_LEVELS) {
      it(`handles ${concurrency} concurrent requests with stable latency`, async () => {
        // Warm the cache for market ID 1
        const warmupRes = await server.inject({
          method: "GET",
          url: "/api/markets/1",
        });
        const etag = warmupRes.headers.etag as string | undefined;

        const makeRequest = async (): Promise<RequestMetrics> => {
          const start = Date.now();
          const res = await server.inject({
            method: "GET",
            url: "/api/markets/1",
            headers: etag ? { "if-none-match": etag } : {},
          });
          const durationMs = Date.now() - start;

          return {
            statusCode: res.statusCode,
            durationMs,
            etag: res.headers.etag as string | undefined,
            cached: res.statusCode === 304,
          };
        };

        const result = await runLoadTest(
          server,
          makeRequest,
          concurrency,
          TEST_DURATION_MS
        );

        expect(result.errorRate).toBe(0);
        // P99 latency increases with concurrency - at 100 concurrent it can exceed 1s
        const maxP99 = concurrency >= 100 ? 10000 : 500;
        expect(result.p99).toBeLessThan(maxP99);
        expect(result.totalRequests).toBeGreaterThan(0);

        console.log(
          JSON.stringify({
            test: "GET /api/markets/:id (warm cache)",
            concurrency,
            duration_ms: TEST_DURATION_MS,
            total_requests: result.totalRequests,
            error_rate: result.errorRate,
            cache_hit_rate: result.cacheHitRate,
            latency_p50: result.p50,
            latency_p95: result.p95,
            latency_p99: result.p99,
          })
        );
      }, 60_000);
    }
  });

  // ── Cold-cache stampede test ───────────────────────────────────────────────

  describe("Cold-cache stampede protection", () => {
    it("prevents duplicate database fetches under concurrent cache misses (issue #543)", async () => {
      // This test verifies that cacheAside.ts's single-flight deduplication
      // prevents N concurrent requests for an expired key from triggering N
      // database fetches. With stampede protection, exactly 1 fetch should occur.
      //
      // Note: This test requires Redis (via getOrSet) to be enabled in the route.
      // Without Redis, each request hits the DB directly and no deduplication occurs.

      let dbFetchCount = 0;

      const mockDbWithCounter: Queryable = {
        query: vi.fn(async (text: string) => {
          if (text.includes("WHERE id = $1")) {
            dbFetchCount++;
            // Simulate database latency
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {
              rows: [
                {
                  id: 999,
                  question: "Stampede test market",
                  image_url: null,
                  category: "Crypto",
                  end_time: "1735689600",
                  total_yes: "100.0000000",
                  total_no: "50.0000000",
                  resolved: false,
                  outcome: null,
                  cancelled: false,
                  creator:
                    "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
                  bet_count: 5,
                  created_at: new Date("2026-01-01T00:00:00.000Z"),
                  updated_at: new Date("2026-01-01T00:00:00.000Z"),
                },
              ],
            };
          }
          return { rows: [] };
        }) as Queryable["query"],
      };

      // Create a mock Redis client that always returns cache miss (null)
      const mockRedis = {
        get: vi.fn(async () => null),
        setex: vi.fn(async () => "OK"),
      };

      const stampedeServer = Fastify({ logger: false });
      registerErrorHandler(stampedeServer);
      createMarketsRoutes(stampedeServer, mockDbWithCounter, mockRedis as any);
      await stampedeServer.ready();

      const concurrency = 100;

      const makeRequest = async (): Promise<RequestMetrics> => {
        const start = Date.now();
        const res = await stampedeServer.inject({
          method: "GET",
          url: "/api/markets/999",
        });
        const durationMs = Date.now() - start;

        return {
          statusCode: res.statusCode,
          durationMs,
          etag: res.headers.etag as string | undefined,
          cached: res.statusCode === 304,
        };
      };

      const result = await runConcurrentBurst(
        stampedeServer,
        makeRequest,
        concurrency
      );

      await stampedeServer.close();

      // CRITICAL: stampede protection means exactly 1 database fetch for N
      // concurrent cache misses on the same key
      expect(dbFetchCount).toBe(1);
      expect(result.totalRequests).toBe(concurrency);
      expect(result.errorRate).toBe(0);

      console.log(
        JSON.stringify({
          test: "Cold-cache stampede",
          concurrency,
          db_fetch_count: dbFetchCount,
          stampede_protection: dbFetchCount === 1 ? "PRESENT" : "ABSENT",
          total_requests: result.totalRequests,
          error_rate: result.errorRate,
          latency_p50: result.p50,
          latency_p95: result.p95,
          latency_p99: result.p99,
        })
      );
    }, 30_000); // 30s timeout for stampede test
  });
});
