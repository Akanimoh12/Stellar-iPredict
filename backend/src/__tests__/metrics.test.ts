import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import {
  observe,
  getSnapshot,
  getHistogram,
  resetHistogram,
  configureBuckets,
  normaliseLabel,
  cumulativeCounts,
  DEFAULT_BUCKETS,
  registerMetricsHook,
  recordError,
  getErrorCount,
  getErrorCounts,
  resetErrorCounts,
  getBusinessMetrics,
  serializeBusinessMetrics,
  serializeHistogram,
  serializeErrorCounts,
} from "../metrics.js";
import { buildServer } from "@/server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
beforeEach(() => {
  resetHistogram();
  resetErrorCounts();
});

// ---------------------------------------------------------------------------
// normaliseLabel
// ---------------------------------------------------------------------------
describe("normaliseLabel", () => {
  it("upper-cases the method", () => {
    expect(normaliseLabel("get", "/api/markets")).toBe("GET /api/markets");
  });

  it("preserves path as-is", () => {
    expect(normaliseLabel("POST", "/api/markets/:id/bets")).toBe(
      "POST /api/markets/:id/bets"
    );
  });
});

// ---------------------------------------------------------------------------
// configureBuckets validation
// ---------------------------------------------------------------------------
describe("configureBuckets", () => {
  afterEach(() => {
    // Restore default buckets so other tests are unaffected.
    // Re-import is not needed — resetHistogram() clears entries; the buckets
    // setting only affects *new* entries, so resetting to defaults here is
    // enough for isolation.
    configureBuckets([...DEFAULT_BUCKETS]);
    resetErrorCounts();
  });

  it("throws when buckets array is empty", () => {
    expect(() => configureBuckets([])).toThrow(RangeError);
  });

  it("throws when buckets are not strictly ascending", () => {
    expect(() => configureBuckets([10, 10, Infinity])).toThrow(RangeError);
    expect(() => configureBuckets([50, 10, Infinity])).toThrow(RangeError);
  });

  it("throws when the last bucket is not Infinity", () => {
    expect(() => configureBuckets([10, 50, 100])).toThrow(RangeError);
  });

  it("accepts a valid custom bucket list", () => {
    expect(() => configureBuckets([10, 50, 100, Infinity])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// observe / getSnapshot
// ---------------------------------------------------------------------------
describe("observe + getSnapshot", () => {
  it("returns undefined when no observations have been made", () => {
    expect(getSnapshot("GET", "/api/markets")).toBeUndefined();
  });

  it("creates an entry on the first observation", () => {
    observe("GET", "/api/markets", 42);
    const snap = getSnapshot("GET", "/api/markets");
    expect(snap).not.toBeUndefined();
    expect(snap!.count).toBe(1);
    expect(snap!.sum).toBeCloseTo(42);
  });

  it("places the observation in the correct bucket", () => {
    // 42 ms → should land in the ≤50 ms bucket (index 3 in DEFAULT_BUCKETS)
    observe("GET", "/api/markets", 42);
    const snap = getSnapshot("GET", "/api/markets")!;
    const idx = snap.buckets.findIndex((b) => b >= 42);
    expect(snap.counts[idx]).toBe(1);
    // Every other bucket must be zero.
    snap.counts.forEach((c, i) => {
      if (i !== idx) expect(c).toBe(0);
    });
  });

  it("accumulates multiple observations correctly", () => {
    observe("GET", "/api/markets", 10);
    observe("GET", "/api/markets", 10);
    observe("GET", "/api/markets", 300);

    const snap = getSnapshot("GET", "/api/markets")!;
    expect(snap.count).toBe(3);
    expect(snap.sum).toBeCloseTo(320);
  });

  it("tracks separate histograms per route", () => {
    observe("GET", "/api/markets", 10);
    observe("GET", "/api/markets/:id", 200);

    expect(getSnapshot("GET", "/api/markets")!.count).toBe(1);
    expect(getSnapshot("GET", "/api/markets/:id")!.count).toBe(1);
  });

  it("tracks separate histograms per method", () => {
    observe("GET", "/api/markets", 10);
    observe("POST", "/api/markets", 100);

    expect(getSnapshot("GET", "/api/markets")!.count).toBe(1);
    expect(getSnapshot("POST", "/api/markets")!.count).toBe(1);
  });

  it("places a very fast request (< first bucket) in bucket[0]", () => {
    observe("GET", "/healthz", 1); // 1 ms < 5 ms (DEFAULT_BUCKETS[0])
    const snap = getSnapshot("GET", "/healthz")!;
    expect(snap.counts[0]).toBe(1);
  });

  it("places an extremely slow request in the Infinity bucket", () => {
    observe("GET", "/healthz", 99_999);
    const snap = getSnapshot("GET", "/healthz")!;
    const lastIdx = snap.buckets.length - 1;
    expect(snap.buckets[lastIdx]).toBe(Infinity);
    expect(snap.counts[lastIdx]).toBe(1);
  });

  it("snapshot is immutable (frozen)", () => {
    observe("GET", "/api/markets", 50);
    const snap = getSnapshot("GET", "/api/markets")!;
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.counts)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getHistogram
// ---------------------------------------------------------------------------
describe("getHistogram", () => {
  it("returns an empty array when no observations exist", () => {
    expect(getHistogram()).toEqual([]);
  });

  it("returns all routes sorted alphabetically by label", () => {
    observe("GET", "/api/markets", 10);
    observe("GET", "/api/leaderboard", 20);
    observe("GET", "/api/stats", 30);

    const routes = getHistogram().map((s) => s.route);
    expect(routes).toEqual([
      "GET /api/leaderboard",
      "GET /api/markets",
      "GET /api/stats",
    ]);
  });

  it("includes correct count and sum for each route", () => {
    observe("GET", "/api/markets", 40);
    observe("GET", "/api/markets", 60);
    observe("GET", "/api/stats", 100);

    const hist = getHistogram();
    const markets = hist.find((s) => s.route === "GET /api/markets")!;
    const stats = hist.find((s) => s.route === "GET /api/stats")!;

    expect(markets.count).toBe(2);
    expect(markets.sum).toBeCloseTo(100);
    expect(stats.count).toBe(1);
    expect(stats.sum).toBeCloseTo(100);
  });
});

// ---------------------------------------------------------------------------
// resetHistogram
// ---------------------------------------------------------------------------
describe("resetHistogram", () => {
  it("clears all entries", () => {
    observe("GET", "/api/markets", 10);
    resetHistogram();
    expect(getHistogram()).toEqual([]);
    expect(getSnapshot("GET", "/api/markets")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cumulativeCounts
// ---------------------------------------------------------------------------
describe("cumulativeCounts", () => {
  it("produces running totals from per-bucket counts", () => {
    expect(cumulativeCounts([0, 3, 1, 0, 2])).toEqual([0, 3, 4, 4, 6]);
  });

  it("handles all-zero input", () => {
    expect(cumulativeCounts([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("handles a single bucket", () => {
    expect(cumulativeCounts([7])).toEqual([7]);
  });
});

// ---------------------------------------------------------------------------
// Error counter API
// ---------------------------------------------------------------------------
describe("recordError + getErrorCount", () => {
  it("returns undefined when no errors have been recorded", () => {
    expect(getErrorCount("GET", "/api/markets")).toBeUndefined();
  });

  it("increments error count for a route", () => {
    recordError("GET", "/api/markets");
    expect(getErrorCount("GET", "/api/markets")).toBe(1);
  });

  it("accumulates multiple errors for the same route", () => {
    recordError("GET", "/api/markets");
    recordError("GET", "/api/markets");
    recordError("GET", "/api/markets");
    expect(getErrorCount("GET", "/api/markets")).toBe(3);
  });

  it("tracks separate error counts per route", () => {
    recordError("GET", "/api/markets");
    recordError("GET", "/api/markets/:id");
    recordError("GET", "/api/markets");

    expect(getErrorCount("GET", "/api/markets")).toBe(2);
    expect(getErrorCount("GET", "/api/markets/:id")).toBe(1);
  });

  it("tracks separate error counts per method", () => {
    recordError("GET", "/api/markets");
    recordError("POST", "/api/markets");

    expect(getErrorCount("GET", "/api/markets")).toBe(1);
    expect(getErrorCount("POST", "/api/markets")).toBe(1);
  });
});

describe("getErrorCounts", () => {
  it("returns an empty array when no errors have been recorded", () => {
    expect(getErrorCounts()).toEqual([]);
  });

  it("returns all routes with errors sorted alphabetically by label", () => {
    recordError("GET", "/api/markets");
    recordError("GET", "/api/leaderboard");
    recordError("GET", "/api/stats");

    const routes = getErrorCounts().map((s) => s.route);
    expect(routes).toEqual([
      "GET /api/leaderboard",
      "GET /api/markets",
      "GET /api/stats",
    ]);
  });

  it("includes correct error count for each route", () => {
    recordError("GET", "/api/markets");
    recordError("GET", "/api/markets");
    recordError("GET", "/api/stats");

    const errors = getErrorCounts();
    const markets = errors.find((s) => s.route === "GET /api/markets")!;
    const stats = errors.find((s) => s.route === "GET /api/stats")!;

    expect(markets.count).toBe(2);
    expect(stats.count).toBe(1);
  });

  it("snapshot is immutable (frozen)", () => {
    recordError("GET", "/api/markets");
    const snapshot = getErrorCounts()[0]!;
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

describe("resetErrorCounts", () => {
  it("clears all error entries", () => {
    recordError("GET", "/api/markets");
    resetErrorCounts();
    expect(getErrorCounts()).toEqual([]);
    expect(getErrorCount("GET", "/api/markets")).toBeUndefined();
  });
});

describe("business metrics", () => {
  it("derives business counters from indexed state with event-log preference for bets and volume", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            markets_created_total: "12",
            bets_placed_total: "34",
            volume_xlm_total: "456.7000000",
            markets_resolved_total: "5",
          },
        ],
      }),
    };

    await expect(getBusinessMetrics(db as any)).resolves.toEqual({
      marketsCreatedTotal: 12,
      betsPlacedTotal: 34,
      volumeXlmTotal: "456.7000000",
      marketsResolvedTotal: 5,
    });
  });

  it("serializes business counters in Prometheus text format", () => {
    expect(
      serializeBusinessMetrics({
        marketsCreatedTotal: 2,
        betsPlacedTotal: 9,
        volumeXlmTotal: "123.4500000",
        marketsResolvedTotal: 1,
      })
    ).toBe(
      [
        "# HELP markets_created_total Total number of indexed markets created.",
        "# TYPE markets_created_total counter",
        "markets_created_total 2",
        "# HELP bets_placed_total Total number of indexed bets placed.",
        "# TYPE bets_placed_total counter",
        "bets_placed_total 9",
        "# HELP volume_xlm_total Total indexed platform betting volume in XLM.",
        "# TYPE volume_xlm_total counter",
        "volume_xlm_total 123.4500000",
        "# HELP markets_resolved_total Total number of indexed markets resolved.",
        "# TYPE markets_resolved_total counter",
        "markets_resolved_total 1",
        "",
      ].join("\n")
    );
  });
});

describe("Prometheus serialization", () => {
  it("serializes the request-duration histogram in Prometheus format", () => {
    observe("GET", "/healthz", 42);

    expect(serializeHistogram()).toContain(
      'api_request_duration_ms_bucket{route="GET /healthz",le="50"} 1'
    );
    expect(serializeHistogram()).toContain(
      'api_request_duration_ms_count{route="GET /healthz"} 1'
    );
    expect(serializeHistogram()).toContain(
      'api_request_duration_ms_sum{route="GET /healthz"} 42'
    );
  });

  it("serializes 5xx error counters in Prometheus format", () => {
    recordError("GET", "/api/markets");
    recordError("GET", "/api/markets");

    expect(serializeErrorCounts()).toBe(
      [
        "# HELP api_errors_total Total number of 5xx API responses.",
        "# TYPE api_errors_total counter",
        'api_errors_total{route="GET /api/markets"} 2',
        "",
      ].join("\n")
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: registerMetricsHook wired into a real Fastify server
// ---------------------------------------------------------------------------
describe("registerMetricsHook (Fastify integration)", () => {
  let server: FastifyInstance;

  beforeEach(() => {
    resetHistogram();
    resetErrorCounts();
    server = buildServer({ corsOrigins: [] });
  });

  afterEach(async () => {
    await server.close();
    resetHistogram();
    resetErrorCounts();
  });

  it("records an observation after a real request to GET /healthz", async () => {
    await server.inject({ method: "GET", url: "/healthz" });

    const snap = getSnapshot("GET", "/healthz");
    expect(snap).not.toBeUndefined();
    expect(snap!.count).toBe(1);
    expect(snap!.sum).toBeGreaterThanOrEqual(0);
  });

  it("accumulates observations across multiple requests to the same route", async () => {
    await server.inject({ method: "GET", url: "/healthz" });
    await server.inject({ method: "GET", url: "/healthz" });
    await server.inject({ method: "GET", url: "/healthz" });

    const snap = getSnapshot("GET", "/healthz")!;
    expect(snap.count).toBe(3);
  });

  it("uses the route template, not the filled-in URL, for parameterised routes", async () => {
    // /api/markets/:id — the id 999 must not appear in the label.
    await server.inject({ method: "GET", url: "/api/markets/999" });

    const byTemplate = getSnapshot("GET", "/api/markets/:id");
    const byRaw = getSnapshot("GET", "/api/markets/999");

    expect(byTemplate).not.toBeUndefined();
    expect(byRaw).toBeUndefined();
  });

  it("records all routes independently without cross-contamination", async () => {
    await server.inject({ method: "GET", url: "/healthz" });
    await server.inject({ method: "GET", url: "/api/markets" });

    expect(getSnapshot("GET", "/healthz")!.count).toBe(1);
    expect(getSnapshot("GET", "/api/markets")!.count).toBe(1);
  });

  it("does not throw and still records a metric for a 404 request", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/this-route-does-not-exist",
    });
    expect(res.statusCode).toBe(404);

    // At least one entry must exist (the 404 handler path or raw url fallback).
    expect(getHistogram().length).toBeGreaterThan(0);
  });

  it("does not break existing endpoints — /healthz still returns 200 ok", async () => {
    const res = await server.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("does not record non-5xx responses as errors", async () => {
    await server.inject({ method: "GET", url: "/healthz" });

    const errorCount = getErrorCount("GET", "/healthz");
    expect(errorCount).toBeUndefined();
  });

  it("records 5xx errors when recordError is called directly", async () => {
    recordError("GET", "/api/test");
    recordError("GET", "/api/test");
    recordError("POST", "/api/test");

    expect(getErrorCount("GET", "/api/test")).toBe(2);
    expect(getErrorCount("POST", "/api/test")).toBe(1);
  });

  it("records 5xx errors via the Fastify hook when statusCode is 500-599", async () => {
    // Add a temporary route that returns a 500 error
    server.get("/test-500", async () => {
      throw new Error("Test 500 error");
    });

    const res = await server.inject({ method: "GET", url: "/test-500" });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.statusCode).toBeLessThan(600);

    const errorCount = getErrorCount("GET", "/test-500");
    expect(errorCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// registerMetricsHook can also be used with a bare Fastify instance
// ---------------------------------------------------------------------------
describe("registerMetricsHook (standalone)", () => {
  it("does not throw when called on a bare app that has no routes", async () => {
    const Fastify = (await import("fastify")).default;
    const app = Fastify({ logger: false });
    expect(() => registerMetricsHook(app)).not.toThrow();
    await app.close();
  });
});
