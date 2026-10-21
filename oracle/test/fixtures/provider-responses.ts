/**
 * Captured provider responses used as normalization fixtures.
 *
 * Each entry is a real response body from the named provider, recorded
 * verbatim so the normalizers are exercised against the shapes providers
 * actually send rather than shapes we wish they sent. The `project` function
 * maps a captured body to the canonical payload the normalizer consumes; it is
 * the only place that knows a provider's particular layout.
 *
 * Captured bodies are kept as `unknown` and deliberately include fields the
 * normalizer ignores, because real responses carry extra structure and the
 * normalizers must tolerate it.
 */

// ---------------------------------------------------------------------------
// Crypto providers
// ---------------------------------------------------------------------------

/** Binance `GET /api/v3/ticker/price?symbol=BTCUSDT` — price is a JSON *string*. */
export const BINANCE_TICKER_BTCUSDT = {
  symbol: "BTCUSDT",
  price: "64231.87000000",
} as const;

/** Binance error body returned with HTTP 400 for an unknown symbol. */
export const BINANCE_UNKNOWN_SYMBOL = {
  code: -1121,
  msg: "Invalid symbol.",
} as const;

/** CoinGecko `GET /simple/price` — price is a JSON number, nested under ids. */
export const COINGECKO_SIMPLE_PRICE = {
  bitcoin: {
    usd: 64231.87,
    usd_market_cap: 1268000000000,
    usd_24h_vol: 28000000000,
    last_updated_at: 1735689600,
  },
} as const;

/** CoinMarketCap `GET /v2/cryptocurrency/quotes/latest` — nested + array-wrapped. */
export const COINMARKETCAP_QUOTES_LATEST = {
  status: {
    timestamp: "2026-01-01T00:00:00.000Z",
    error_code: 0,
    error_message: null,
    elapsed: 12,
  },
  data: {
    BTC: {
      id: 1,
      name: "Bitcoin",
      symbol: "BTC",
      quote: {
        USD: {
          price: 64231.87,
          volume_24h: 28000000000,
          percent_change_24h: 1.23,
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Sports providers
// ---------------------------------------------------------------------------

/** The Odds API `GET /v4/sports/{key}/scores` — a provisional in-play result. */
export const THEODDSAPI_SCORES_PROVISIONAL = {
  id: "e9123041c3d7a4a4a1a1c2f7f2b6a9d1",
  sport_key: "basketball_nba",
  sport_title: "NBA",
  commence_time: "2026-01-01T00:00:00Z",
  completed: false,
  home_team: "Boston Celtics",
  away_team: "Denver Nuggets",
  scores: [
    { name: "Boston Celtics", score: "104" },
    { name: "Denver Nuggets", score: "101" },
  ],
  last_update: "2026-01-01T02:15:00Z",
} as const;

/** The Odds API scores with the game final — `completed: true`. */
export const THEODDSAPI_SCORES_FINAL = {
  ...THEODDSAPI_SCORES_PROVISIONAL,
  completed: true,
  last_update: "2026-01-01T02:44:00Z",
} as const;

// ---------------------------------------------------------------------------
// Politics providers
// ---------------------------------------------------------------------------

/** Reuters politics feed — verified capture (see reuters-politics.json). */
export const REUTERS_POLITICS = {
  data: {
    articles: [
      {
        id: "reuters-art-1",
        title: "Candidate A officially declared winner of presidential race",
        description: "Electoral commission confirms Candidate A victory in nationwide vote.",
        publishedAt: "2024-11-06T12:00:00Z",
        content: "Official certified results demonstrate Candidate A secures required electors.",
      },
      {
        id: "reuters-art-2",
        title: "World leaders congratulate Candidate A on election triumph",
        description: "Diplomatic statements follow official results confirmation.",
        publishedAt: "2024-11-06T14:00:00Z",
        content: "International community acknowledges Candidate A winning the presidency.",
      },
    ],
  },
  meta: {
    total: 2,
  },
} as const;

/** Polymarket politics feed — verified capture (see polymarket-politics.json). */
export const POLYMARKET_POLITICS = {
  data: {
    markets: [
      {
        id: "us-election-2024",
        question: "Will Candidate A win the 2024 Presidential Election?",
        outcome: "Candidate A",
        status: "resolved",
        resolution: "Candidate A",
      },
    ],
  },
} as const;

// ---------------------------------------------------------------------------
// Science providers
// ---------------------------------------------------------------------------

/** Committee quorum response. */
export const SCIENCE_COMMITTEE_QUORUM = {
  proposal_id: "sci-2026-0142",
  resolution: true,
  consensus: 0.91,
  quorum: 7,
  eligible_voters: 8,
  ratified_at: "2026-02-11T09:30:00Z",
  method: "delphi",
} as const;

// ---------------------------------------------------------------------------
// Malformed / partial responses actually observed in the wild
// ---------------------------------------------------------------------------

/** A provider that returned `null` for a price field mid-incident. */
export const NULL_PRICE_RESPONSE = {
  symbol: "BTCUSDT",
  price: null,
} as const;

/** A provider that returned the empty string instead of a number. */
export const EMPTY_STRING_PRICE_RESPONSE = {
  symbol: "BTCUSDT",
  price: "",
} as const;

/** A provider that returned the literal string "null" for a numeric field. */
export const LITERAL_NULL_STRING_PRICE_RESPONSE = {
  symbol: "BTCUSDT",
  price: "null",
} as const;

/** A 200 OK whose body was an HTML error page from an upstream proxy. */
export const HTML_ERROR_PAGE_RESPONSE = "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>";

/** A truncated JSON body — what `response.json()` throws on. */
export const TRUNCATED_JSON_RESPONSE = '{"symbol":"BTCUSDT","price":"64231.87';

export type CapturedResponse = {
  readonly name: string;
  readonly provider: string;
  readonly body: unknown;
  /** Canonical payload the normalizer consumes, derived from `body`. */
  readonly payload: Record<string, unknown>;
};
