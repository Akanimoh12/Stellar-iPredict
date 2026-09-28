import { selectAdaptersForMarket, type DataAdapter, type Market, type MarketCategory } from "./index.js";
import { reviewItem, type ManualReviewQueue } from "./reviewQueue.js";
import { createProvenanceRecord, sanitizeProvenanceValue, type ProvenanceStore } from "./provenance.js";

export type ResolutionStatus = "resolved" | "conflict" | "unresolvable" | "review" | "cancelled";

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
  reviewQueue?: ManualReviewQueue;
  /** Optional durable audit store. Every resolution decision is recorded when supplied. */
  provenanceStore?: ProvenanceStore;
  /** Optional durable store for the raw provider payloads behind the decision. */
  rawPayloadSink?: RawPayloadSink;
  /** Optional category-specific resolution configuration overrides. */
  categoryConfigs?: Partial<Record<MarketCategory, CategoryResolutionConfig>>;
}

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

  for (const adapter of limited) {
    const result = await fetchSource(adapter, market);
    sources.push(result);
  }

  const successful = sources.filter((s) => s.error === undefined);

  const cancellation = successful.find((source) => source.cancellationReason);
  if (cancellation) {
    return finish({ status: "cancelled", confidence: cancellation.confidence, sources });
  }

  if (successful.length === 0) {
    return finish({ status: "unresolvable", confidence: 0, sources });
  }

  if (successful.length < opts.minAgreement) {
    return finish({ status: "unresolvable", confidence: 0, sources });
  }

  const yesCount = successful.filter((s) => s.outcome).length;
  const noCount = successful.length - yesCount;
  const total = successful.length;
  const minority = Math.min(yesCount, noCount);
  const disagreementRatio = total > 0 ? minority / total : 0;

  if (disagreementRatio > opts.conflictThreshold) {
    const result: ResolutionResult = { status: opts.reviewQueue ? "review" : "conflict", confidence: 0, sources };
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
    await opts.reviewQueue?.enqueue(reviewItem(market, "low_confidence", result));
  }
  return finish(result);
}
