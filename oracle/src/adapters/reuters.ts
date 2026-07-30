import { type FetchWithRetryOptions, fetchWithRetry } from "./httpRetry.js";
import { type AdapterOutcome, type DataAdapter, isPoliticsMarketParams, type Market } from "./index.js";

const REUTERS_API_URL = "https://api.reuters.com/api/v1/search";

interface ReutersArticleResponse {
  data: {
    articles: Array<{
      id: string;
      title: string;
      description: string;
      publishedAt: string;
      content?: string;
    }>;
  };
  meta: {
    total: number;
  };
}

export interface ReutersAdapterOptions extends FetchWithRetryOptions {
  /** Reuters API key (required for authentication) */
  apiKey: string;
  /** Confidence threshold for keyword matching (0-1). Defaults to 0.7. */
  confidenceThreshold?: number;
}

/**
 * Resolves politics markets from Reuters news API.
 * `market.params` must satisfy `PoliticsMarketParams` (marketId/expectedOutcome).
 * 
 * This adapter searches Reuters news articles for confirmation of political events
 * and determines if the expected outcome has occurred based on news coverage.
 */
export class ReutersAdapter implements DataAdapter {
  readonly id = "reuters";

  constructor(private readonly options: ReutersAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("ReutersAdapter requires an apiKey");
    }
  }

  supports(market: Market): boolean {
    return market.category === "politics" && isPoliticsMarketParams(market.params);
  }

  async fetchOutcome(market: Market): Promise<AdapterOutcome> {
    if (!isPoliticsMarketParams(market.params)) {
      throw new Error(`ReutersAdapter cannot resolve market ${market.id}: missing/invalid politics params`);
    }
    const { marketId, expectedOutcome } = market.params;
    const confidenceThreshold = this.options.confidenceThreshold ?? 0.7;

    // Use marketId as search query - this should be a descriptive term or event name
    const searchQuery = encodeURIComponent(marketId);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Authorization": `Bearer ${this.options.apiKey}`,
    };

    const response = await fetchWithRetry(
      `${REUTERS_API_URL}?q=${searchQuery}&size=10`,
      {
        method: "GET",
        headers,
      },
      this.options,
    );

    const body = (await response.json()) as ReutersArticleResponse;

    if (!body.data?.articles || body.data.articles.length === 0) {
      throw new Error(`ReutersAdapter found no articles for query "${marketId}"`);
    }

    // Analyze articles for keywords related to expected outcome
    const keywords = expectedOutcome.toLowerCase().split(/\s+/);
    let matchCount = 0;
    let totalArticles = body.data.articles.length;

    for (const article of body.data.articles) {
      const articleText = `${article.title} ${article.description} ${article.content || ""}`.toLowerCase();
      
      // Check if any keyword appears in the article
      const hasMatch = keywords.some(keyword => articleText.includes(keyword));
      if (hasMatch) {
        matchCount++;
      }
    }

    // Calculate confidence based on article match ratio
    const matchRatio = totalArticles > 0 ? matchCount / totalArticles : 0;
    const confidence = Math.min(matchRatio * 1.2, 1); // Boost slightly but cap at 1

    // Determine outcome based on confidence threshold
    const outcome = confidence >= confidenceThreshold;

    return { outcome, confidence, raw: body };
  }
}
