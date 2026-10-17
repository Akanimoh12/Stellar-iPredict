import { type FetchWithRetryOptions, fetchWithRetry } from "./httpRetry.js";
import { AdapterResponseCache, marketCacheKey } from "./responseCache.js";
import { type AdapterOutcome, type DataAdapter, isSportsMarketParams, type Market, type SportsMarketParams } from "./index.js";
import { ProviderRateLimiter, sharedProviderRateLimiter } from "./rateLimiter.js";
import { probeHttp } from "./health.js";

const SPORTDATAAPI_BASE = "https://sportdataapi.com/api/v1";

interface SportDataApiMatch {
  match_id: number | string;
  status: string; // e.g. "finished", "postponed", "cancelled", "notstarted", "inplay"
  status_code?: number;
  home_team: {
    team_id: number | string;
    name: string;
    short_code?: string;
  };
  away_team: {
    team_id: number | string;
    name: string;
    short_code?: string;
  };
  stats?: {
    home_score?: number;
    away_score?: number;
    ft_score?: string; // "2-1"
  };
}

interface SportDataApiResponse {
  data: SportDataApiMatch[] | Record<string, SportDataApiMatch>;
}

export interface SportDataApiAdapterOptions extends FetchWithRetryOptions {
  apiKey: string;
  rateLimiter?: ProviderRateLimiter;
}

export class SportDataApiAdapter implements DataAdapter {
  readonly id = "sportdataapi";
  private readonly responseCache: AdapterResponseCache<SportDataApiMatch[]>;
  private readonly rateLimiter: ProviderRateLimiter;

  constructor(private readonly options: SportDataApiAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("SportDataApiAdapter requires an apiKey");
    }
    this.rateLimiter = options.rateLimiter ?? sharedProviderRateLimiter;
    this.responseCache = new AdapterResponseCache(options.cacheTtlMs);
  }

  supports(market: Market): boolean {
    return market.category === "sports" && isSportsMarketParams(market.params);
  }

  checkHealth() {
    return probeHttp(`${SPORTDATAAPI_BASE}/status?apikey=${encodeURIComponent(this.options.apiKey)}`, { method: "GET" }, this.options);
  }

  async fetchOutcome(market: Market): Promise<AdapterOutcome> {
    if (!isSportsMarketParams(market.params)) {
      throw new Error(`SportDataApiAdapter cannot resolve market ${market.id}: missing/invalid sports params`);
    }

    const { sportKey, homeTeam, awayTeam, selectedTeam } = market.params as Record<string, string> & SportsMarketParams;

    const matches = await this.responseCache.getOrSet(marketCacheKey(market), async () => {
      await this.rateLimiter.acquire(this.id);
      const url = `${SPORTDATAAPI_BASE}/soccer/matches?apikey=${encodeURIComponent(this.options.apiKey)}&season_id=2000`;
      const response = await fetchWithRetry(url, { method: "GET" }, this.options);
      const body = (await response.json()) as SportDataApiResponse;

      let list: SportDataApiMatch[] = [];
      if (Array.isArray(body.data)) {
        list = body.data;
      } else if (body.data && typeof body.data === "object") {
        list = Object.values(body.data);
      }
      return list;
    });

    const match = matches.find(
      (m) =>
        (m.home_team.name.toLowerCase().includes(homeTeam.toLowerCase()) || homeTeam.toLowerCase().includes(m.home_team.name.toLowerCase())) &&
        (m.away_team.name.toLowerCase().includes(awayTeam.toLowerCase()) || awayTeam.toLowerCase().includes(m.away_team.name.toLowerCase())),
    );

    if (!match) {
      throw new Error(`SportDataApiAdapter: no matching game found for ${homeTeam} vs ${awayTeam} in ${sportKey}`);
    }

    const status = match.status.toLowerCase();
    if (status === "cancelled" || status === "canceled" || match.status_code === 5) {
      return { outcome: false, confidence: 1, raw: match, cancellation: { reason: "cancelled" } };
    }
    if (status === "postponed" || match.status_code === 4) {
      return { outcome: false, confidence: 1, raw: match, cancellation: { reason: "postponed" } };
    }

    if (status !== "finished" && status !== "ft" && match.status_code !== 3) {
      throw new Error(`SportDataApiAdapter: match ${homeTeam} vs ${awayTeam} is not finished (status: ${status})`);
    }

    const homeScore = match.stats?.home_score ?? 0;
    const awayScore = match.stats?.away_score ?? 0;

    let winnerName = "draw";
    if (homeScore > awayScore) {
      winnerName = homeTeam.toLowerCase();
    } else if (awayScore > homeScore) {
      winnerName = awayTeam.toLowerCase();
    }

    const normSelected = selectedTeam.toLowerCase();
    let outcome = false;

    if (normSelected === "draw" || normSelected === "tie") {
      outcome = winnerName === "draw";
    } else {
      outcome = winnerName.includes(normSelected) || normSelected.includes(winnerName);
    }

    return {
      outcome,
      confidence: 1.0,
      raw: match,
    };
  }
}
