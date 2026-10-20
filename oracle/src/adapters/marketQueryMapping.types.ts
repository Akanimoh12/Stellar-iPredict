export type MarketQueryComparator = "gte" | "lte" | "eq";

export type MarketQueryValue = string | number | boolean;

/**
 * Provider-specific query values associated with a market.
 *
 * Keeping these values separate from the adapter implementation allows the
 * same market definition to be consumed by multiple data providers without
 * duplicating market metadata.
 */
export type MarketQuery = Record<string, MarketQueryValue>;

/**
 * Normalized query mapping used by oracle data adapters.
 *
 * `marketId` is the storage key. The remaining fields describe the value an
 * adapter should query and how the returned value should be evaluated.
 */
export interface MarketQueryMapping {
  marketId: string;
  asset?: string;
  threshold?: number;
  comparator?: MarketQueryComparator;
  /** ISO-8601 date or date-time used as the observation date. */
  date?: string;
  source?: string;
  query?: MarketQuery;
}

export type MarketQueryMappingInput = MarketQueryMapping;

export interface MarketQueryMappingStoreOptions {
  /** Maximum number of distinct markets retained by the store. */
  maxMappings?: number;
}
