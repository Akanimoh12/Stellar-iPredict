/** Canonical market categories stored on-chain and in PostgreSQL. */
export const MARKET_CATEGORIES = [
  "Crypto",
  "Sports",
  "Politics",
  "Entertainment",
  "Science",
  "Other",
] as const;

export type MarketCategory = (typeof MARKET_CATEGORIES)[number];
export const FILTERABLE_MARKET_CATEGORIES = MARKET_CATEGORIES.filter(
  (category): category is Exclude<MarketCategory, "Other"> => category !== "Other",
);
export type FilterableMarketCategory = (typeof FILTERABLE_MARKET_CATEGORIES)[number];

/** Normalized category names used by off-chain data adapters. */
export const ADAPTER_MARKET_CATEGORIES = ["crypto", "sports", "politics", "science"] as const;
export type AdapterMarketCategory = (typeof ADAPTER_MARKET_CATEGORIES)[number];

export interface Market {
  id: number;
  question: string;
  image_url: string | null;
  category: MarketCategory;
  end_time: string;
  total_yes: string;
  total_no: string;
  resolved: boolean;
  outcome: boolean | null;
  cancelled: boolean;
  creator: string;
  bet_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface Bet {
  market_id: string;
  bettor: string;
  net_amount: string;
  gross_amount: string;
  is_yes: boolean;
  claimed: boolean;
  created_at: Date;
}

export const EVENT_TOPICS = {
  market: {
    created: ["mkt", "created"],
    resolved: ["mkt", "resolved"],
    cancelled: ["mkt", "cancelled"],
  },
  bet: { placed: ["bet", "placed"] },
  referral: {
    registered: ["referral", "registered"],
    reward: ["referral", "reward"],
  },
  oracle: {
    submitted: ["oracle", "submitted"],
    challenged: ["oracle", "challenged"],
    escalated: ["oracle", "escalated"],
    finalized: ["oracle", "finalized"],
  },
} as const;

export interface ContractEvent<T = unknown> {
  topics: readonly unknown[];
  data: T;
}
