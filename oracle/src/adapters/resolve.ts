import { selectAdaptersForMarket, type DataAdapter, type Market, type MarketCategory } from "./index.js";
import { reviewItem, type ManualReviewQueue } from "./reviewQueue.js";
import { createProvenanceRecord, sanitizeProvenanceValue, type ProvenanceStore } from "./provenance.js";
import {
  type MappabilityOverride,
  type MappabilityVerdict,
  MarketMappabilityRegistry,
  validateMarketMappability,
  type UnmappableReason,
} from "./mappability.js";

export type ResolutionStatus = "resolved" | "conflict" | "unresolvable" | "review" | "cancelled";

/**
 * Why a resolution produced the outcome it did.
 *
 * Present on every result so a caller never has to infer intent from a status
 * code. `unmappable` is the case issue #745 is about: no adapter can ever
 * resolve this market, so retrying will not help and the market needs a
 * configuration change rather than time.
 */
export interface ResolutionReason {
  code:
    | "resolved"
    | "all-sources-failed"
    | "insufficient-agreement"
    | "conflicting-outcomes"
    | "inconclusive"
    | "low-confidence"
    | "cancelled"
    | "unmappable";
  detail?: string;
  /** Set when `code` is `unmappable`. */
  mappability?: MappabilityVerdict;
  /** Set when `code` is `unmappable`. */
  unmappableReason?: UnmappableReason;
}

export interface SourceResult {
  adapterId: string;
  outcome: boolean;
  confidence: number;
  error?: string;
  cancellationReason?: "postponed" | "cancelled";
  raw?: unknown;
  /**
   * Attributable fetch metadata (provider / request / response time) for the
   * payload in `raw`. Carried through to the audit trail so a persisted
   * payload is never anonymous.
   */
  provider?: string;
  request?: unknown;
  respondedAt?: string;
}

export interface ResolutionResult {
  status: ResolutionStatus;
  outcome?: boolean;
  confidence: number;
  sources: SourceResult[];
  /** Present on every result. */
  reason?: ResolutionReason;
}

/**
 * Durable sink for the raw provider payloads behind a resolution.
 *
 * Called once per resolution with every source consulted, so the payloads
 * outlive the process. `AdapterOutcome.raw` is otherwise in-memory only, which
 * leaves no evidence of what a provider actually returned if the resolution is
 * later disputed.
 *
 * Mirrors the existing `provenanceStore` hook: the caller supplies a store
 * bound to its own backend (see `createRawPayloadSink` in
 * `aggregator/council-audit.ts` for the Postgres-backed one).
 */
export type RawPayloadSink = (
  marketId: string,
  sources: readonly SourceResult[],
) => Promise<void>;

export interface ResolveOptions {
  /** Minimum number of sources that must agree for a resolution. Defaults to 1 (2 for politics). */
  minAgreement?: number;
  /** Maximum number of sources to query before deciding. Defaults to all available. */
  maxSources?: number;
  /** Fraction of dissenting votes (0–1) that triggers a conflict flag. Defaults to 0.3 (0.15 for politics). */
  conflictThreshold?: number;
  /** Resolutions below this confidence are held for review. Defaults to 0.7 (0.85 for politics). */
  minConfidence?: number;
  /**
   * Minimum confidence-weighted margin between the winning and losing side,
   * as a fraction of total weight (0-1). Below this the vote is too close to
   * call and is held for review. Defaults to 0.1.
   */
  minWeightedMargin?: number;
  reviewQueue?: ManualReviewQueue;
  /** Optional durable audit store. Every resolution decision is recorded when supplied. */
  provenanceStore?: ProvenanceStore;
  /** Optional durable store for the raw provider payloads behind the decision. */
  rawPayloadSink?: RawPayloadSink;
  /** Optional category-specific resolution configuration overrides. */
  categoryConfigs?: Partial<Record<MarketCategory, CategoryResolutionConfig>>;
  /**
   * Attach a mappability diagnosis when no adapter can resolve the market
   * (issue #745). Defaults to true; set false to skip the check.
   *
   * The check is cheap and does not touch the network, but it is opt-out so
   * a caller that has already validated mappability at creation time is not
   * paying for it on every resolution.
   */
  checkMappability?: boolean;
  /** Pre-built registry, so repeated resolutions do not rebuild it. */
  mappabilityRegistry?: MarketMappabilityRegistry;
  /** Operator overrides for mappability, from `MappabilityOverrides.load()`. */
  mappabilityOverrides?: MappabilityOverride;
}

/** Options carried through as-is, rather than defaulted per category. */
type PassedThroughOptions =
  | "reviewQueue"
  | "provenanceStore"
  | "categoryConfigs"
  | "checkMappability"
  | "mappabilityRegistry"
  | "mappabilityOverrides";

export interface CategoryResolutionConfig {
  minAgreement?: number;
  maxSources?: number;
  conflictThreshold?: number;
  minConfidence?: number;
}

export const DEFAULT_OPTIONS: Required<Omit<ResolveOptions, "reviewQueue" | "provenanceStore" | "rawPayloadSink" | "categoryConfigs">> = {
  minAgreement: 1,
  maxSources: Infinity,
  conflictThreshold: 0.3,
  minConfidence: 0.7,
  minWeightedMargin: 0.1,
};

/**
 * Category-specific default resolution configurations.
 * Political markets use conservative confidence gating (higher agreement, higher confidence threshold, lower conflict tolerance).
 */
export const DEFAULT_CATEGORY_CONFIG: Record<MarketCategory, Required<CategoryResolutionConfig>> = {
  crypto: {
    minAgreement: 1,
    maxSources: Infinity,
    conflictThreshold: 0.3,
    minConfidence: 0.7,
  },
  sports: {
    minAgreement: 1,
    maxSources: Infinity,
    conflictThreshold: 0.3,
    minConfidence: 0.7,
  },
  politics: {
    minAgreement: 2,
    maxSources: Infinity,
    conflictThreshold: 0.15,
    minConfidence: 0.85,
  },
  science: {
    minAgreement: 1,
    maxSources: Infinity,
    conflictThreshold: 0.3,
    minConfidence: 0.7,
  },
};

/**
 * Fetches one source, attaching the provenance needed to make its payload
 * attributable later.
 *
 * `provider` falls back to the adapter id and `respondedAt` to the fetch time,
 * so a payload is never stored anonymously even if the adapter populates no
 * `provenance` of its own. Both go through the same credential redaction as the
 * payload, because a request URL carries API keys in its query string.
 */
function fetchSource(
  adapter: DataAdapter,
  market: Market,
): Promise<SourceResult> {
  return adapter
    .fetchOutcome(market)
    .then((outcome) => ({
      adapterId: adapter.id,
      outcome: outcome.outcome,
      confidence: outcome.confidence,
      cancellationReason: outcome.cancellation?.reason,
      raw: sanitizeProvenanceValue(outcome.raw),
      provider: outcome.provenance?.provider ?? adapter.id,
      request: outcome.provenance?.request === undefined
        ? undefined
        : sanitizeProvenanceValue(outcome.provenance.request),
      respondedAt: outcome.provenance?.respondedAt ?? new Date().toISOString(),
    }))
    .catch((error) => ({
      adapterId: adapter.id,
      outcome: false,
      confidence: 0,
      error: error instanceof Error ? error.message : String(error),
    }));
}

/**
 * Resolves a market by querying adapters in priority order (primary → secondary → tertiary).
 *
 * Falls back on primary failure. Requires agreement among sources or flags for manual review.
 *
 * Adapters are tried in registration order, so register primary sources before fallbacks
 * (see the source priority table in docs/ORACLE_AND_BACKEND.md).
 */
export async function resolveMarket(
  market: Market,
  adapters: readonly DataAdapter[],
  options?: ResolveOptions,
): Promise<ResolutionResult> {
  const defaultCatConfig = market.category ? DEFAULT_CATEGORY_CONFIG[market.category] : undefined;
  const customCatConfig = market.category ? options?.categoryConfigs?.[market.category] : undefined;

  const opts: Required<Omit<ResolveOptions, "reviewQueue" | "provenanceStore" | "rawPayloadSink" | "categoryConfigs">> &
    Pick<ResolveOptions, "reviewQueue" | "provenanceStore" | "rawPayloadSink"> = {
    minAgreement:
      options?.minAgreement ??
      customCatConfig?.minAgreement ??
      defaultCatConfig?.minAgreement ??
      DEFAULT_OPTIONS.minAgreement,
    maxSources:
      options?.maxSources ??
      customCatConfig?.maxSources ??
      defaultCatConfig?.maxSources ??
      DEFAULT_OPTIONS.maxSources,
    conflictThreshold:
      options?.conflictThreshold ??
      customCatConfig?.conflictThreshold ??
      defaultCatConfig?.conflictThreshold ??
      DEFAULT_OPTIONS.conflictThreshold,
    minConfidence:
      options?.minConfidence ??
      customCatConfig?.minConfidence ??
      defaultCatConfig?.minConfidence ??
      DEFAULT_OPTIONS.minConfidence,
    minWeightedMargin: options?.minWeightedMargin ?? DEFAULT_OPTIONS.minWeightedMargin,
    reviewQueue: options?.reviewQueue,
    provenanceStore: options?.provenanceStore,
    rawPayloadSink: options?.rawPayloadSink,
  };

  // Every exit path runs through `finish`, so a payload is persisted whatever
  // the decision was — including "unresolvable" and "review", which are
  // exactly the outcomes a dispute later asks about. Audit persistence
  // failures propagate, matching `provenanceStore`: silently losing the
  // evidence would leave a resolution that cannot be defended.
  const finish = async (result: ResolutionResult): Promise<ResolutionResult> => {
    await opts.rawPayloadSink?.(market.id, result.sources);
    await opts.provenanceStore?.save(createProvenanceRecord(market.id, result));
    return result;
  };

  const supported = selectAdaptersForMarket(market, adapters);
  const limited = supported.slice(0, opts.maxSources);
  const sources: SourceResult[] = [];

  // No adapter claimed the market (issue #745). Diagnose *why* before giving
  // up, because "unresolvable" alone reads as "try again later" — and for an
  // unmappable market trying again can never help. The remedy travels with the
  // result so whoever is handling it does not have to re-derive it.
  if (limited.length === 0 && opts.checkMappability !== false) {
    const verdict = validateMarketMappability(market, {
      adapters,
      overrides: opts.mappabilityOverrides,
      registry: opts.mappabilityRegistry ?? MarketMappabilityRegistry.fromAdapters(adapters),
    });
    if (!verdict.mappable) {
      return finish({
        status: "unresolvable",
        confidence: 0,
        sources,
        reason: {
          code: "unmappable",
          detail: verdict.detail,
          mappability: verdict,
          unmappableReason: verdict.reason,
        },
      });
    }
  }

  for (const adapter of limited) {
    const result = await fetchSource(adapter, market);
    sources.push(result);
  }

  const successful = sources.filter((s) => s.error === undefined);

  const cancellation = successful.find((source) => source.cancellationReason);
  if (cancellation) {
    return finish({
      status: "cancelled",
      confidence: cancellation.confidence,
      sources,
      reason: { code: "cancelled", detail: `provider reported ${cancellation.cancellationReason}` },
    });
  }

  if (successful.length === 0) {
    return finish({
      status: "unresolvable",
      confidence: 0,
      sources,
      reason: {
        code: "all-sources-failed",
        detail: sources.length === 0 ? "no adapter was queried" : "every adapter returned an error",
      },
    });
  }

  if (successful.length < opts.minAgreement) {
    return finish({
      status: "unresolvable",
      confidence: 0,
      sources,
      reason: {
        code: "insufficient-agreement",
        detail: `${successful.length} of ${opts.minAgreement} required sources succeeded`,
      },
    });
  }

  // Confidence-weighted vote. Each source's vote counts in proportion to its
  // confidence (staleness, data quality, provider reliability all feed that
  // number in the adapter), so a 0.5-confidence stale quote cannot outvote a
  // fresh 1.0 one. Rule: weight(source) = clamp(confidence, 0, 1); the outcome
  // is the side with more total weight. If every source reports zero
  // confidence the vote falls back to head-count and the low-confidence floor
  // below routes it to review.
  const yesCount = successful.filter((s) => s.outcome).length;
  const noCount = successful.length - yesCount;
  const total = successful.length;
  const weightOf = (s: SourceResult) => Math.max(0, Math.min(1, s.confidence));
  const rawYesWeight = successful.filter((s) => s.outcome).reduce((sum, s) => sum + weightOf(s), 0);
  const rawNoWeight = successful.filter((s) => !s.outcome).reduce((sum, s) => sum + weightOf(s), 0);
  const useWeights = rawYesWeight + rawNoWeight > 0;
  const yesWeight = useWeights ? rawYesWeight : yesCount;
  const noWeight = useWeights ? rawNoWeight : noCount;
  const totalWeight = yesWeight + noWeight;
  const minority = Math.min(yesCount, noCount);
  const disagreementRatio = totalWeight > 0 ? Math.min(yesWeight, noWeight) / totalWeight : 0;

  if (disagreementRatio > opts.conflictThreshold) {
    const result: ResolutionResult = {
      status: opts.reviewQueue ? "review" : "conflict",
      confidence: 0,
      sources,
      reason: {
        code: "conflicting-outcomes",
        detail: `${minority} of ${total} sources dissent; weighted dissent ${disagreementRatio.toFixed(3)} exceeds threshold ${opts.conflictThreshold}`,
      },
    };
    await opts.reviewQueue?.enqueue(reviewItem(market, "conflicting_outcomes", result));
    return finish(result);
  }

  // Too close to call: the weighted sides are nearly level, so picking the
  // marginally heavier one would be noise dressed up as a decision.
  const margin = totalWeight > 0 ? Math.abs(yesWeight - noWeight) / totalWeight : 0;
  if (yesCount > 0 && noCount > 0 && margin < opts.minWeightedMargin) {
    const result: ResolutionResult = {
      status: opts.reviewQueue ? "review" : "conflict",
      confidence: 0,
      sources,
      reason: {
        code: "inconclusive",
        detail: `weighted margin ${margin.toFixed(3)} is below the ${opts.minWeightedMargin} minimum`,
      },
    };
    await opts.reviewQueue?.enqueue(reviewItem(market, "conflicting_outcomes", result));
    return finish(result);
  }

  const outcome = yesWeight > noWeight;
  const avgConfidence =
    successful.reduce((sum, s) => sum + s.confidence, 0) / successful.length;

  const result: ResolutionResult = {
    status: "resolved",
    outcome,
    confidence: avgConfidence,
    sources,
  };
  if (avgConfidence < opts.minConfidence) {
    result.status = "review";
    result.outcome = undefined;
    result.reason = {
      code: "low-confidence",
      detail: `mean confidence ${avgConfidence.toFixed(3)} is below the ${opts.minConfidence} floor`,
    };
    await opts.reviewQueue?.enqueue(reviewItem(market, "low_confidence", result));
  } else {
    result.reason = {
      code: "resolved",
      detail: `${outcome ? yesCount : noCount} of ${total} sources agree (weighted margin ${margin.toFixed(3)})`,
    };
  }
  return finish(result);
}
