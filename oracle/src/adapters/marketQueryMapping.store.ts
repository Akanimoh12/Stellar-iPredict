import type {
  MarketQueryMapping,
  MarketQueryMappingInput,
  MarketQueryMappingStoreOptions,
} from "./marketQueryMapping.types.js";
import { cloneMarketQueryMapping, validateMarketQueryMapping } from "./marketQueryMapping.validation.js";

const DEFAULT_MAX_MAPPINGS = 10_000;

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
    return mapping === undefined ? undefined : cloneMarketQueryMapping(mapping);
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
    return Array.from(this.mappings.values(), cloneMarketQueryMapping);
  }

  toJSON(): MarketQueryMapping[] {
    return this.list();
  }
}

export const MarketQueryMappingRegistry = MarketQueryMappingStore;
