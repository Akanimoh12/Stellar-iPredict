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
}

export interface ResolutionResult {
  status: ResolutionStatus;
  outcome?: boolean;
  confidence: number;
  sources: SourceResult[];
  /** Present on every result. */
  reason?: ResolutionReason;
}

export interface ResolveOptions {
  /** Minimum number of sources that must agree for a resolution. Defaults to 1 (2 for politics). */
  minAgreement?: number;
  /** Maximum number of sources to query before deciding. Defaults to all available. */
  maxSources?: number;
  /** Fraction of dissenting votes (0–1) that triggers a conflict flag. Defaults to 0.3 (0.15 for politics). */
  conflictThreshold?: number;
  /** Resolutions below this confidence are held for review. Defaults to 0.7 (0.85 for politics). */
  minConfidence?: number;
  reviewQueue?: ManualReviewQueue;
  /** Optional durable audit store. Every resolution decision is recorded when supplied. */
  provenanceStore?: ProvenanceStore;
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

export const DEFAULT_OPTIONS: Required<Omit<ResolveOptions, PassedThroughOptions>> = {
  minAgreement: 1,
  maxSources: Infinity,
  conflictThreshold: 0.3,
  minConfidence: 0.7,
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

  const opts: Required<Omit<ResolveOptions, PassedThroughOptions>> &
    Pick<ResolveOptions, PassedThroughOptions> = {
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
    reviewQueue: options?.reviewQueue,
    provenanceStore: options?.provenanceStore,
    categoryConfigs: options?.categoryConfigs,
    checkMappability: options?.checkMappability ?? true,
    mappabilityRegistry: options?.mappabilityRegistry,
    mappabilityOverrides: options?.mappabilityOverrides,
  };

  const finish = async (result: ResolutionResult): Promise<ResolutionResult> => {
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

  const yesCount = successful.filter((s) => s.outcome).length;
  const noCount = successful.length - yesCount;
  const total = successful.length;
  const minority = Math.min(yesCount, noCount);
  const disagreementRatio = total > 0 ? minority / total : 0;

  if (disagreementRatio > opts.conflictThreshold) {
    const result: ResolutionResult = {
      status: opts.reviewQueue ? "review" : "conflict",
      confidence: 0,
      sources,
      reason: {
        code: "conflicting-outcomes",
        detail: `${minority} of ${total} sources dissent (threshold ${opts.conflictThreshold})`,
      },
    };
    await opts.reviewQueue?.enqueue(reviewItem(market, "conflicting_outcomes", result));
    return finish(result);
  }

  const outcome = yesCount > noCount;
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
      detail: `${yesCount} of ${total} sources agree`,
    };
  }
  return finish(result);
}
