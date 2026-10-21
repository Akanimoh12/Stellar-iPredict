/**
 * Oracle endpoint authentication-failure telemetry and spike detection
 * (issue #576).
 *
 * The oracle submission endpoint authenticates with an API key. Until now a
 * rejected key produced only a 4xx and, at best, an audit line for the
 * *submission* outcome — authentication failures were not counted at all, so a
 * provider integration that broke overnight and a scripted attempt to guess a
 * key looked identical from the outside: both were just "no submissions
 * arrived".
 *
 * This module makes those failures first-class:
 *
 *   * **Counted by reason.** {@link OracleAuthFailureReason} is a small,
 *     closed set, so the reason can safely be a Prometheus label.
 *   * **Counted by source.** Distinct client addresses are tracked so a single
 *     broken provider can be told apart from a distributed guessing attempt.
 *   * **Rate-aware.** Attempts are counted alongside failures so the failure
 *     *share* is observable, and failures are windowed so growth is visible
 *     rather than buried in a lifetime total.
 *   * **Bounded.** Both the time window and the source set have hard caps. An
 *     attacker cannot make this module the thing that takes the process down
 *     by failing from a large address range.
 *
 * ## What is deliberately *not* here
 *
 * The attempted key is never accepted by any function in this module, so it
 * cannot be retained, hashed, or logged. A near-miss key in a log line is a
 * credential in a log line — see `log.ts` `logOracleAuthFailure`. Source IPs
 * are the only per-request identifier recorded, and they are used to *count*
 * origins, never to fingerprint the credential.
 *
 * ## Cardinality
 *
 * The number of source addresses is unbounded in principle, so it is never
 * used as a metric *label*. {@link serializeOracleAuthFailureMetrics} exposes
 * `oracle_auth_failure_sources_distinct` (a gauge) instead — the count is what
 * the two alert patterns actually need, and the per-source detail stays in the
 * structured logs where it can be joined on the request id.
 */

/**
 * Why authentication failed. A closed set: every value is a stable Prometheus
 * label, and adding one is a deliberate schema change.
 *
 *  - `missing_header`      — no credential was presented at all.
 *  - `invalid_key`         — a credential was presented and did not resolve.
 *                            This is the only reason a key-guessing attempt
 *                            can produce.
 *  - `provider_mismatch`   — a *valid* credential used for a provider it is
 *                            not bound to (#429). Impossible to reach by
 *                            guessing, so it is a strong misconfiguration
 *                            signal.
 *  - `not_configured`      — the server has no oracle key configured, so no
 *                            credential could ever match. A deployment fault.
 */
export type OracleAuthFailureReason =
  | "missing_header"
  | "invalid_key"
  | "provider_mismatch"
  | "not_configured";

/** Every reason, in a stable order, for serialisation and iteration. */
export const ORACLE_AUTH_FAILURE_REASONS: readonly OracleAuthFailureReason[] = [
  "missing_header",
  "invalid_key",
  "provider_mismatch",
  "not_configured",
];

/**
 * What the failures look like together, which is the part that decides whether
 * someone is broken or someone is attacking:
 *
 *  - `misconfigured_provider` — failures concentrated on few origins, or
 *    failures that a guesser cannot produce (a valid key, a missing header).
 *  - `distributed_guessing`   — `invalid_key` failures arriving from many
 *    distinct origins in the window.
 */
export type OracleAuthFailurePattern =
  | "none"
  | "misconfigured_provider"
  | "distributed_guessing";

export type OracleAuthFailureLevel = "ok" | "warning" | "critical";

export interface OracleAuthFailureEvent {
  reason: OracleAuthFailureReason;
  /**
   * Client address the request came from (`request.ip`). Counted as an origin;
   * never combined with credential material.
   */
  source?: string;
}

export interface OracleAuthFailureThresholds {
  /** Rolling window the failure count and distinct origins are measured over. */
  windowMs: number;
  /**
   * Failures within the window before anything is considered a spike. This is
   * the "normal baseline": a handful of failures is a provider updating a key,
   * not an incident.
   */
  minFailures: number;
  /** Distinct origins at or above which a spike reads as distributed. */
  distributedSourceThreshold: number;
  /** Minimum time between two spike alerts of the same pattern. */
  cooldownMs: number;
  /**
   * Hard cap on tracked source addresses. Once reached, further unseen
   * addresses set {@link OracleAuthFailureSnapshot.sourceOverflow} instead of
   * growing the map — "many" is all the classifier needs.
   */
  maxTrackedSources: number;
}

export const DEFAULT_ORACLE_AUTH_FAILURE_THRESHOLDS: OracleAuthFailureThresholds =
  Object.freeze({
    windowMs: 5 * 60_000,
    minFailures: 10,
    distributedSourceThreshold: 5,
    cooldownMs: 5 * 60_000,
    maxTrackedSources: 1_000,
  });

export type OracleAuthFailureByReason = Record<OracleAuthFailureReason, number>;

export interface OracleAuthFailureSnapshot {
  /** Lifetime attempts that reached the authentication stage. */
  totalAttempts: number;
  /** Lifetime failures, across all reasons. */
  totalFailures: number;
  /** Lifetime failures per reason. */
  totalByReason: OracleAuthFailureByReason;
  /** Window the `window*` figures are measured over, in milliseconds. */
  windowMs: number;
  windowAttempts: number;
  windowFailures: number;
  windowByReason: OracleAuthFailureByReason;
  /** Distinct origins that failed within the window (bounded). */
  windowDistinctSources: number;
  /** True once more origins were seen than {@link OracleAuthFailureThresholds.maxTrackedSources}. */
  sourceOverflow: boolean;
  /** Origin with the most tracked failures in the window, when there is one. */
  topSource?: string;
  /** Share of windowed failures attributable to {@link topSource} (`0`–`1`). */
  topSourceShare: number;
  /** Epoch milliseconds of the most recent failure, or `null` if none. */
  lastFailureAt: number | null;
}

export interface OracleAuthFailureAssessment {
  level: OracleAuthFailureLevel;
  pattern: OracleAuthFailurePattern;
  /**
   * Whether this observation should raise an alert. {@link assessOracleAuthFailureSpike}
   * sets this whenever the level is not `ok`; {@link recordOracleAuthFailure}
   * narrows it to the first failure of a spike and then at most once per
   * cooldown, so a sustained spike pages once rather than on every request.
   */
  shouldAlert: boolean;
  windowFailures: number;
  windowAttempts: number;
  /** Failures ÷ attempts within the window (`0`–`1`). */
  failureRate: number;
  distinctSources: number;
  sourceOverflow: boolean;
  topSource?: string;
  topSourceShare: number;
  byReason: OracleAuthFailureByReason;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Bucket width of the rolling window. One second is plenty for a rate. */
const BUCKET_MS = 1_000;

interface Bucket {
  /** Bucket start in epoch seconds; `-1` marks a slot that has not been used. */
  second: number;
  attempts: number;
  failures: number;
  byReason: OracleAuthFailureByReason;
}

interface SourceStat {
  count: number;
  lastSeen: number;
}

function emptyByReason(): OracleAuthFailureByReason {
  return {
    missing_header: 0,
    invalid_key: 0,
    provider_mismatch: 0,
    not_configured: 0,
  };
}

function makeRing(windowMs: number): Bucket[] {
  const size = Math.max(1, Math.ceil(windowMs / BUCKET_MS));
  return Array.from({ length: size }, () => ({
    second: -1,
    attempts: 0,
    failures: 0,
    byReason: emptyByReason(),
  }));
}

let thresholds: OracleAuthFailureThresholds = {
  ...DEFAULT_ORACLE_AUTH_FAILURE_THRESHOLDS,
};
let ring: Bucket[] = makeRing(thresholds.windowMs);

let totalAttempts = 0;
let totalFailures = 0;
let totalByReason = emptyByReason();
let lastFailureAt: number | null = null;

let sourceStats = new Map<string, SourceStat>();
let sourceOverflow = false;
let lastPruneAt = 0;

let lastAlertAt = 0;
let lastAlertPattern: OracleAuthFailurePattern | null = null;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function getOracleAuthFailureThresholds(): OracleAuthFailureThresholds {
  return { ...thresholds };
}

/**
 * Override the classification thresholds. Intended to be called once at
 * startup (or in tests) before traffic arrives; changing `windowMs` rebuilds
 * the window and therefore discards the currently buffered observations.
 */
export function configureOracleAuthFailureThresholds(
  partial: Partial<OracleAuthFailureThresholds>,
): void {
  const next = { ...thresholds, ...partial };
  if (next.windowMs !== thresholds.windowMs) {
    ring = makeRing(next.windowMs);
  }
  thresholds = next;
}

/** Clear all counters, sources, and alert state. Tests call this between cases. */
export function resetOracleAuthFailures(): void {
  ring = makeRing(thresholds.windowMs);
  totalAttempts = 0;
  totalFailures = 0;
  totalByReason = emptyByReason();
  lastFailureAt = null;
  sourceStats = new Map();
  sourceOverflow = false;
  lastPruneAt = 0;
  lastAlertAt = 0;
  lastAlertPattern = null;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function bucketFor(second: number): Bucket {
  const index = ((second % ring.length) + ring.length) % ring.length;
  const bucket = ring[index]!;
  if (bucket.second !== second) {
    bucket.second = second;
    bucket.attempts = 0;
    bucket.failures = 0;
    bucket.byReason = emptyByReason();
  }
  return bucket;
}

/** Drop source entries that have not failed within the window. Throttled so
 * the O(sources) sweep is not paid on every rejection. */
function pruneSources(now: number): void {
  if (now - lastPruneAt < BUCKET_MS) return;
  lastPruneAt = now;
  for (const [source, stat] of sourceStats) {
    if (now - stat.lastSeen > thresholds.windowMs) {
      sourceStats.delete(source);
    }
  }
}

function trackSource(source: string, now: number): void {
  pruneSources(now);

  const existing = sourceStats.get(source);
  if (existing) {
    existing.count += 1;
    existing.lastSeen = now;
    return;
  }

  if (sourceStats.size >= thresholds.maxTrackedSources) {
    // The classifier only needs to know "many", so once the cap is reached we
    // stop growing rather than letting a wide address range exhaust memory.
    sourceOverflow = true;
    return;
  }

  sourceStats.set(source, { count: 1, lastSeen: now });
}

/**
 * Record one request that reached the authentication stage.
 *
 * Called for accepted *and* rejected requests so the failure share stays
 * meaningful; a misconfigured provider retrying all night should show up as a
 * high failure rate, not an unknown denominator.
 */
export function recordOracleAuthAttempt(): void {
  const now = Date.now();
  const bucket = bucketFor(Math.floor(now / BUCKET_MS));
  bucket.attempts += 1;
  totalAttempts += 1;
}

/**
 * Record one authentication failure and return the resulting assessment.
 *
 * Whether the observation *alerts* is edge-triggered: the first failure of a
 * spike does, subsequent ones do not until the cooldown elapses or the pattern
 * changes. The raw signal is still available from
 * {@link assessOracleAuthFailureSpike} for tests and dashboards.
 */
export function recordOracleAuthFailure(
  event: OracleAuthFailureEvent,
): OracleAuthFailureAssessment {
  const now = Date.now();
  const bucket = bucketFor(Math.floor(now / BUCKET_MS));

  bucket.failures += 1;
  bucket.byReason[event.reason] += 1;
  totalFailures += 1;
  totalByReason[event.reason] += 1;
  lastFailureAt = now;

  trackSource(event.source?.trim() || "unknown", now);

  const assessed = assessOracleAuthFailureSpike(getOracleAuthFailureSnapshot(now), thresholds);

  let shouldAlert = false;
  if (assessed.level !== "ok") {
    const patternChanged = lastAlertPattern !== assessed.pattern;
    const cooldownElapsed = now - lastAlertAt >= thresholds.cooldownMs;
    shouldAlert = patternChanged || cooldownElapsed;
    lastAlertPattern = assessed.pattern;
    lastAlertAt = now;
  }

  return { ...assessed, shouldAlert };
}

// ---------------------------------------------------------------------------
// Snapshot and classification
// ---------------------------------------------------------------------------

export function getOracleAuthFailureSnapshot(
  now: number = Date.now(),
): OracleAuthFailureSnapshot {
  const windowByReason = emptyByReason();
  let windowAttempts = 0;
  let windowFailures = 0;

  const oldestSecond = Math.floor((now - thresholds.windowMs) / BUCKET_MS);
  for (const bucket of ring) {
    if (bucket.second < oldestSecond || bucket.second === -1) continue;
    windowAttempts += bucket.attempts;
    windowFailures += bucket.failures;
    for (const reason of ORACLE_AUTH_FAILURE_REASONS) {
      windowByReason[reason] += bucket.byReason[reason];
    }
  }

  let topSource: string | undefined;
  let topCount = 0;
  let trackedFailures = 0;
  for (const [source, stat] of sourceStats) {
    trackedFailures += stat.count;
    if (stat.count > topCount) {
      topCount = stat.count;
      topSource = source;
    }
  }

  return {
    totalAttempts,
    totalFailures,
    totalByReason: { ...totalByReason },
    windowMs: thresholds.windowMs,
    windowAttempts,
    windowFailures,
    windowByReason,
    windowDistinctSources: sourceStats.size,
    sourceOverflow,
    ...(topSource !== undefined ? { topSource } : {}),
    topSourceShare: trackedFailures > 0 ? topCount / trackedFailures : 0,
    lastFailureAt,
  };
}

/**
 * Decide whether a snapshot represents a spike and, if so, which kind.
 *
 * Pure: it reads a snapshot and thresholds and returns a verdict, which is
 * what makes the two patterns unit-testable without clock manipulation.
 */
export function assessOracleAuthFailureSpike(
  snapshot: OracleAuthFailureSnapshot,
  options: OracleAuthFailureThresholds = thresholds,
): OracleAuthFailureAssessment {
  const { windowFailures, windowAttempts, windowByReason } = snapshot;
  const failureRate = windowAttempts > 0 ? windowFailures / windowAttempts : 0;

  const distributed =
    snapshot.sourceOverflow ||
    snapshot.windowDistinctSources >= options.distributedSourceThreshold;

  let pattern: OracleAuthFailurePattern = "none";
  let level: OracleAuthFailureLevel = "ok";

  if (windowFailures >= options.minFailures) {
    // Only `invalid_key` can come from guessing: a guesser has no valid key to
    // present, so it can neither trigger `provider_mismatch` nor be blamed for
    // a client that simply sends no header. Those are the signatures of one
    // integration being wrong, however many failures arrive.
    const guessFailures = windowByReason.invalid_key;

    if (guessFailures > 0 && distributed) {
      pattern = "distributed_guessing";
      level = "critical";
    } else {
      pattern = "misconfigured_provider";
      level = "warning";
    }
  }

  return {
    level,
    pattern,
    shouldAlert: level !== "ok",
    windowFailures,
    windowAttempts,
    failureRate,
    distinctSources: snapshot.windowDistinctSources,
    sourceOverflow: snapshot.sourceOverflow,
    ...(snapshot.topSource !== undefined ? { topSource: snapshot.topSource } : {}),
    topSourceShare: snapshot.topSourceShare,
    byReason: { ...windowByReason },
  };
}

// ---------------------------------------------------------------------------
// Prometheus exposition
// ---------------------------------------------------------------------------

/**
 * Serialise the oracle auth-failure series.
 *
 * Every reason is emitted even at zero: a series that only appears once a
 * failure happens is one no dashboard panel or alert expression can be built
 * against beforehand.
 */
export function serializeOracleAuthFailureMetrics(): string {
  const snapshot = getOracleAuthFailureSnapshot();
  const failureRate =
    snapshot.windowAttempts > 0
      ? snapshot.windowFailures / snapshot.windowAttempts
      : 0;

  const lines: string[] = [
    "# HELP oracle_auth_attempts_total Requests that reached oracle endpoint authentication",
    "# TYPE oracle_auth_attempts_total counter",
    `oracle_auth_attempts_total ${snapshot.totalAttempts}`,
    "# HELP oracle_auth_failures_total Oracle endpoint authentication failures by reason",
    "# TYPE oracle_auth_failures_total counter",
  ];

  for (const reason of ORACLE_AUTH_FAILURE_REASONS) {
    lines.push(
      `oracle_auth_failures_total{reason="${reason}"} ${snapshot.totalByReason[reason]}`,
    );
  }

  lines.push(
    "# HELP oracle_auth_failures_window Oracle endpoint authentication failures within the rolling window",
    "# TYPE oracle_auth_failures_window gauge",
    `oracle_auth_failures_window ${snapshot.windowFailures}`,
    "# HELP oracle_auth_failure_sources_distinct Distinct client origins that failed oracle authentication within the window",
    "# TYPE oracle_auth_failure_sources_distinct gauge",
    `oracle_auth_failure_sources_distinct ${snapshot.windowDistinctSources}`,
    "# HELP oracle_auth_failure_rate Share of recent oracle authentication attempts that failed",
    "# TYPE oracle_auth_failure_rate gauge",
    `oracle_auth_failure_rate ${failureRate}`,
  );

  return lines.join("\n");
}
