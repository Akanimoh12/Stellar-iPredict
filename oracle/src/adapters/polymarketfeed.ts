import { type FetchWithRetryOptions, fetchWithRetry } from "./httpRetry.js";
import { type AdapterOutcome, type DataAdapter, isPoliticsMarketParams, type Market } from "./index.js";

const POLYMARKET_API_URL = "https://api.polymarket.com/query";

interface PolymarketMarketResponse {
  data: {
    markets: Array<{
      id: string;
      question: string;
      outcome: string;
      status: string;
      resolution?: string;
    }>;
  };
}

export interface PolymarketFeedAdapterOptions extends FetchWithRetryOptions {
  /** Polymarket API key (if required for authentication) */
  apiKey?: string;
}

/**
 * Resolves politics markets from Polymarket's feed API.
 * `market.params` must satisfy `PoliticsMarketParams` (marketId/expectedOutcome).
 * 
 * This adapter queries Polymarket's market resolution data to determine if a
 * political market has resolved in favor of the expected outcome.
 */
export class PolymarketFeedAdapter implements DataAdapter {
  readonly id = "polymarketfeed";

  constructor(private readonly options: PolymarketFeedAdapterOptions = {}) {}

  supports(market: Market): boolean {
    return market.category === "politics" && isPoliticsMarketParams(market.params);
  }

  async fetchOutcome(market: Market): Promise<AdapterOutcome> {
    if (!isPoliticsMarketParams(market.params)) {
      throw new Error(`PolymarketFeedAdapter cannot resolve market ${market.id}: missing/invalid politics params`);
    }
    const { marketId, expectedOutcome } = market.params;

    const query = `
      query {
        markets(where: { id: "${marketId}" }) {
          id
          question
          outcome
          status
          resolution
        }
      }
    `;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (this.options.apiKey) {
      headers["Authorization"] = `Bearer ${this.options.apiKey}`;
    }

    const response = await fetchWithRetry(
      POLYMARKET_API_URL,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ query }),
      },
      this.options,
    );

    const body = (await response.json()) as PolymarketMarketResponse;

    if (!body.data?.markets || body.data.markets.length === 0) {
      throw new Error(`PolymarketFeedAdapter found no market with ID ${marketId}`);
    }

    const polymarketMarket = body.data.markets[0];

    if (polymarketMarket.status !== "resolved") {
      throw new Error(`PolymarketFeedAdapter: market ${marketId} is not yet resolved (status: ${polymarketMarket.status})`);
    }

    if (!polymarketMarket.resolution) {
      throw new Error(`PolymarketFeedAdapter: market ${marketId} is resolved but has no resolution value`);
    }

    // Normalize the resolution to match expected outcome (case-insensitive)
    const resolution = polymarketMarket.resolution.toLowerCase();
    const expected = expectedOutcome.toLowerCase();
    const outcome = resolution === expected;

    // Confidence is high if the market is officially resolved
    const confidence = 0.95;

    return { outcome, confidence, raw: body };
  }
}
