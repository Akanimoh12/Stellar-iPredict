import { describe, expect, it, vi } from "vitest";
import { PolymarketFeedAdapter } from "../src/adapters/polymarketfeed.js";
import type { Market } from "../src/adapters/index.js";

// Recorded shape of a Polymarket GraphQL API response for a resolved market.
const POLYMARKET_FIXTURE = {
  data: {
    markets: [
      {
        id: "market-123",
        question: "Will Bitcoin exceed $100,000 by end of 2024?",
        outcome: "YES",
        status: "resolved",
        resolution: "YES",
      },
    ],
  },
};

function createMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "market-1",
    category: "politics",
    params: { marketId: "market-123", expectedOutcome: "YES" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("PolymarketFeedAdapter", () => {
  it("supports politics markets with valid params, not other categories", () => {
    const adapter = new PolymarketFeedAdapter();
    expect(adapter.supports(createMarket())).toBe(true);
    expect(adapter.supports(createMarket({ category: "crypto" }))).toBe(false);
    expect(adapter.supports(createMarket({ params: { marketId: "market-123" } }))).toBe(false);
  });

  it("maps the market ID to a GraphQL query and resolves matching outcomes", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(POLYMARKET_FIXTURE));
    const adapter = new PolymarketFeedAdapter({ fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.polymarket.com/query",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(0.95);
    expect(result.raw).toEqual(POLYMARKET_FIXTURE);
  });

  it("resolves as false when expected outcome does not match resolution", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(POLYMARKET_FIXTURE));
    const adapter = new PolymarketFeedAdapter({ fetchFn });

    const result = await adapter.fetchOutcome(
      createMarket({ params: { marketId: "market-123", expectedOutcome: "NO" } }),
    );

    expect(result.outcome).toBe(false);
  });

  it("performs case-insensitive comparison of expected outcome and resolution", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(POLYMARKET_FIXTURE));
    const adapter = new PolymarketFeedAdapter({ fetchFn });

    const result = await adapter.fetchOutcome(
      createMarket({ params: { marketId: "market-123", expectedOutcome: "yes" } }),
    );

    expect(result.outcome).toBe(true);
  });

  it("includes API key header when provided", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(POLYMARKET_FIXTURE));
    const adapter = new PolymarketFeedAdapter({ fetchFn, apiKey: "test-key" });

    await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
  });

  it("retries on a 429 rate limit and succeeds on a later attempt", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse(POLYMARKET_FIXTURE));
    const adapter = new PolymarketFeedAdapter({ fetchFn, retryBackoffMs: 1 });

    const result = await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe(true);
  });

  it("does not retry a non-retryable 400 and throws immediately", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: "Invalid query" }, 400));
    const adapter = new PolymarketFeedAdapter({ fetchFn, retryBackoffMs: 1 });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/400/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws when the market is not yet resolved", async () => {
    const unresolvedFixture = {
      data: {
        markets: [
          {
            id: "market-123",
            question: "Will Bitcoin exceed $100,000?",
            outcome: null,
            status: "open",
          },
        ],
      },
    };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(unresolvedFixture));
    const adapter = new PolymarketFeedAdapter({ fetchFn });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/not yet resolved/);
  });

  it("throws when the market is resolved but has no resolution value", async () => {
    const noResolutionFixture = {
      data: {
        markets: [
          {
            id: "market-123",
            question: "Will Bitcoin exceed $100,000?",
            outcome: null,
            status: "resolved",
          },
        ],
      },
    };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(noResolutionFixture));
    const adapter = new PolymarketFeedAdapter({ fetchFn });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/no resolution value/);
  });

  it("throws when no market is found with the given ID", async () => {
    const emptyFixture = { data: { markets: [] } };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(emptyFixture));
    const adapter = new PolymarketFeedAdapter({ fetchFn });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/no market with ID/);
  });

  it("throws when params are missing/invalid rather than silently resolving", async () => {
    const adapter = new PolymarketFeedAdapter();
    await expect(adapter.fetchOutcome(createMarket({ params: {} }))).rejects.toThrow(/missing\/invalid/);
  });
});
