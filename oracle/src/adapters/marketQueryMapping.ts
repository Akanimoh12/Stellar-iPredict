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

const DEFAULT_MAX_MAPPINGS = 10_000;

function cloneQuery(query: MarketQuery | undefined): MarketQuery | undefined {
  return query === undefined ? undefined : { ...query };
}

function cloneMapping(mapping: MarketQueryMapping): MarketQueryMapping {
  return {
    ...mapping,
    query: cloneQuery(mapping.query),
  };
}

function isValidDate(value: string): boolean {
  return value.length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * Validates and normalizes a market mapping.
 *
 * The returned object is a defensive copy and can safely be retained by the
 * store or an adapter. Errors identify the offending field to make malformed
 * market definitions easy to diagnose before a provider request is made.
 */
export function validateMarketQueryMapping(input: MarketQueryMappingInput): MarketQueryMapping {
  if (input === null || typeof input !== "object") {
    throw new Error("Market query mapping must be an object");
  }

  if (typeof input.marketId !== "string" || input.marketId.trim().length === 0) {
    throw new Error("Market query mapping requires a non-empty marketId");
  }

  if (input.asset !== undefined && (typeof input.asset !== "string" || input.asset.trim().length === 0)) {
    throw new Error("Market query mapping asset must be a non-empty string");
  }

  if (input.threshold !== undefined && (typeof input.threshold !== "number" || !Number.isFinite(input.threshold))) {
    throw new Error("Market query mapping threshold must be a finite number");
  }

  if (
    input.comparator !== undefined &&
    input.comparator !== "gte" &&
    input.comparator !== "lte" &&
    input.comparator !== "eq"
  ) {
    throw new Error("Market query mapping comparator must be gte, lte, or eq");
  }

  if (input.date !== undefined && (typeof input.date !== "string" || !isValidDate(input.date))) {
    throw new Error("Market query mapping date must be a valid ISO-8601 date or date-time");
  }

  if (input.source !== undefined && (typeof input.source !== "string" || input.source.trim().length === 0)) {
    throw new Error("Market query mapping source must be a non-empty string");
  }

  if (input.query !== undefined) {
    if (typeof input.query !== "object" || input.query === null || Array.isArray(input.query)) {
      throw new Error("Market query mapping query must be an object");
    }

    for (const [key, value] of Object.entries(input.query)) {
      if (key.trim().length === 0) {
        throw new Error("Market query mapping query keys must be non-empty strings");
      }
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error(`Market query mapping query value for ${key} is not supported`);
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error(`Market query mapping query value for ${key} must be finite`);
      }
    }
  }

  return cloneMapping({
    ...input,
    marketId: input.marketId.trim(),
    asset: input.asset?.trim(),
    source: input.source?.trim(),
  });
}

/**
 * Bounded in-memory storage for market query mappings.
 *
 * Updating an existing market does not consume another quota slot. New
 * mappings are rejected once the configured limit is reached, preventing an
 * unbounded market feed from exhausting oracle process memory.
 */
export class MarketQueryMappingStore {
  private readonly mappings = new Map<string, MarketQueryMapping>();
  private readonly maxMappings: number;

  constructor(options: MarketQueryMappingStoreOptions = {}) {
    const maxMappings = options.maxMappings ?? DEFAULT_MAX_MAPPINGS;
    if (!Number.isInteger(maxMappings) || maxMappings <= 0) {
      throw new Error("maxMappings must be a positive integer");
    }
    this.maxMappings = maxMappings;
  }

  set(mapping: MarketQueryMappingInput): void {
    const normalized = validateMarketQueryMapping(mapping);
    const isUpdate = this.mappings.has(normalized.marketId);

    if (!isUpdate && this.mappings.size >= this.maxMappings) {
      throw new Error(`Market query mapping quota exceeded (${this.maxMappings})`);
    }

    this.mappings.set(normalized.marketId, normalized);
  }

  get(marketId: string): MarketQueryMapping | undefined {
    const mapping = this.mappings.get(marketId);
    return mapping === undefined ? undefined : cloneMapping(mapping);
  }

  has(marketId: string): boolean {
    return this.mappings.has(marketId);
  }

  delete(marketId: string): boolean {
    return this.mappings.delete(marketId);
  }

  clear(): void {
    this.mappings.clear();
  }

  get size(): number {
    return this.mappings.size;
  }

  list(): MarketQueryMapping[] {
    return Array.from(this.mappings.values(), cloneMapping);
  }

  toJSON(): MarketQueryMapping[] {
    return this.list();
  }
}

export const MarketQueryMappingRegistry = MarketQueryMappingStore;
