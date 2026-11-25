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

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one. setUTCFullYear avoids
  // the Date constructor's special-case mapping of years 0-99 to 1900-1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

function assertCalendarDate(year: number, month: number, day: number): void {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error("date is not a valid calendar date; it must be timezone-qualified");
  }
}

/**
 * Normalises an ISO-8601 date or timezone-qualified date-time to UTC.
 *
 * A bare date is interpreted as UTC midnight, matching how providers index
 * historical data. A date-time without an explicit `Z`/offset is rejected
 * rather than guessed from the host timezone: the same mapping must resolve to
 * the same instant on every machine.
 */
function normalizeDate(value: string): string {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    assertCalendarDate(year, month, day);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    return date.toISOString();
  }

  const dateTime = DATE_TIME.exec(value);
  if (!dateTime) {
    throw new Error(
      "date must be an ISO-8601 date or a timezone-qualified date-time",
    );
  }

  const year = Number(dateTime[1]);
  const month = Number(dateTime[2]);
  const day = Number(dateTime[3]);
  const hour = Number(dateTime[4]);
  const minute = Number(dateTime[5]);
  const second = dateTime[6] === undefined ? 0 : Number(dateTime[6]);
  assertCalendarDate(year, month, day);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error("date-time is outside the valid clock range; it must be timezone-qualified");
  }

  const offset = dateTime[8];
  if (offset !== "Z") {
    const [offsetHours, offsetMinutes] = offset.slice(1).split(":").map(Number);
    if (offsetHours > 23 || offsetMinutes > 59) {
      throw new Error("date-time has an invalid UTC offset; it must be timezone-qualified");
    }
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("date is not a valid timezone-qualified ISO-8601 date-time");
  }
  return parsed.toISOString();
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

  let normalizedDate: string | undefined;
  if (input.date !== undefined) {
    if (typeof input.date !== "string") {
      throw new Error("Market query mapping date must be a string");
    }
    normalizedDate = normalizeDate(input.date);
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
    date: normalizedDate,
    source: input.source?.trim(),
  });
}
