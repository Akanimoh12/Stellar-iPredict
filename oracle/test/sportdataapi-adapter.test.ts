import { describe, expect, it, vi } from "vitest";
import { SportDataApiAdapter } from "../src/adapters/sportdataapi.js";
import type { Market } from "../src/adapters/index.js";

function createSportsMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "sports-market-1",
    category: "sports",
    params: {
      sportKey: "soccer_epl",
      homeTeam: "Arsenal",
      awayTeam: "Chelsea",
      selectedTeam: "Arsenal",
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const mockMatchFinishedHomeWin = {
  match_id: 101,
  status: "finished",
  status_code: 3,
  home_team: { team_id: 1, name: "Arsenal" },
  away_team: { team_id: 2, name: "Chelsea" },
  stats: { home_score: 2, away_score: 1 },
};

const mockMatchFinishedDraw = {
  match_id: 102,
  status: "finished",
  status_code: 3,
  home_team: { team_id: 1, name: "Arsenal" },
  away_team: { team_id: 2, name: "Chelsea" },
  stats: { home_score: 1, away_score: 1 },
};

const mockMatchPostponed = {
  match_id: 103,
  status: "postponed",
  status_code: 4,
  home_team: { team_id: 1, name: "Arsenal" },
  away_team: { team_id: 2, name: "Chelsea" },
};

const mockMatchCancelled = {
  match_id: 104,
  status: "cancelled",
  status_code: 5,
  home_team: { team_id: 1, name: "Arsenal" },
  away_team: { team_id: 2, name: "Chelsea" },
};

describe("SportDataApiAdapter", () => {
  it("requires an apiKey to construct", () => {
    expect(() => new SportDataApiAdapter({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("supports sports markets with valid params, not other categories", () => {
    const adapter = new SportDataApiAdapter({ apiKey: "test-key" });
    expect(adapter.supports(createSportsMarket())).toBe(true);
    expect(adapter.supports(createSportsMarket({ category: "crypto" }))).toBe(false);
    expect(adapter.supports(createSportsMarket({ params: { sportKey: "soccer_epl" } }))).toBe(false);
  });

  it("resolves a winning selection correctly", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [mockMatchFinishedHomeWin] }));
    const adapter = new SportDataApiAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(createSportsMarket());

    expect(result.outcome).toBe(true);
    expect(result.confidence).toBe(1.0);
    expect(result.cancellation).toBeUndefined();
  });

  it("resolves a losing selection correctly", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [mockMatchFinishedHomeWin] }));
    const adapter = new SportDataApiAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(
      createSportsMarket({ params: { sportKey: "soccer_epl", homeTeam: "Arsenal", awayTeam: "Chelsea", selectedTeam: "Chelsea" } }),
    );

    expect(result.outcome).toBe(false);
    expect(result.confidence).toBe(1.0);
  });

  it("handles draws correctly for team selections and draw selections", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [mockMatchFinishedDraw] }));
    const adapter = new SportDataApiAdapter({ apiKey: "test-key", fetchFn });

    // When selected team is Arsenal and match is draw, outcome is false
    const teamResult = await adapter.fetchOutcome(createSportsMarket());
    expect(teamResult.outcome).toBe(false);

    // When selected team is "draw", outcome is true
    const drawResult = await adapter.fetchOutcome(
      createSportsMarket({ params: { sportKey: "soccer_epl", homeTeam: "Arsenal", awayTeam: "Chelsea", selectedTeam: "draw" } }),
    );
    expect(drawResult.outcome).toBe(true);
  });

  it("handles postponed matches explicitly without assigning an outcome", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [mockMatchPostponed] }));
    const adapter = new SportDataApiAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(createSportsMarket());

    expect(result.cancellation?.reason).toBe("postponed");
  });

  it("handles cancelled matches explicitly", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [mockMatchCancelled] }));
    const adapter = new SportDataApiAdapter({ apiKey: "test-key", fetchFn });

    const result = await adapter.fetchOutcome(createSportsMarket());

    expect(result.cancellation?.reason).toBe("cancelled");
  });

  it("throws when no matching game is found", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const adapter = new SportDataApiAdapter({ apiKey: "test-key", fetchFn });

    await expect(adapter.fetchOutcome(createSportsMarket())).rejects.toThrow(/no matching game found/);
  });
});
