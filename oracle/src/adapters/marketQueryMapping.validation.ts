import type {
  MarketQuery,
  MarketQueryMapping,
  MarketQueryMappingInput,
} from "./marketQueryMapping.types.js";

function cloneQuery(query: MarketQuery | undefined): MarketQuery | undefined {
  return query === undefined ? undefined : { ...query };
}

export function cloneMarketQueryMapping(mapping: MarketQueryMapping): MarketQueryMapping {
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

  if (
    input.asset !== undefined &&
    (typeof input.asset !== "string" || input.asset.trim().length === 0)
  ) {
    throw new Error("Market query mapping asset must be a non-empty string");
  }

  if (
    input.threshold !== undefined &&
    (typeof input.threshold !== "number" || !Number.isFinite(input.threshold))
  ) {
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

  if (
    input.date !== undefined &&
    (typeof input.date !== "string" || !isValidDate(input.date))
  ) {
    throw new Error("Market query mapping date must be a valid ISO-8601 date or date-time");
  }

  if (
    input.source !== undefined &&
    (typeof input.source !== "string" || input.source.trim().length === 0)
  ) {
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

  return cloneMarketQueryMapping({
    ...input,
    marketId: input.marketId.trim(),
    asset: input.asset?.trim(),
    source: input.source?.trim(),
  });
}
