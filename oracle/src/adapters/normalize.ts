/**
 * Outcome normalization + confidence model  (#170)
 *
 * Turns raw adapter payloads into a canonical `{ outcome, confidence }` pair.
 * Confidence is always in [0, 1].  Each category applies a documented mapping:
 *
 * | Category  | Signal                                    | Confidence formula                     |
 * |-----------|-------------------------------------------|----------------------------------------|
 * | crypto    | |price - threshold| / threshold          | clamp(1 - distance/0.05, 0.5, 1)       |
 * | sports    | Official score finality flag              | 1.0 if final, 0.7 if provisional       |
 * | politics  | Source consensus fraction                 | consensusFraction                      |
 * | science   | Committee confidence value (0-1)          | passthrough, clamp to [0, 1]           |
 *
 * ## Freshness (issue #744)
 *
 * Distance-from-threshold says how *marginal* a result is; it says nothing
 * about how *old* the underlying quote is. A price frozen an hour ago can sit
 * far from the threshold and score a confident 1.0, so the crypto normalizer
 * can also be given the provider's observation time and a
 * {@link FreshnessPolicy}. The ceiling that policy implies then caps the
 * result, which is what keeps a stale or untimestamped quote out of a
 * full-confidence resolution.
 *
 * Freshness is opt-in here: `normalizeCrypto` applies the cap only when the
 * payload carries a `freshness` policy. The existing distance-only model is
 * unchanged for callers with no timestamp to check, and a caller that has
 * one is forced to say what to do with it rather than silently getting the
 * uncapped result.
 *
 * The `normalizeOutcome` export is the primary entry point.  Individual
 * category normalizers are also exported for unit-testing.
 *
 * ## Failure policy: explicit, never silent
 *
 * A provider payload that cannot be understood raises a
 * {@link NormalizationError} (an `AdapterError` of kind `"data"`).  It is
 * never coerced into a plausible-looking value.
 *
 * This distinction is the whole point of the module.  The tempting fallback —
 * "price was `null`, so treat it as `0`" or "confidence was missing, so use
 * `0`" — produces a *confident, completely wrong* resolution: a `0` price
 * resolves a `price >= 60000` market to `false` with real confidence attached,
 * and nothing downstream can tell that apart from a genuine reading.  A thrown
 * error instead marks the source as failed (see `fetchSource` in resolve.ts),
 * which excludes it from the tally and surfaces the problem for review.
 *
 * The rule applied throughout:
 *
 * - **Wrong type, `null`, `undefined`/`NaN`, or missing → throw.** The value
 *   cannot be interpreted, so no outcome may be derived from it.
 * - **Out of range but numeric → clamp.** `confidence: 1.5` is a real number
 *   from a source with a loose scale; clamping is a defined, reversible
 *   interpretation, not a guess.
 */

import { AdapterError } from "./errors.js";
import { applyConfidenceCeiling, assessQuote, type FreshnessPolicy } from "./freshness.js";

/**
 * A provider response that could not be normalized.
 *
 * Carries the offending `field` and the value actually received so the cause
 * is diagnosable from a log line, while `kind: "data"` marks it as
 * non-retryable — a malformed payload will be malformed on the next attempt
 * too, so retrying only burns provider quota.
 */
export class NormalizationError extends AdapterError {
  constructor(
    source: string,
    /** Dotted path of the field that failed, e.g. `"price"`. */
    readonly field: string,
    /** The value received, for diagnosis. Never trusted. */
    readonly received: unknown,
    detail: string,
  ) {
    super(source, "data", `Invalid ${field} in ${source} response: ${detail}`);
    this.name = "NormalizationError";
  }
}

/** Label used in errors when the caller did not identify the provider. */
const UNKNOWN_SOURCE = "unknown-provider";

function sourceOf(payload: { provider?: string }): string {
  return payload.provider ?? UNKNOWN_SOURCE;
}

/** Describes a value for an error message without dumping anything large. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `string ${JSON.stringify(value.slice(0, 32))}`;
  if (typeof value === "number") return `number ${String(value)}`;
  if (Array.isArray(value)) return `array(length ${value.length})`;
  if (typeof value === "object") return `object(${Object.keys(value as object).join(", ")})`;
  return typeof value;
}

/**
 * Requires a finite number.
 *
 * Rejects `null`, `undefined`, `NaN`, `±Infinity` and non-numeric types.
 * `NaN` matters as much as `null` here: `null` is visibly absent, whereas
 * `NaN` sails through a naive `typeof x === "number"` check and then poisons
 * every comparison it reaches.
 */
function requireFiniteNumber(value: unknown, field: string, source: string): number {
  if (value === null || value === undefined) {
    throw new NormalizationError(source, field, value, "required number is missing");
  }
  if (typeof value !== "number") {
    throw new NormalizationError(source, field, value, `expected number, received ${describe(value)}`);
  }
  if (!Number.isFinite(value)) {
    throw new NormalizationError(source, field, value, `expected finite number, received ${String(value)}`);
  }
  return value;
}

/**
 * Requires an actual boolean.
 *
 * Deliberately strict: providers that encode booleans as `"true"`/`1` are a
 * real integration bug, and quietly reading them as `true` would invert a
 * resolution.
 */
function requireBoolean(value: unknown, field: string, source: string): boolean {
  if (typeof value !== "boolean") {
    throw new NormalizationError(source, field, value, `expected boolean, received ${describe(value)}`);
  }
  return value;
}

/** Clamps a finite number into [0, 1]; the caller has already proven it finite. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}


// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** The canonical output of any normalization step. */
export interface NormalizedOutcome {
  /** Boolean resolution of the market question. */
  outcome: boolean;
  /**
   * Confidence in [0, 1].
   * - 1.0 = absolute certainty (e.g. large price margin, finalized score)
   * - 0.5 = minimum accepted confidence floor
   * - 0.0 = no usable data (callers should treat as unresolvable)
   */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Crypto normalization
// ---------------------------------------------------------------------------

/**
 * Raw fields expected from a crypto price adapter (Binance, CoinMarketCap, …).
 * Only `price`, `threshold`, and `comparator` are required; everything else is
 * forwarded as-is to the audit trail.
 */
export interface CryptoRawPayload {
  observedAtMs?: number | null;
  freshness?: FreshnessPolicy;
  now?: number;
  price: number;
  threshold: number;
  /** Direction of the threshold comparison. */
  comparator: "gte" | "lte";
  /** Provider id, used only to attribute errors. */
  provider?: string;
}

/**
 * Maximum relative distance (fraction of threshold) at which confidence
 * reaches its floor of 0.5.  A price exactly at the threshold yields 0.5;
 * a price 5% or more away from the threshold yields 1.0.
 */
const CRYPTO_FULL_CONFIDENCE_DISTANCE = 0.05;

/**
 * Normalize a crypto price result.
 *
 * Confidence reflects how far the price is from the threshold relative to
 * the threshold itself.  A price hugging the boundary is less certain (market
 * data noise could flip the result) while a price deep in either direction
 * warrants high confidence.
 *
 * confidence = clamp(distance / CRYPTO_FULL_CONFIDENCE_DISTANCE, 0, 1) * 0.5 + 0.5
 *   where distance = |price - threshold| / threshold
 *
 * @throws {NormalizationError} if `price` or `threshold` is missing,
 *   non-numeric or non-finite, if `threshold` is zero (the confidence
 *   distance divides by it), or if `comparator` is not `gte`/`lte`.
 */
export function normalizeCrypto(raw: CryptoRawPayload): NormalizedOutcome {
  const source = sourceOf(raw);
  // Read defensively: at runtime `raw` is whatever the provider's JSON parsed
  // to, so a field the type says is `number` can be absent, null or a string.
  const payload = raw as unknown as Record<string, unknown>;

  const price = requireFiniteNumber(payload.price, "price", source);
  const threshold = requireFiniteNumber(payload.threshold, "threshold", source);

  const comparator = payload.comparator;
  if (comparator !== "gte" && comparator !== "lte") {
    throw new NormalizationError(
      source,
      "comparator",
      comparator,
      `expected "gte" or "lte", received ${describe(comparator)}`,
    );
  }

  if (threshold === 0) {
    // A zero threshold makes the relative distance a division by zero, so
    // confidence is undefined. Refuse rather than emit NaN or guess a scale.
    throw new NormalizationError(source, "threshold", threshold, "must be non-zero to compute confidence");
  }

  const outcome = comparator === "gte" ? price >= threshold : price <= threshold;

  // Relative distance from the decision boundary, clamped to [0, 1].
  const distance = Math.abs(price - threshold) / Math.abs(threshold);
  const normalized = Math.min(distance / CRYPTO_FULL_CONFIDENCE_DISTANCE, 1);

  // Map to [0.5, 1.0]: at boundary → 0.5, at full distance → 1.0.
  const confidence = normalized * 0.5 + 0.5;

  // Opt-in freshness gate. Absent a policy there is no observation time to
  // judge, so the distance score stands unchanged.
  if (!raw.freshness) {
    return { outcome, confidence };
  }

  const freshness = assessQuote(raw.observedAtMs ?? null, raw.freshness, raw.now);
  return { outcome, confidence: applyConfidenceCeiling(confidence, freshness) };
}

/** Input for the shared price-adapter path used by Binance/CMC/CoinGecko. */
export interface CryptoQuoteInput {
  price: number;
  threshold: number;
  comparator: "gte" | "lte";
  /** Provider observation time in epoch ms, or `null` when the provider sent none. */
  observedAtMs?: number | null;
  /** Freshness bounds. Omit to skip the cap entirely. */
  freshness?: FreshnessPolicy;
  /** Evaluation instant; injectable for tests. Defaults to `Date.now()`. */
  now?: number;
  /**
   * Confidence before the freshness cap. Defaults to 1.
   *
   * Price adapters pass the implicit default: comparing a quoted price to a
   * threshold is not a marginal call, and re-scoring it by distance would make
   * near-threshold markets fall below the resolution confidence floor for a
   * reason unrelated to the data's quality. What *can* make it marginal is the
   * quote being old, which is what the cap handles.
   */
  baseConfidence?: number;
}

/**
 * The one path every price adapter uses to turn a quote into an outcome.
 *
 * Composes the threshold comparison with the freshness ceiling:
 *
 *   * a fresh, timestamped quote reports `baseConfidence` unchanged;
 *   * a stale quote is capped at the policy's `staleConfidence`;
 *   * an untimestamped quote is capped at `untimestampedConfidence`;
 *   * an expired quote is capped at 0 — adapters reject it outright by
 *     throwing {@link StaleQuoteError} rather than returning this.
 */
export function normalizeCryptoQuote(input: CryptoQuoteInput): NormalizedOutcome {
  const { price, threshold, comparator, observedAtMs, freshness, now } = input;
  const base = input.baseConfidence ?? 1;

  if (!Number.isFinite(price) || !Number.isFinite(threshold)) {
    return { outcome: false, confidence: 0 };
  }

  const outcome = comparator === "gte" ? price >= threshold : price <= threshold;

  if (!freshness) {
    return { outcome, confidence: Math.max(0, Math.min(1, base)) };
  }

  const quote = assessQuote(observedAtMs ?? null, freshness, now);
  return { outcome, confidence: applyConfidenceCeiling(base, quote) };
}

// ---------------------------------------------------------------------------
// Sports normalization
// ---------------------------------------------------------------------------

/**
 * Raw fields from a sports data adapter.
 *
 * `final` indicates whether the result is official (full-time / certified).
 * When false (in-progress or provisional) confidence is downgraded.
 */
export interface SportsRawPayload {
  /** Whether the event outcome is officially final. */
  final: boolean;
  /** The resolved boolean question (e.g. "Did team A win?"). */
  outcome: boolean;
  /**
   * Optional 0-1 confidence from the source itself (e.g. live-odds model).
   * When present it is used as a multiplier on the base confidence.
   */
  sourceConfidence?: number;
  /** Provider id, used only to attribute errors. */
  provider?: string;
}

/** Confidence applied when the result is provisional / in-progress. */
const SPORTS_PROVISIONAL_CONFIDENCE = 0.7;

/**
 * Normalize a sports result.
 *
 * - Final result: confidence = 1.0 (or sourceConfidence if provided).
 * - Provisional result: confidence = 0.7 (or SPORTS_PROVISIONAL_CONFIDENCE *
 *   sourceConfidence if provided).
 *
 * @throws {NormalizationError} if `final` or `outcome` is not a boolean, or if
 *   `sourceConfidence` is present but not a finite number.
 */
export function normalizeSports(raw: SportsRawPayload): NormalizedOutcome {
  const source = sourceOf(raw);
  const payload = raw as unknown as Record<string, unknown>;

  // `final` is the signal the whole category hinges on: a provisional result
  // reported as final would resolve the market early with full confidence.
  const isFinal = requireBoolean(payload.final, "final", source);
  const outcome = requireBoolean(payload.outcome, "outcome", source);

  const baseConfidence = isFinal ? 1.0 : SPORTS_PROVISIONAL_CONFIDENCE;

  // `sourceConfidence` is optional, so absent is legitimate; present-but-broken
  // is not — a null here must not silently mean "no adjustment".
  const sourceMultiplier =
    payload.sourceConfidence === undefined
      ? 1.0
      : clamp01(requireFiniteNumber(payload.sourceConfidence, "sourceConfidence", source));

  const confidence = clamp01(baseConfidence * sourceMultiplier);
  return { outcome, confidence };
}

// ---------------------------------------------------------------------------
// Politics normalization
// ---------------------------------------------------------------------------

/**
 * Raw fields from a politics / prediction-market adapter.
 *
 * Multiple independent sources may report the same market.  Confidence is
 * derived from the fraction of sources that agree with the majority outcome.
 */
export interface PoliticsRawPayload {
  /** Resolved boolean outcome. */
  outcome: boolean;
  /**
   * Fraction of sources that agree on this outcome, in [0, 1].
   * 1.0 means all sources agree; 0.5 means a perfect tie (not usable).
   */
  consensusFraction: number;
  /** Provider id, used only to attribute errors. */
  provider?: string;
}

/**
 * Normalize a politics result.
 *
 * Confidence equals the consensus fraction directly, clamped to [0, 1].
 * A consensus fraction at or below 0.5 yields a confidence of 0 (no clear
 * majority), which callers should treat as unresolvable.
 *
 * @throws {NormalizationError} if `consensusFraction` is missing, non-numeric
 *   or non-finite, or if `outcome` is not a boolean.
 */
export function normalizePolitics(raw: PoliticsRawPayload): NormalizedOutcome {
  const source = sourceOf(raw);
  const payload = raw as unknown as Record<string, unknown>;

  const outcome = requireBoolean(payload.outcome, "outcome", source);
  // A missing consensus fraction must not read as 0.5 (a tie) or 0 (no
  // consensus) — both produce a usable-looking number from no data at all.
  const consensusFraction = requireFiniteNumber(payload.consensusFraction, "consensusFraction", source);

  return { outcome, confidence: clamp01(consensusFraction) };
}

// ---------------------------------------------------------------------------
// Science normalization
// ---------------------------------------------------------------------------

/**
 * Raw fields from a science / committee adapter.
 *
 * The committee produces an outcome and an explicit confidence value.
 */
export interface ScienceRawPayload {
  /** Resolved boolean outcome. */
  outcome: boolean;
  /**
   * Confidence from the committee or research publication, in [0, 1].
   * Values outside [0, 1] are clamped.
   */
  confidence: number;
  /** Provider id, used only to attribute errors. */
  provider?: string;
}

/**
 * Normalize a science result.
 *
 * The committee confidence is passed through as-is, clamped to [0, 1].
 *
 * @throws {NormalizationError} if `confidence` is missing, non-numeric or
 *   non-finite, or if `outcome` is not a boolean.
 */
export function normalizeScience(raw: ScienceRawPayload): NormalizedOutcome {
  const source = sourceOf(raw);
  const payload = raw as unknown as Record<string, unknown>;

  const outcome = requireBoolean(payload.outcome, "outcome", source);
  const confidence = requireFiniteNumber(payload.confidence, "confidence", source);

  return { outcome, confidence: clamp01(confidence) };
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

/**
 * Union of all category-specific raw payloads, discriminated by `category`.
 * Adapters pass their raw provider response together with the category so the
 * normalizer can apply the correct mapping.
 */
export type RawPayloadByCategory =
  | ({ category: "crypto" } & CryptoRawPayload)
  | ({ category: "sports" } & SportsRawPayload)
  | ({ category: "politics" } & PoliticsRawPayload)
  | ({ category: "science" } & ScienceRawPayload);

/**
 * Normalize a raw adapter payload to `{ outcome, confidence }`.
 *
 * This is the single entry point that every adapter should call before
 * returning an `AdapterOutcome`.  Applying it consistently ensures every
 * upstream consumer (resolveMarket, OffChainSubmitterService, …) receives
 * calibrated confidence scores rather than hard-coded `1` values.
 *
 * @param payload  Raw payload tagged with its `category`.
 * @returns        `{ outcome: boolean, confidence: number }` — confidence in [0, 1].
 * @throws {NormalizationError} for an unknown/absent `category`, or for any
 *   malformed field in the payload.
 *
 * @example
 * ```ts
 * const normalized = normalizeOutcome({
 *   category: "crypto",
 *   price: 65_000,
 *   threshold: 60_000,
 *   comparator: "gte",
 * });
 * // → { outcome: true, confidence: 1.0 }
 * ```
 */
export function normalizeOutcome(payload: RawPayloadByCategory): NormalizedOutcome {
  // Guard the shape before anything else. Without this, a null/undefined
  // payload surfaces as a raw TypeError from property access, which escapes
  // the adapter error taxonomy entirely and gets treated as a transient fault
  // (and retried) rather than as malformed data.
  if (payload === null || typeof payload !== "object") {
    throw new NormalizationError(
      UNKNOWN_SOURCE,
      "payload",
      payload,
      `expected an object, received ${describe(payload)}`,
    );
  }

  const source = sourceOf(payload as { provider?: string });

  // Dispatch on `payload.category` so TypeScript narrows the union for each
  // branch. An unrecognised or absent category is still possible at runtime
  // (the payload came from JSON), so the default branch re-reads the raw value
  // and reports it as a `data` error rather than escaping as an
  // uncategorised exception.
  switch (payload.category) {
    case "crypto":
      return normalizeCrypto(payload);
    case "sports":
      return normalizeSports(payload);
    case "politics":
      return normalizePolitics(payload);
    case "science":
      return normalizeScience(payload);
    default: {
      // Exhaustiveness check — TypeScript narrows `payload` to `never` here.
      const _exhaustive: never = payload;
      const category = (_exhaustive as { category?: unknown }).category;
      throw new NormalizationError(
        source,
        "category",
        category,
        `unknown market category ${describe(category)}`,
      );
    }
  }
}
