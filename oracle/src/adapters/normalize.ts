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
 */

import { assessQuote, applyConfidenceCeiling, type FreshnessPolicy } from "./freshness.js";
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
  /**
   * Provider observation time for `price`, in epoch milliseconds. Omitted
   * when the provider stamps nothing — which normalizes to an
   * `untimestamped` quote capped below the resolution confidence floor, not
   * to an implicit "assume it is fresh".
   */
  observedAtMs?: number | null;
  /**
   * Freshness bounds to apply. When omitted the quote is **not** judged at
   * all — no cap, no assessment — so a caller with an observation time is
   * forced to say what to do with it rather than silently getting the
   * uncapped result. Use {@link DEFAULT_FRESHNESS_POLICY} for the standard
   * bounds.
   */
  freshness?: FreshnessPolicy;
  /**
   * Evaluation instant. Injectable so freshness behaviour is testable without
   * freezing the process clock. Defaults to `Date.now()`.
   */
  now?: number;
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
 * That distance score is then capped by quote freshness: a price that is
 * more than `staleAfterMs` old, or that arrived without a timestamp, cannot
 * be returned at full confidence no matter how far it sits from the
 * threshold. The `outcome` is still computed from the number the provider
 * sent — the market question is answered by the price, and freshness governs
 * how much the oracle is willing to stake on that answer, not whether the
 * answer exists.
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
