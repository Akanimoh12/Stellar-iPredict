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

function normalizeDate(value: string): string {
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(value);
  const dateTime =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  const calendarDate = dateOnly?.[1] ?? dateTime?.[1];
  const calendarDateValue = calendarDate ? new Date(`${calendarDate}T00:00:00.000Z`) : undefined;

  if (
    !calendarDate ||
    !calendarDateValue ||
    !Number.isFinite(calendarDateValue.getTime()) ||
    calendarDateValue.toISOString().slice(0, 10) !== calendarDate
  ) {
    throw new Error("Market query mapping date must be a valid ISO-8601 date or timezone-qualified date-time");
  }

  if (dateOnly) {
    return `${calendarDate}T00:00:00.000Z`;
  }

  if (
    !dateTime ||
    Number(dateTime[2]) > 23 ||
    Number(dateTime[3]) > 59 ||
    Number(dateTime[4]) > 59 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("Market query mapping date must be a valid ISO-8601 date or timezone-qualified date-time");
  }

  return new Date(value).toISOString();
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

  let date: string | undefined;
  if (input.date !== undefined) {
    if (typeof input.date !== "string") {
      throw new Error("Market query mapping date must be a valid ISO-8601 date or timezone-qualified date-time");
    }
    date = normalizeDate(input.date);
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
    date,
    source: input.source?.trim(),
  });
}
