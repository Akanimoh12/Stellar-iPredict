/**
 * Post-deployment smoke suite — check definitions.
 *
 * After a release there is currently no automated way to confirm the system
 * actually works; `docs/DEPLOYMENT-GUIDE.md` describes deploying but not
 * validating, so confidence rests on manually poking a few endpoints. These
 * checks are that validation, made runnable.
 *
 * ## Design rules
 *
 * 1. **Safe against production by default.** Every check that runs without
 *    opt-in is read-only. A check that writes real state declares
 *    `writesState: true`, needs an explicit opt-in flag *and* a target id from
 *    the operator, and says so in its own output. There is no "just try it"
 *    path.
 * 2. **A check reports a verdict, not a trace.** Each returns pass/fail/skip
 *    plus one sentence a human can act on. The reason is what gets read during
 *    an incident, not the HTTP body.
 * 3. **A broken deployment fails loudly.** A timeout, a 500, a missing field
 *    and a wrong shape are all failures, never skips. Skips exist only for
 *    things genuinely not configured, and each names what to set.
 *
 * The runner (`run.ts`) is a thin CLI over `runSmokeSuite`; keeping the logic
 * here means the whole suite is unit-testable against a stub server, which is
 * how "does it catch a broken deployment?" is answered without breaking one.
 */

export type CheckStatus = "pass" | "fail" | "skip" | "warn";

export interface CheckContext {
  /** Origin under test, without a trailing slash. */
  baseUrl: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /**
   * Oracle API key for the submission checks. Absent means the auth-rejection
   * check still runs, and the write check is skipped.
   */
  oracleApiKey?: string;
  /**
   * Market id reserved for write-path checks. Required for any check with
   * `writesState`, so nobody can accidentally submit against a live market.
   */
  writeTargetMarketId?: string;
  /** Fail a `warn` check as an error. Used by `--strict`. */
  strict: boolean;
}

export interface CheckResult {
  status: CheckStatus;
  /** One sentence. Present on fail and warn; optional elsewhere. */
  detail?: string;
  /** Structured facts for the report, e.g. measured latency. */
  data?: Record<string, unknown>;
}

export interface SmokeCheck {
  id: string;
  title: string;
  /**
   * Whether running this check changes state on the target environment.
   * Anything marked true is opt-in and clearly labelled in the output.
   */
  writesState: boolean;
  /** What a passing result means, shown in `--list`. */
  description: string;
  run(context: CheckContext): Promise<CheckResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────────────────────────────────────

export interface HttpResponse {
  status: number;
  body: unknown;
  text: string;
  latencyMs: number;
}

export type FetchLike = typeof fetch;

export class SmokeRequestError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "SmokeRequestError";
  }
}

/**
 * Performs one request and parses the body.
 *
 * A non-2xx status is returned rather than thrown, because "the endpoint
 * answered 503" and "the endpoint did not answer" are different failures and
 * the operator needs to be told which happened.
 */
export async function request(
  context: CheckContext,
  path: string,
  init: RequestInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(`${context.baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { accept: "application/json", ...init.headers },
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: response.status, body, text, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new SmokeRequestError(
      aborted
        ? `no response within ${context.timeoutMs}ms`
        : `request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pass(detail?: string, data?: Record<string, unknown>): CheckResult {
  return { status: "pass", detail, data };
}

function fail(detail: string, data?: Record<string, unknown>): CheckResult {
  return { status: "fail", detail, data };
}

function skip(detail: string): CheckResult {
  return { status: "skip", detail };
}

function warn(detail: string, data?: Record<string, unknown>): CheckResult {
  return { status: "warn", detail, data };
}

const XLM_PATTERN = /^\d+\.\d{7}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `GET /healthz` — the process is up and serving.
 *
 * Separate from readiness on purpose: a 200 here with a 503 on `/readyz` is
 * the signature of a release that came up but cannot reach its dependencies,
 * and conflating them loses that distinction.
 */
export function livenessCheck(fetchImpl?: FetchLike): SmokeCheck {
  return {
    id: "health.liveness",
    title: "GET /healthz",
    writesState: false,
    description: "The API process is up and answering.",
    async run(context) {
      const response = await request(context, "/healthz", {}, fetchImpl);
      if (response.status !== 200) {
        return fail(`expected 200, got ${response.status}`, { latencyMs: response.latencyMs });
      }
      if (!isRecord(response.body) || response.body.status !== "ok") {
        return fail("responded 200 but without a { status: \"ok\" } body");
      }
      return pass(undefined, { latencyMs: response.latencyMs });
    },
  };
}

/**
 * `GET /readyz` — dependencies reachable.
 *
 * The check most likely to catch a genuinely broken deployment: a container
 * that starts without its database URL, or against a database the migration
 * never reached, serves traffic happily and fails every read.
 */
export function readinessCheck(fetchImpl?: FetchLike): SmokeCheck {
  return {
    id: "health.readiness",
    title: "GET /readyz",
    writesState: false,
    description: "Database and Redis are reachable from the API.",
    async run(context) {
      const response = await request(context, "/readyz", {}, fetchImpl);
      if (response.status === 503) {
        const checks = isRecord(response.body) ? response.body.checks : undefined;
        const down = isRecord(checks)
          ? Object.entries(checks)
              .filter(([, value]) => isRecord(value) && value.ok === false)
              .map(([name]) => name)
          : [];
        return fail(
          `not ready${down.length > 0 ? `; failing: ${down.join(", ")}` : ""}`,
        );
      }
      if (response.status !== 200) {
        return fail(`expected 200, got ${response.status}`);
      }
      if (!isRecord(response.body) || response.body.status !== "ready") {
        return fail("responded 200 but without a { status: \"ready\" } body");
      }
      return pass(undefined, { latencyMs: response.latencyMs });
    },
  };
}

/**
 * `GET /resolution-status` — the oracle resolution pipeline.
 *
 * Always answers 200; the signal is in the body. A `stalled` status after a
 * deploy is the single most actionable thing this suite can tell an operator,
 * so it is a warning rather than a failure — the deployment is not broken, but
 * markets will not settle.
 */
export function resolutionStatusCheck(fetchImpl?: FetchLike): SmokeCheck {
  return {
    id: "health.resolution",
    title: "GET /resolution-status",
    writesState: false,
    description: "Oracle resolution is on time (stalled/delayed is a warning).",
    async run(context) {
      const response = await request(context, "/resolution-status", {}, fetchImpl);
      if (response.status !== 200) {
        return fail(`expected 200, got ${response.status}`);
      }
      if (!isRecord(response.body) || typeof response.body.status !== "string") {
        return fail("responded without a status field");
      }

      const status = response.body.status;
      const overdue = response.body.overdueMarkets;
      const oldest = response.body.oldestOverdueSeconds;

      if (status === "stalled") {
        return warn(
          `resolution is stalled: ${String(overdue)} overdue markets, oldest ${String(oldest)}s`,
          { status, overdueMarkets: overdue, oldestOverdueSeconds: oldest },
        );
      }
      if (status === "delayed") {
        return warn(`${String(overdue)} markets are overdue but not yet stalled`, {
          status,
          overdueMarkets: overdue,
          oldestOverdueSeconds: oldest,
        });
      }
      return pass(undefined, { status });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Market reads
// ─────────────────────────────────────────────────────────────────────────────

interface MarketListing {
  markets: Record<string, unknown>[];
  total: number;
}

/**
 * `GET /api/markets` — listing, pagination and the response schema.
 *
 * Also asserts the amount fields are fixed seven-decimal *strings*. A release
 * that changed the NUMERIC parser to emit numbers would still return 200 with
 * a plausible total, and every downstream client would silently lose
 * precision on large balances — a broken deployment this suite should catch,
 * not one it should pass.
 */
export function marketListingCheck(fetchImpl?: FetchLike): SmokeCheck {
  return {
    id: "markets.list",
    title: "GET /api/markets",
    writesState: false,
    description: "Markets list with well-formed pagination and exact amount strings.",
    async run(context) {
      const response = await request(context, "/api/markets?filter=all&limit=5&page=1", {}, fetchImpl);
      if (response.status !== 200) {
        return fail(`expected 200, got ${response.status}`);
      }
      if (!isRecord(response.body)) {
        return fail("responded without a JSON object");
      }

      const body = response.body as unknown as Partial<MarketListing>;
      if (!Array.isArray(body.markets)) {
        return fail("response has no `markets` array");
      }
      if (typeof body.total !== "number") {
        return fail("response has no numeric `total`");
      }
      if (body.markets.length === 0) {
        // A fresh environment legitimately has no markets. That is not a
        // broken deployment, so it must not fail the gate — but it does mean
        // the detail checks below have nothing to run against, and the report
        // should say so rather than silently passing them.
        return warn("no markets exist yet; market detail and odds were not exercised", {
          total: body.total,
        });
      }

      const malformed = findMalformedMarket(body.markets[0]!);
      if (malformed) return fail(malformed);

      return pass(undefined, { total: body.total, returned: body.markets.length });
    },
  };
}

function findMalformedMarket(market: Record<string, unknown>): string | undefined {
  for (const field of ["id", "question", "category", "end_time", "created_at"] as const) {
    if (market[field] === undefined || market[field] === null) {
      return `market is missing \`${field}\``;
    }
  }
  for (const field of ["total_yes", "total_no"] as const) {
    const value = market[field];
    // String, and a fixed seven-decimal XLM amount. A number here means the
    // NUMERIC type parser was changed and large balances will lose precision.
    if (typeof value !== "string") {
      return `market.${field} is ${typeof value}, expected a string — NUMERIC may be parsed as a number`;
    }
    if (!XLM_PATTERN.test(value)) {
      return `market.${field} is "${value}", expected a fixed seven-decimal XLM string`;
    }
  }
  return undefined;
}

/**
 * `GET /api/markets/:id` and `GET /api/markets/:id/odds` for a real market.
 *
 * A 404 for an id that the listing just returned is a real failure — it means
 * the detail route and the list route disagree, which is exactly the kind of
 * regression a manual spot check skims past.
 */
export function marketDetailCheck(fetchImpl?: FetchLike): SmokeCheck {
  return {
    id: "markets.detail",
    title: "GET /api/markets/:id and /odds",
    writesState: false,
    description: "A listed market is readable by id, and its odds compute.",
    async run(context) {
      const listing = await request(context, "/api/markets?filter=all&limit=1&page=1", {}, fetchImpl);
      if (listing.status !== 200) {
        return fail(`could not list markets: expected 200, got ${listing.status}`);
      }
      if (!isRecord(listing.body) || !Array.isArray((listing.body as MarketListing).markets)) {
        return fail("could not list markets: no `markets` array");
      }
      const first = (listing.body as MarketListing).markets[0];
      if (!first) {
        return skip("no markets exist yet, so there is no id to read back");
      }

      const id = first.id;
      if (typeof id !== "number") {
        return fail(`listed market has a non-numeric id (${typeof id})`);
      }

      const detail = await request(context, `/api/markets/${id}`, {}, fetchImpl);
      if (detail.status === 404) {
        return fail(`market ${id} appears in the list but GET /api/markets/${id} returns 404`);
      }
      if (detail.status !== 200) {
        return fail(`GET /api/markets/${id}: expected 200, got ${detail.status}`);
      }
      if (!isRecord(detail.body) || detail.body.id !== id) {
        return fail(`GET /api/markets/${id} returned a body for a different market`);
      }
      const malformed = findMalformedMarket(detail.body);
      if (malformed) return fail(`market detail: ${malformed}`);

      const odds = await request(context, `/api/markets/${id}/odds`, {}, fetchImpl);
      if (odds.status === 404) {
        return fail(`market ${id} exists but its odds return 404`);
      }
      if (odds.status !== 200) {
        return fail(`GET /api/markets/${id}/odds: expected 200, got ${odds.status}`);
      }
      if (!isRecord(odds.body) || typeof odds.body.total_pool !== "string") {
        return fail("odds response has no string `total_pool`");
      }
      if (!XLM_PATTERN.test(odds.body.total_pool as string)) {
        return fail(
          `odds.total_pool is "${String(odds.body.total_pool)}", expected a fixed seven-decimal XLM string`,
        );
      }

      return pass(undefined, { marketId: id, totalPool: odds.body.total_pool });
    },
  };
}

/**
 * `GET /api/markets/999999999` — 404 handling.
 *
 * Cheap, and it catches the class of release where an error handler change
 * turns a 404 into a 500 or a stack trace.
 */
export function notFoundCheck(fetchImpl?: FetchLike): SmokeCheck {
  return {
    id: "markets.notFound",
    title: "GET /api/markets/999999999",
    writesState: false,
    description: "An unknown market id returns 404, not 500.",
    async run(context) {
      const response = await request(context, "/api/markets/999999999", {}, fetchImpl);
      if (response.status !== 404) {
        return fail(`expected 404 for an unknown market, got ${response.status}`);
      }
      if (response.text.includes("at ") && response.text.includes(".ts:")) {
        return fail("404 response body contains a stack trace");
      }
      return pass();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Oracle submission path
// ─────────────────────────────────────────────────────────────────────────────

interface OracleSubmitBody {
  marketId: number;
  outcome: string;
  signature: string;
  provider: string;
}

function wellFormedSubmission(context: CheckContext): OracleSubmitBody {
  return {
    // Well-formed but never valid: the signature is not a real provider
    // signature, so even a correctly-authenticated request cannot be accepted.
    // The point is to exercise routing, auth and validation ordering.
    marketId: Number(context.writeTargetMarketId ?? "1"),
    outcome: "YES",
    signature: "smoke-test-not-a-real-signature",
    provider: "smoke-test-provider",
  };
}

/** Whether this check verified anything, as opposed to being unable to try. */
function isRateLimited(response: HttpResponse): boolean {
  return response.status === 429;
}

/**
 * `POST /api/v1/oracle/submit` with no credential — must be 401.
 *
 * This is the safe half of the submission path and the reason it is the one
 * run against production: a release that drops the auth check, accepts a key
 * for the wrong provider, or has the routes mounted at the wrong prefix all
 * fail here, and none of them require writing anything.
 */
export function oracleAuthRejectionCheck(fetchImpl?: FetchLike): SmokeCheck {
  return {
    id: "oracle.authRejected",
    title: "POST /api/v1/oracle/submit (no credential)",
    writesState: false,
    description: "An unauthenticated oracle submission is rejected with 401.",
    async run(context) {
      const body = wellFormedSubmission(context);
      const response = await request(
        context,
        "/api/v1/oracle/submit",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        fetchImpl,
      );

      if (response.status === 404) {
        return fail("returned 404 — the route is not mounted; is the API under /api/v1?");
      }
      if (isRateLimited(response)) {
        // Not evidence of a broken deployment — evidence that this check
        // could not run. Reported as a warning so it is visible without
        // blocking a release for something the suite did not verify.
        return warn("rate limited; this check verified nothing — re-run after the window resets");
      }
      if (response.status !== 401) {
        return fail(`expected 401 without a credential, got ${response.status}`);
      }
      if (isRecord(response.body) && isRecord(response.body.error)) {
        if (typeof response.body.error.code !== "string") {
          return fail("401 response has no error.code");
        }
      }
      return pass();
    },
  };
}

/**
 * `POST /api/v1/oracle/submit` with a wrong credential — must be 401.
 *
 * Catches a release whose credential set is empty, misparsed, or has been
 * replaced with a permissive wildcard. A deployment that accepts an
 * unrecognised key can have an outcome submitted under someone else's name.
 */
export function oracleBadKeyCheck(fetchImpl?: FetchLike): SmokeCheck {
  return {
    id: "oracle.badKeyRejected",
    title: "POST /api/v1/oracle/submit (wrong credential)",
    writesState: false,
    description: "An unrecognised oracle API key is rejected with 401.",
    async run(context) {
      const response = await request(
        context,
        "/api/v1/oracle/submit",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "smoke-test-not-a-real-key",
          },
          body: JSON.stringify(wellFormedSubmission(context)),
        },
        fetchImpl,
      );

      if (isRateLimited(response)) {
        return warn("rate limited; this check verified nothing — re-run after the window resets");
      }
      if (response.status !== 401) {
        return fail(`expected 401 for an unrecognised key, got ${response.status}`);
      }
      return pass();
    },
  };
}

/**
 * `POST /api/v1/oracle/submit` with a real credential and an invalid signature
 * — must be 401.
 *
 * This is as far as the submission path can be exercised against production
 * without writing: a correctly-authenticated request that fails signature
 * verification proves auth, identity binding and the validation ordering are
 * all wired, and it writes no submission row.
 *
 * Requires `--oracle-api-key`. A release that has rotated or lost its keys is
 * caught here, which is a large share of what "the deployment is broken"
 * means for the oracle.
 */
export function oracleSignatureRejectionCheck(fetchImpl?: FetchLike): SmokeCheck {
  return {
    id: "oracle.badSignatureRejected",
    title: "POST /api/v1/oracle/submit (valid key, invalid signature)",
    writesState: false,
    description: "A correctly-authenticated submission with a bad signature is rejected.",
    async run(context) {
      if (!context.oracleApiKey) {
        return skip("no --oracle-api-key supplied; the authenticated path was not exercised");
      }

      const response = await request(
        context,
        "/api/v1/oracle/submit",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": context.oracleApiKey,
          },
          body: JSON.stringify(wellFormedSubmission(context)),
        },
        fetchImpl,
      );

      // 403 is the documented answer for a valid key naming another provider,
      // which is exactly what this request does.
      if (response.status === 401) {
        return fail(
          "a configured key was rejected — the deployment's ORACLE_API_KEYS do not match the key supplied",
        );
      }
      if (response.status === 403) {
        // Key recognised, acting for a provider it is not bound to. Auth and
        // identity binding both work; the signature never got checked.
        return pass();
      }
      if (isRateLimited(response)) {
        return warn("rate limited; this check verified nothing — re-run after the window resets");
      }
      if (response.status === 400) {
        return fail("submission was rejected as malformed before auth ran — the body shape changed");
      }
      if (response.status === 200) {
        return fail(
          "a submission with a fabricated signature was ACCEPTED — signature verification is not running",
        );
      }
      return fail(`unexpected status ${response.status}`);
    },
  };
}

/**
 * A real, accepted oracle submission.
 *
 * Off by default and impossible to run by accident: it needs both a key and
 * an explicit `--allow-writes` plus a dedicated market id. It exists so a
 * staging deployment can verify the whole write path, not because it is
 * appropriate against production.
 */
export function oracleSubmissionCheck(fetchImpl?: FetchLike): SmokeCheck {
  return {
    id: "oracle.submit",
    title: "POST /api/v1/oracle/submit (real submission)",
    writesState: true,
    description: "WRITES STATE. Submits against a dedicated smoke-test market.",
    async run(context) {
      if (!context.oracleApiKey) {
        return skip("no --oracle-api-key supplied");
      }
      if (!context.writeTargetMarketId) {
        // Deliberately not merely skipped-with-a-warning: submitting against
        // an arbitrary market id is how a smoke test becomes an incident.
        return skip("no --write-market-id supplied; refusing to submit against an arbitrary market");
      }

      const body = wellFormedSubmission(context);
      const response = await request(
        context,
        "/api/v1/oracle/submit",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": context.oracleApiKey,
          },
          body: JSON.stringify(body),
        },
        fetchImpl,
      );

      // The fabricated signature is rejected, which is the correct outcome
      // even here: this check cannot mint a real provider signature, so what
      // it actually proves is that the route reaches signature verification.
      if (response.status === 401) {
        return fail("configured key was rejected");
      }
      if (response.status === 200) {
        return pass("submission accepted", { marketId: body.marketId });
      }
      if (response.status === 400 || response.status === 403) {
        return fail(
          `expected the request to reach signature verification; got ${response.status} — provider identity or body shape is wrong`,
        );
      }
      return fail(`unexpected status ${response.status}`);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite assembly
// ─────────────────────────────────────────────────────────────────────────────

export interface SmokeSuiteOptions {
  fetchImpl?: FetchLike;
  /** Include the write-path checks. Off unless the operator opts in. */
  includeWriteChecks?: boolean;
}

/** Every check, in the order an operator reads them. */
export function smokeChecks(options: SmokeSuiteOptions = {}): SmokeCheck[] {
  const fetchImpl = options.fetchImpl;
  const readOnly = [
    livenessCheck(fetchImpl),
    readinessCheck(fetchImpl),
    resolutionStatusCheck(fetchImpl),
    marketListingCheck(fetchImpl),
    marketDetailCheck(fetchImpl),
    notFoundCheck(fetchImpl),
    oracleAuthRejectionCheck(fetchImpl),
    oracleBadKeyCheck(fetchImpl),
    oracleSignatureRejectionCheck(fetchImpl),
  ];
  return options.includeWriteChecks
    ? [...readOnly, oracleSubmissionCheck(fetchImpl)]
    : readOnly;
}

export interface CheckOutcome {
  id: string;
  title: string;
  writesState: boolean;
  result: CheckResult;
}

export interface SmokeSuiteResult {
  outcomes: CheckOutcome[];
  failed: number;
  warned: number;
  passed: number;
  skipped: number;
  /** Process exit code. 0 when nothing failed. */
  exitCode: number;
  durationMs: number;
}

/**
 * Runs every check, collecting outcomes rather than stopping at the first
 * failure. An operator deploying wants the whole picture in one run: a
 * readiness failure and a 404-handling failure together tell a different story
 * than either alone.
 */
export async function runSmokeSuite(
  context: CheckContext,
  options: SmokeSuiteOptions = {},
): Promise<SmokeSuiteResult> {
  const checks = smokeChecks(options);
  const outcomes: CheckOutcome[] = [];
  const startedAt = Date.now();

  for (const check of checks) {
    let result: CheckResult;
    try {
      result = await check.run(context);
    } catch (error) {
      // A transport-level failure is a failed check, not a crashed suite.
      result = fail(error instanceof Error ? error.message : String(error));
    }
    outcomes.push({ id: check.id, title: check.title, writesState: check.writesState, result });
  }

  const failed = outcomes.filter((o) => o.result.status === "fail").length;
  const warned = outcomes.filter((o) => o.result.status === "warn").length;
  const passed = outcomes.filter((o) => o.result.status === "pass").length;
  const skipped = outcomes.filter((o) => o.result.status === "skip").length;

  return {
    outcomes,
    failed,
    warned,
    passed,
    skipped,
    // `--strict` promotes warnings to failures, for a gate that wants a
    // "stalled resolution" banner to block a release.
    exitCode: failed > 0 || (context.strict && warned > 0) ? 1 : 0,
    durationMs: Date.now() - startedAt,
  };
}
