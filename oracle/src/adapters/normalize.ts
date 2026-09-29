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
 * The `normalizeOutcome` export is the primary entry point.  Individual
 * category normalizers are also exported for unit-testing.
 */

import type { MarketCategory } from "./index.js";

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
  price: number;
  threshold: number;
  /** Direction of the threshold comparison. */
  comparator: "gte" | "lte";
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
 */
export function normalizeCrypto(raw: CryptoRawPayload): NormalizedOutcome {
  const { price, threshold, comparator } = raw;

  if (!Number.isFinite(price) || !Number.isFinite(threshold) || threshold === 0) {
    return { outcome: false, confidence: 0 };
  }

  const outcome = comparator === "gte" ? price >= threshold : price <= threshold;

  // Relative distance from the decision boundary, clamped to [0, 1].
  const distance = Math.abs(price - threshold) / Math.abs(threshold);
  const normalized = Math.min(distance / CRYPTO_FULL_CONFIDENCE_DISTANCE, 1);

  // Map to [0.5, 1.0]: at boundary → 0.5, at full distance → 1.0.
  const confidence = normalized * 0.5 + 0.5;

  return { outcome, confidence };
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
}

/** Confidence applied when the result is provisional / in-progress. */
const SPORTS_PROVISIONAL_CONFIDENCE = 0.7;

/**
 * Normalize a sports result.
 *
 * - Final result: confidence = 1.0 (or sourceConfidence if provided).
 * - Provisional result: confidence = 0.7 (or SPORTS_PROVISIONAL_CONFIDENCE *
 *   sourceConfidence if provided).
 */
export function normalizeSports(raw: SportsRawPayload): NormalizedOutcome {
  const baseConfidence = raw.final ? 1.0 : SPORTS_PROVISIONAL_CONFIDENCE;
  const sourceMultiplier =
    raw.sourceConfidence !== undefined
      ? Math.max(0, Math.min(1, raw.sourceConfidence))
      : 1.0;
  const confidence = Math.max(0, Math.min(1, baseConfidence * sourceMultiplier));
  return { outcome: raw.outcome, confidence };
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
}

/**
 * Normalize a politics result.
 *
 * Confidence equals the consensus fraction directly, clamped to [0, 1].
 * A consensus fraction at or below 0.5 yields a confidence of 0 (no clear
 * majority), which callers should treat as unresolvable.
 */
export function normalizePolitics(raw: PoliticsRawPayload): NormalizedOutcome {
  const confidence = Math.max(0, Math.min(1, raw.consensusFraction));
  return { outcome: raw.outcome, confidence };
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
}

/**
 * Normalize a science result.
 *
 * The committee confidence is passed through as-is, clamped to [0, 1].
 */
export function normalizeScience(raw: ScienceRawPayload): NormalizedOutcome {
  const confidence = Math.max(0, Math.min(1, raw.confidence));
  return { outcome: raw.outcome, confidence };
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
      throw new Error(`Unknown market category: ${String((_exhaustive as { category: MarketCategory }).category)}`);
    }
  }
}
