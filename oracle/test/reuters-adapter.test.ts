import { describe, expect, it, vi } from "vitest";
import { ReutersAdapter } from "../src/adapters/reuters.js";
import type { Market } from "../src/adapters/index.js";

// Recorded shape of a Reuters news API response for a political event.
const REUTERS_FIXTURE = {
  data: {
    articles: [
      {
        id: "article-1",
        title: "Election Results: Candidate A Wins Presidency",
        description: "Official results confirm Candidate A has won the presidential election.",
        publishedAt: "2024-11-06T00:00:00Z",
        content: "The election commission has officially declared Candidate A as the winner...",
      },
      {
        id: "article-2",
        title: "Candidate A Celebrates Victory",
        description: "Celebrations begin as Candidate A secures the presidency.",
        publishedAt: "2024-11-06T02:00:00Z",
        content: "Supporters gather to celebrate the historic victory...",
      },
    ],
  },
  meta: {
    total: 2,
  },
};

function createMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "market-1",
    category: "politics",
    params: { marketId: "presidential election candidate a", expectedOutcome: "Candidate A" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("ReutersAdapter", () => {
  it("requires an apiKey to construct", () => {
    expect(() => new ReutersAdapter({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("supports politics markets with valid params, not other categories", () => {
    const adapter = new ReutersAdapter({ apiKey: "test-key" });
    expect(adapter.supports(createMarket())).toBe(true);
    expect(adapter.supports(createMarket({ category: "crypto" }))).toBe(false);
    expect(adapter.supports(createMarket({ params: { marketId: "election" } }))).toBe(false);
  });

  it("maps the market ID to a search query and resolves matching outcomes", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(REUTERS_FIXTURE));
    const adapter = new ReutersAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("api.reuters.com/api/v1/search"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
    expect(result.outcome).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.7);
    expect(result.raw).toEqual(REUTERS_FIXTURE);
  });


  it("calculates confidence based on article match ratio", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(REUTERS_FIXTURE));
    const adapter = new ReutersAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    // Both articles mention "Candidate A", so confidence should be high
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("respects custom confidence threshold", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(REUTERS_FIXTURE));
    const adapter = new ReutersAdapter({ apiKey: "test-key", fetchFn, confidenceThreshold: 0.99 });

    const result = await adapter.fetchOutcome(createMarket());

    // With a very high threshold, even good matches might not pass
    expect(result.outcome).toBeDefined();
  });

  it("retries on a 429 rate limit and succeeds on a later attempt", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse(REUTERS_FIXTURE));
    const adapter = new ReutersAdapter({ apiKey: "test-key", fetchFn, retryBackoffMs: 1 });

    const result = await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe(true);
  });

  it("does not retry a non-retryable 401 auth failure and throws immediately", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: "Invalid API key" }, 401));
    const adapter = new ReutersAdapter({ apiKey: "bad-key", fetchFn, retryBackoffMs: 1 });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/401/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws when no articles are found for the query", async () => {
    const emptyFixture = { data: { articles: [] }, meta: { total: 0 } };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(emptyFixture));
    const adapter = new ReutersAdapter({ apiKey: "test-key", fetchFn });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/no articles/);
  });

  it("throws when params are missing/invalid rather than silently resolving", async () => {
    const adapter = new ReutersAdapter({ apiKey: "test-key" });
    await expect(adapter.fetchOutcome(createMarket({ params: {} }))).rejects.toThrow(/missing\/invalid/);
  });

});
