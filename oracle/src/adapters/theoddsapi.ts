import { type FetchWithRetryOptions, fetchWithRetry } from "./httpRetry.js";
import { type AdapterOutcome, type DataAdapter, type Market } from "./index.js";
import { probeHttp } from "./health.js";

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

interface OddsApiOutcome {
  name: string;
  price: number;
  point?: number;
}

interface OddsApiMarket {
  key: string;
  last_update: string;
  outcomes: OddsApiOutcome[];
}

interface OddsApiBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: OddsApiMarket[];
}

interface OddsApiEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
  status?: string;
  cancelled?: boolean;
  postponed?: boolean;
}

export interface TheOddsApiAdapterOptions extends FetchWithRetryOptions {
  apiKey: string;
  region?: string;
}

function isSportsMarketParams(params: Record<string, unknown>): boolean {
  return (
    typeof params.sportKey === "string" &&
    params.sportKey.length > 0 &&
    typeof params.homeTeam === "string" &&
    params.homeTeam.length > 0 &&
    typeof params.awayTeam === "string" &&
    params.awayTeam.length > 0 &&
    typeof params.selectedTeam === "string" &&
    params.selectedTeam.length > 0
  );
}

export class TheOddsApiAdapter implements DataAdapter {
  readonly id = "theoddsapi";

  constructor(private readonly options: TheOddsApiAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("TheOddsApiAdapter requires an apiKey");
    }
  }

  supports(market: Market): boolean {
    return market.category === "sports" && isSportsMarketParams(market.params);
  }

  checkHealth() {
    return probeHttp(`${ODDS_API_BASE}/sports?apiKey=${encodeURIComponent(this.options.apiKey)}`, { method: "GET" }, this.options);
  }

  async fetchOutcome(market: Market): Promise<AdapterOutcome> {
    if (!isSportsMarketParams(market.params)) {
      throw new Error(
        `TheOddsApiAdapter cannot resolve market ${market.id}: missing/invalid sports params`,
      );
    }

    const { sportKey, homeTeam, awayTeam, selectedTeam } = market.params as Record<string, string>;
    const region = this.options.region ?? "us";

    const url = `${ODDS_API_BASE}/sports/${encodeURIComponent(sportKey)}/odds?apiKey=${encodeURIComponent(this.options.apiKey)}&regions=${encodeURIComponent(region)}&markets=h2h&oddsFormat=decimal`;

    const response = await fetchWithRetry(url, { method: "GET" }, this.options);
    const events = (await response.json()) as OddsApiEvent[];

    const event = events.find(
      (e) =>
        e.home_team.toLowerCase() === homeTeam.toLowerCase() &&
        e.away_team.toLowerCase() === awayTeam.toLowerCase(),
    );

    if (!event) {
      throw new Error(
        `TheOddsApiAdapter: no matching game found for ${homeTeam} vs ${awayTeam} in ${sportKey}`,
      );
    }

    const status = event.status?.toLowerCase();
    if (event.cancelled || status === "cancelled" || status === "canceled") {
      return { outcome: false, confidence: 1, raw: events, cancellation: { reason: "cancelled" } };
    }
    if (event.postponed || status === "postponed") {
      return { outcome: false, confidence: 1, raw: events, cancellation: { reason: "postponed" } };
    }

    const bookmaker = event.bookmakers[0];
    if (!bookmaker) {
      throw new Error(
        `TheOddsApiAdapter: no bookmakers available for ${homeTeam} vs ${awayTeam}`,
      );
    }

    const h2hMarket = bookmaker.markets.find((m) => m.key === "h2h");
    if (!h2hMarket) {
      throw new Error(
        `TheOddsApiAdapter: no h2h market found for ${homeTeam} vs ${awayTeam}`,
      );
    }

    const selectedOutcome = h2hMarket.outcomes.find(
      (o) => o.name.toLowerCase() === selectedTeam.toLowerCase(),
    );
    const opponentOutcome = h2hMarket.outcomes.find(
      (o) =>
        o.name.toLowerCase() !== selectedTeam.toLowerCase() &&
        o.name.toLowerCase() !== "draw" &&
        (o.name.toLowerCase() === homeTeam.toLowerCase() ||
          o.name.toLowerCase() === awayTeam.toLowerCase()),
    );

    if (!selectedOutcome || !opponentOutcome) {
      throw new Error(
        `TheOddsApiAdapter: could not find outcome for ${selectedTeam} in ${homeTeam} vs ${awayTeam}`,
      );
    }

    const outcome = selectedOutcome.price < opponentOutcome.price;

    const impliedSelected = 1 / selectedOutcome.price;
    const impliedOpponent = 1 / opponentOutcome.price;
    const confidence =
      impliedSelected / (impliedSelected + impliedOpponent);

    return { outcome, confidence, raw: events };
  }
}
