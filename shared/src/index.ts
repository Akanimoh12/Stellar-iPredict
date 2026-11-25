/**
 * Secrets source shared by every service — env-file today, Vault later.
 * See `secrets.ts` and `docs/SECRETS.md`.
 */
export * from "./secrets.js";
export * from "./wasm-integrity.js";

/**
 * The shared retry utility every service uses — one backoff curve, one jitter
 * policy and one type-based retryability rule. See `retry.ts`.
 */
export * from "./retry.js";

/**
 * Shared circuit breaker for out-of-process dependencies (issue #637) and
 * trend-based heap monitoring (issue #635). Both long-running services use
 * these implementations so behaviour and thresholds stay consistent.
 */
export * from "./circuitBreaker.js";
export * from "./heapMonitor.js";

/** Error hierarchy: transient / permanent / programming — issue #633. */
export * from "./errors.js";

/** One configuration pattern with one error shape — issue #631. */
export * from "./config.js";

/** The shared logger and its canonical field names — issue #630. */
export * from "./log.js";

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
