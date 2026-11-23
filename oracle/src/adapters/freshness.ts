/**
 * Price-quote freshness (issue #744).
 *
 * A price adapter that returns `confidence: 1` for whatever number the
 * provider sent will happily resolve a market against a quote that a caching
 * layer, an edge PoP, or an upstream outage froze minutes or hours ago. The
 * number is plausible, the comparison against the threshold is arithmetically
 * correct, and the resolution is wrong — and nothing in the adapter output
 * says so, because there is no freshness check.
 *
 * This module is the shared definition of "how old is too old":
 *
 *   1. `extractTimestampMs` pulls a provider observation time out of a raw
 *      payload, understanding the three shapes providers actually use (epoch
 *      seconds, epoch milliseconds, ISO-8601).
 *   2. `assessQuote` turns that timestamp plus a {@link FreshnessPolicy} into a
 *      status and a confidence ceiling.
 *   3. `StalenessTracker` notices when an adapter is *consistently* returning
 *      data it cannot vouch for, which is the difference between one stale
 *      response and a provider serving a cached tape.
 *
 * ## What a provider can and cannot tell us
 *
 * Freshness is only checkable if the provider stamps the quote. An adapter
 * that gets nothing back from the provider falls back to the request clock,
 * which proves only that *we* asked recently — not that the answer is recent.
 * That case is reported as `untimestamped` and capped below the resolution
 * confidence floor, so it cannot silently resolve a market at full
 * confidence. See `docs/ORACLE_ADAPTER_FRESHNESS.md` for the per-provider
 * support matrix.
 */

/** Outcome of comparing a quote's provider timestamp against the policy. */
export type QuoteStatus =
  /** Timestamp present and within `staleAfterMs`. */
  | "fresh"
  /** Timestamp present, older than `staleAfterMs` but within `maxAgeMs`. */
  | "stale"
  /** Timestamp present and older than `maxAgeMs`. The adapter must reject it. */
  | "expired"
  /** Provider supplied no timestamp. Freshness is unverifiable, not verified. */
  | "untimestamped";

/**
 * Per-adapter freshness bounds.
 *
 * Every field has a default and every field is overridable per adapter, via
 * constructor options or an `ORACLE_<ADAPTER>_FRESHNESS_*` environment
 * variable (see {@link freshnessPolicyFromEnv}). Bounds are configuration
 * rather than constants because the right answer is provider-specific: an
 * exchange streaming book updates and a free-tier aggregator polling once a
 * minute do not share a defensible freshness window.
 */
export interface FreshnessPolicy {
  /**
   * Age past which a quote is rejected outright: the adapter throws rather
   * than returning an outcome, so resolution falls through to the next source.
   */
  maxAgeMs: number;
  /**
   * Age past which a quote is downweighted. Defaults to
   * {@link DEFAULT_STALE_AFTER_MS}, and is clamped to `maxAgeMs`.
   */
  staleAfterMs: number;
  /**
   * Confidence ceiling applied to a `stale` quote. Must be below the
   * resolution confidence floor for the category, or a stale quote would
   * still resolve the market.
   */
  staleConfidence: number;
  /**
   * Confidence ceiling applied to an `untimestamped` quote. Lower than
   * `staleConfidence` by default: an old quote is a known-bad number, whereas
   * a quote with no timestamp is a number nobody has checked.
   */
  untimestampedConfidence: number;
}

export const DEFAULT_MAX_QUOTE_AGE_MS = 120_000;
export const DEFAULT_STALE_AFTER_MS = 30_000;
export const DEFAULT_STALE_CONFIDENCE = 0.5;
export const DEFAULT_UNTIMESTAMPED_CONFIDENCE = 0.5;

export const DEFAULT_FRESHNESS_POLICY: Readonly<FreshnessPolicy> = Object.freeze({
  maxAgeMs: DEFAULT_MAX_QUOTE_AGE_MS,
  staleAfterMs: DEFAULT_STALE_AFTER_MS,
  staleConfidence: DEFAULT_STALE_CONFIDENCE,
  untimestampedConfidence: DEFAULT_UNTIMESTAMPED_CONFIDENCE,
});

/**
 * Epoch values below this are seconds, not milliseconds.
 *
 * 1e11 seconds is the year 5138 and 1e11 milliseconds is 1973, so any real
 * timestamp sits unambiguously on one side or the other. Comparing against
 * `Number.MAX_SAFE_INTEGER / 1000` instead would misread every plausible
 * millisecond value as seconds.
 */
const SECONDS_UPPER_BOUND_MS = 1e11;

/**
 * Normalizes a policy supplied by a caller.
 *
 * `staleAfterMs` defaults to {@link DEFAULT_STALE_AFTER_MS} rather than to
 * `maxAgeMs`: if the soft bound defaulted to the hard one, the downweight
 * window would be empty unless every deployment configured it, and a stale
 * quote would be rejected outright instead of being downweighted and passed
 * to review — a strictly coarser outcome than the policy is meant to express.
 * A `maxAgeMs` tighter than the default soft bound collapses the two, since
 * there is no room for a band inside it.
 */
export function resolveFreshnessPolicy(overrides: Partial<FreshnessPolicy> = {}): FreshnessPolicy {
  const maxAgeMs = positive(overrides.maxAgeMs, DEFAULT_MAX_QUOTE_AGE_MS, "maxAgeMs");
  const staleAfterMs = Math.min(
    positive(overrides.staleAfterMs, DEFAULT_STALE_AFTER_MS, "staleAfterMs"),
    maxAgeMs,
  );
  return {
    maxAgeMs,
    staleAfterMs,
    staleConfidence: confidence(overrides.staleConfidence, DEFAULT_STALE_CONFIDENCE, "staleConfidence"),
    untimestampedConfidence: confidence(
      overrides.untimestampedConfidence,
      DEFAULT_UNTIMESTAMPED_CONFIDENCE,
      "untimestampedConfidence",
    ),
  };
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`freshness ${name} must be a positive number of milliseconds`);
  }
  return value;
}

function confidence(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`freshness ${name} must be between 0 and 1`);
  }
  return value;
}

/**
 * Thrown when a provider's own timestamp is older than the adapter's hard
 * freshness bound. Distinct from an `AdapterError` because it is not a
 * transport or provider failure: the request succeeded and returned a
 * confidently-worded number, and rejecting it is the adapter declining to
 * resolve against data it knows is old.
 */
export class StaleQuoteError extends Error {
  readonly source: string;
  readonly ageMs: number;
  readonly maxAgeMs: number;
  readonly observedAtMs: number | null;

  constructor(
    source: string,
    options: { ageMs: number; maxAgeMs: number; observedAtMs: number | null },
  ) {
    const age = `${(options.ageMs / 1000).toFixed(1)}s`;
    const limit = `${(options.maxAgeMs / 1000).toFixed(1)}s`;
    super(
      options.observedAtMs === null
        ? `${source} returned a quote older than the ${limit} freshness bound`
        : `${source} quote is ${age} old, past the ${limit} freshness bound`,
    );
    this.name = "StaleQuoteError";
    this.source = source;
    this.ageMs = options.ageMs;
    this.maxAgeMs = options.maxAgeMs;
    this.observedAtMs = options.observedAtMs;
  }
}

/**
 * Reads a provider observation timestamp out of a raw payload.
 *
 * Providers are inconsistent in both the key they use and the unit they
 * encode it in, so the caller supplies the candidate keys in priority order
 * and this normalizes whatever shape turns up:
 *
 *   * `number` — epoch seconds or epoch milliseconds, disambiguated by magnitude.
 *   * numeric `string` — same, after trimming.
 *   * any other string — parsed as ISO-8601.
 *
 * Returns `undefined` when no candidate key is present or no candidate holds
 * a usable value; the caller treats that as `untimestamped` rather than
 * guessing. `now` is injectable so the seconds/milliseconds disambiguation
 * can be tested without freezing the clock.
 */
export function extractTimestampMs(
  payload: unknown,
  keys: readonly string[],
  now: number = Date.now(),
): number | undefined {
  if (payload === null || typeof payload !== "object") return undefined;

  const record = payload as Record<string, unknown>;

  for (const key of keys) {
    const value = record[key];
    if (value === null || value === undefined) continue;

    if (typeof value === "number") {
      const normalized = normalizeEpoch(value, now);
      if (normalized !== undefined) return normalized;
      continue;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;

      // A bare number in a string field ("1735689600") is an epoch, not a date.
      if (/^\d+(\.\d+)?$/.test(trimmed)) {
        const normalized = normalizeEpoch(Number(trimmed), now);
        if (normalized !== undefined) return normalized;
        continue;
      }

      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }

  return undefined;
}

/**
 * Converts an epoch value to milliseconds, accepting either unit.
 *
 * Values in the future beyond a small tolerance are rejected rather than
 * converted: a provider that reports `now + 1h` has a broken clock, and
 * mapping it through would produce a negative age that reads as "very fresh".
 */
function normalizeEpoch(value: number, now: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;

  const ms = value < SECONDS_UPPER_BOUND_MS ? value * 1000 : value;
  const FUTURE_TOLERANCE_MS = 60_000;

  if (ms > now + FUTURE_TOLERANCE_MS) return undefined;
  return ms;
}

/** The verdict for a single quote, plus the ceiling it imposes on confidence. */
export interface QuoteFreshness {
  status: QuoteStatus;
  /**
   * Age of the provider's observation. `null` when the provider supplied no
   * timestamp — the distinction that makes `untimestamped` different from a
   * quote that is genuinely `0ms` old.
   */
  ageMs: number | null;
  /** Provider observation time in epoch ms, or `null` when absent. */
  observedAtMs: number | null;
  /** Upper bound this quote places on the confidence an adapter may return. */
  confidenceCeiling: number;
}

/**
 * Applies a policy to a provider observation time.
 *
 * `observedAtMs` of `undefined`/`null` means the provider stamped nothing, so
 * the result is `untimestamped` regardless of how recent the HTTP request
 * was. The request clock is deliberately *not* substituted here: a caching
 * layer between the oracle and the provider would return a fresh HTTP
 * response carrying an hours-old price, and pretending the request time is
 * the observation time is exactly the bug this check exists to catch.
 */
export function assessQuote(
  observedAtMs: number | undefined | null,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS_POLICY,
  now: number = Date.now(),
): QuoteFreshness {
  if (observedAtMs === undefined || observedAtMs === null || !Number.isFinite(observedAtMs)) {
    return {
      status: "untimestamped",
      ageMs: null,
      observedAtMs: null,
      confidenceCeiling: policy.untimestampedConfidence,
    };
  }

  const ageMs = Math.max(0, now - observedAtMs);

  if (ageMs > policy.maxAgeMs) {
    return { status: "expired", ageMs, observedAtMs, confidenceCeiling: 0 };
  }

  if (ageMs > policy.staleAfterMs) {
    return { status: "stale", ageMs, observedAtMs, confidenceCeiling: policy.staleConfidence };
  }

  return { status: "fresh", ageMs, observedAtMs, confidenceCeiling: 1 };
}

/** Applies a freshness ceiling to a confidence the adapter computed. */
export function applyConfidenceCeiling(confidence: number, freshness: QuoteFreshness): number {
  return Math.max(0, Math.min(confidence, freshness.confidenceCeiling));
}

/** Whether a status means the adapter is looking at data it cannot vouch for. */
export function isNotFresh(status: QuoteStatus): boolean {
  return status !== "fresh";
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistent-staleness detection
// ─────────────────────────────────────────────────────────────────────────────

export interface StalenessTrackerOptions {
  /** Rolling window observations are counted over. Defaults to 15 minutes. */
  windowMs?: number;
  /**
   * Minimum number of not-fresh observations inside the window before the
   * adapter is reported. One stale response is noise; a run of them is a
   * provider serving a cached tape.
   */
  minNotFresh?: number;
  /**
   * Fraction of the window's observations that must be not-fresh. Combined
   * with `minNotFresh` so a burst of stale quotes behind a long run of fresh
   * ones does not page anyone.
   */
  minRatio?: number;
}

export const DEFAULT_STALENESS_WINDOW_MS = 15 * 60_000;
export const DEFAULT_MIN_NOT_FRESH = 3;
export const DEFAULT_STALENESS_MIN_RATIO = 0.5;

/** One adapter's window, as of the last {@link StalenessTracker.evaluate}. */
export interface AdapterStalenessReport {
  adapterId: string;
  /** Observations recorded in the window. */
  total: number;
  /** Observations in the window that were not `fresh`. */
  notFresh: number;
  /** `notFresh / total`, rounded to 4 places. */
  ratio: number;
  /** Worst status seen in the window. */
  worstStatus: QuoteStatus;
  /** Age of the oldest observation still in the window, in ms. */
  oldestObservationAgeMs: number;
  /** How long the adapter has been continuously not-fresh, in ms. */
  consecutiveNotFreshMs: number;
  /**
   * The breaking part: an adapter that has been not-fresh for its whole
   * window is not serving current data, no matter how many samples that
   * window holds.
   */
  windowFullyNotFresh: boolean;
}

/**
 * Rolling per-adapter record of quote freshness.
 *
 * This is the "consistent" in "an adapter consistently returns stale data".
 * It is deliberately decoupled from any particular transport: the aggregator
 * feeds it from wherever it resolves prices, and the monitor reads it for
 * alerting.
 */
export class StalenessTracker {
  private readonly windowMs: number;
  private readonly minNotFresh: number;
  private readonly minRatio: number;
  private readonly observations = new Map<string, { at: number; status: QuoteStatus }[]>();

  constructor(options: StalenessTrackerOptions = {}) {
    const windowMs = options.windowMs ?? DEFAULT_STALENESS_WINDOW_MS;
    const minNotFresh = options.minNotFresh ?? DEFAULT_MIN_NOT_FRESH;
    const minRatio = options.minRatio ?? DEFAULT_STALENESS_MIN_RATIO;

    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError("staleness windowMs must be a positive number of milliseconds");
    }
    if (!Number.isInteger(minNotFresh) || minNotFresh < 1) {
      throw new RangeError("staleness minNotFresh must be a positive integer");
    }
    if (!Number.isFinite(minRatio) || minRatio <= 0 || minRatio > 1) {
      throw new RangeError("staleness minRatio must be greater than 0 and at most 1");
    }

    this.windowMs = windowMs;
    this.minNotFresh = minNotFresh;
    this.minRatio = minRatio;
  }

  /** Records one resolution attempt. `at` is injectable for deterministic tests. */
  record(adapterId: string, status: QuoteStatus, at: number = Date.now()): void {
    const bucket = this.observations.get(adapterId) ?? [];
    bucket.push({ at, status });
    this.observations.set(adapterId, bucket);
  }

  /**
   * Returns one report per adapter whose window shows sustained
   * non-freshness, sorted worst-ratio first so the alert names the provider
   * that is furthest gone.
   */
  evaluate(now: number = Date.now()): AdapterStalenessReport[] {
    const cutoff = now - this.windowMs;
    // Retain one window beyond the cutoff so `consecutiveNotFreshMs` stays
    // accurate right up to the boundary instead of snapping to zero the
    // moment the oldest sample ages out.
    const retentionCutoff = cutoff - this.windowMs;
    const reports: AdapterStalenessReport[] = [];

    for (const [adapterId, bucket] of this.observations) {
      this.observations.set(adapterId, bucket.filter((observation) => observation.at >= retentionCutoff));

      const window = bucket.filter((observation) => observation.at >= cutoff);
      if (window.length === 0) continue;

      const notFresh = window.filter((observation) => isNotFresh(observation.status));
      const ratio = notFresh.length / window.length;

      if (notFresh.length < this.minNotFresh || ratio < this.minRatio) continue;

      const worstStatus = window.reduce<QuoteStatus>(
        (worst, observation) => rankStatus(observation.status) > rankStatus(worst) ? observation.status : worst,
        "fresh",
      );

      // Minimum by timestamp, not the first element: samples can arrive out
      // of order, and "how old is the oldest sample we have" is a question
      // about time rather than about insertion order.
      const oldestAt = Math.min(...window.map((observation) => observation.at));

      reports.push({
        adapterId,
        total: window.length,
        notFresh: notFresh.length,
        ratio: Math.round(ratio * 10_000) / 10_000,
        worstStatus,
        oldestObservationAgeMs: now - oldestAt,
        consecutiveNotFreshMs: consecutiveNotFreshMs(window, now),
        windowFullyNotFresh: notFresh.length === window.length,
      });
    }

    return reports.sort((a, b) => b.ratio - a.ratio || b.notFresh - a.notFresh);
  }

  /** Drops all recorded observations. */
  reset(): void {
    this.observations.clear();
  }

  /** Current sample count for an adapter, including samples outside the window. */
  size(adapterId: string): number {
    return this.observations.get(adapterId)?.length ?? 0;
  }
}

/**
 * How long the adapter has been continuously not-fresh.
 *
 * Derived from the observations themselves rather than from a "first bad
 * sample" marker maintained on insert, so the answer does not depend on the
 * order the samples arrived in — a replayed backlog and a live poll loop
 * report the same number for the same data.
 *
 * The run is the stretch of not-fresh observations with no fresh observation
 * after them: a fresh quote restarts the clock.
 */
function consecutiveNotFreshMs(
  window: readonly { at: number; status: QuoteStatus }[],
  now: number,
): number {
  const fresh = window.filter((observation) => !isNotFresh(observation.status));
  if (fresh.length === 0) {
    // No fresh sample anywhere in the window: the run is at least the window
    // long, and `now - oldest` understates that by construction.
    return now - Math.min(...window.map((observation) => observation.at));
  }

  const lastFreshAt = Math.max(...fresh.map((observation) => observation.at));
  const run = window
    .filter((observation) => isNotFresh(observation.status) && observation.at > lastFreshAt)
    .map((observation) => observation.at);

  if (run.length === 0) return 0;
  return now - Math.min(...run);
}

/** Severity ordering: a later rank is a worse condition. */
function rankStatus(status: QuoteStatus): number {
  switch (status) {
    case "fresh":
      return 0;
    case "untimestamped":
      return 1;
    case "stale":
      return 2;
    case "expired":
      return 3;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-adapter configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Environment slice an adapter reads its freshness bounds from. */
export type FreshnessEnvironment = Record<string, string | undefined>;

/**
 * Reads `<PREFIX>_FRESHNESS_MAX_AGE_MS`, `_STALE_AFTER_MS`,
 * `_STALE_CONFIDENCE` and `_UNTIMESTAMPED_CONFIDENCE` for one adapter.
 *
 * This is the "configurable per adapter" half of the requirement: a
 * deployment whose primary source is a slow aggregator widens the bound
 * without touching code, and a deployment that wants a fast provider to fail
 * loudly narrows it to a second.
 *
 * Unparseable values throw rather than being ignored — a typo in
 * `ORACLE_BINANCE_FRESHNESS_MAX_AGE_MS=sixty` that silently fell back to the
 * default would reintroduce exactly the blind spot the setting exists to
 * close.
 */
export function freshnessPolicyFromEnv(
  prefix: string,
  environment: FreshnessEnvironment = process.env,
  base: Partial<FreshnessPolicy> = {},
): FreshnessPolicy {
  const read = (suffix: string): number | undefined => {
    const raw = environment[`${prefix}_FRESHNESS_${suffix}`];
    if (raw === undefined || raw.trim() === "") return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new RangeError(`${prefix}_FRESHNESS_${suffix} must be a number, got "${raw}"`);
    }
    return parsed;
  };

  return resolveFreshnessPolicy({
    maxAgeMs: read("MAX_AGE_MS") ?? base.maxAgeMs,
    staleAfterMs: read("STALE_AFTER_MS") ?? base.staleAfterMs,
    staleConfidence: read("STALE_CONFIDENCE") ?? base.staleConfidence,
    untimestampedConfidence: read("UNTIMESTAMPED_CONFIDENCE") ?? base.untimestampedConfidence,
  });
}
