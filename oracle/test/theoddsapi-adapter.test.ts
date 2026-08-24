import { describe, expect, it, vi } from "vitest";
import { TheOddsApiAdapter } from "../src/adapters/theoddsapi.js";
import { resolveMarket } from "../src/adapters/resolve.js";
import type { Market } from "../src/adapters/index.js";
import POSTPONED_FIXTURE from "./fixtures/theoddsapi-postponed.json";

const ODDS_FIXTURE = [
  {
    id: "bda33adca828c09dc3cac3a856aef176",
    sport_key: "americanfootball_nfl",
    sport_title: "NFL",
    commence_time: "2021-09-10T00:20:00Z",
    home_team: "Tampa Bay Buccaneers",
    away_team: "Dallas Cowboys",
    bookmakers: [
      {
        key: "draftkings",
        title: "DraftKings",
        last_update: "2021-06-10T13:33:26Z",
        markets: [
          {
            key: "h2h",
            last_update: "2021-06-10T13:33:26Z",
            outcomes: [
              { name: "Dallas Cowboys", price: 2.4 },
              { name: "Tampa Bay Buccaneers", price: 1.57 },
            ],
          },
        ],
      },
    ],
  },
];

function createMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "market-1",
    category: "sports",
    params: {
      sportKey: "americanfootball_nfl",
      homeTeam: "Tampa Bay Buccaneers",
      awayTeam: "Dallas Cowboys",
      selectedTeam: "Tampa Bay Buccaneers",
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("TheOddsApiAdapter", () => {
  it("requires an apiKey to construct", () => {
    expect(() => new TheOddsApiAdapter({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("supports sports markets with valid params, not other categories", () => {
    const adapter = new TheOddsApiAdapter({ apiKey: "test-key" });
    expect(adapter.supports(createMarket())).toBe(true);
    expect(adapter.supports(createMarket({ category: "crypto" }))).toBe(false);
    expect(adapter.supports(createMarket({ params: { sportKey: "nfl" } }))).toBe(false);
  });

  it("maps the market params to an odds query and resolves when selected team is favored", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(ODDS_FIXTURE));
    const adapter = new TheOddsApiAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.outcome).toBe(true);
    expect(result.raw).toEqual(ODDS_FIXTURE);
  });

  it("resolves as false when the selected team is the underdog", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(ODDS_FIXTURE));
    const adapter = new TheOddsApiAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(
      createMarket({ params: { sportKey: "americanfootball_nfl", homeTeam: "Tampa Bay Buccaneers", awayTeam: "Dallas Cowboys", selectedTeam: "Dallas Cowboys" } }),
    );

    expect(result.outcome).toBe(false);
  });

  it("reports confidence based on implied probabilities", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(ODDS_FIXTURE));
    const adapter = new TheOddsApiAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(createMarket());

    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.confidence).toBeLessThan(1);
  });

  it("retries on a 429 rate limit and succeeds on a later attempt", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse(ODDS_FIXTURE));
    const adapter = new TheOddsApiAdapter({ apiKey: "test-key", fetchFn, retryBackoffMs: 1 });

    const result = await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe(true);
  });

  it("does not retry a 401 auth failure and throws immediately", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ msg: "Unauthorized" }, 401));
    const adapter = new TheOddsApiAdapter({ apiKey: "bad-key", fetchFn, retryBackoffMs: 1 });

    await expect(adapter.fetchOutcome(createMarket())).rejects.toThrow(/401/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws when no matching game is found in the response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse([]));
    const adapter = new TheOddsApiAdapter({ apiKey: "test-key", fetchFn });

    await expect(adapter.fetchOutcome(createMoonMarket())).rejects.toThrow(/no matching game/);

    function createMoonMarket(): Market {
      return createMarket({ params: { sportKey: "americanfootball_nfl", homeTeam: "Moon", awayTeam: "Mars", selectedTeam: "Moon" } });
    }
  });

  it("throws when params are missing/invalid", async () => {
    const adapter = new TheOddsApiAdapter({ apiKey: "test-key" });
    await expect(adapter.fetchOutcome(createMarket({ params: {} }))).rejects.toThrow(/missing\/invalid/);
  });

  it("passes the region option as a query parameter", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(ODDS_FIXTURE));
    const adapter = new TheOddsApiAdapter({ apiKey: "test-key", region: "uk", fetchFn });

    await adapter.fetchOutcome(createMarket());

    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("regions=uk"),
      expect.anything(),
    );
  });

  it("maps a postponed provider fixture to market cancellation", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(POSTPONED_FIXTURE));
    const adapter = new TheOddsApiAdapter({ apiKey: "test-key", fetchFn });
    const result = await resolveMarket(createMarket(), [adapter]);
    expect(result.status).toBe("cancelled");
    expect(result.sources[0].cancellationReason).toBe("postponed");
  });
});
