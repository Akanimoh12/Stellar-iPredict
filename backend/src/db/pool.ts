import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, types, type PoolClient, type QueryResult } from "pg";
import { logSlowQuery, redactDatabaseUrl } from "../lib/log.js";
import { HttpError } from "../lib/errors.js";
import { observeDbQuery, recordAbandonedQuery } from "../metrics.js";

// Ensure the pg driver returns NUMERIC as a string rather than parsing it as a lossy JS number
types.setTypeParser(types.builtins.NUMERIC, (val: string) => val);

const DEFAULT_POOL_SIZE = Number.parseInt(process.env.DB_POOL_SIZE ?? "10", 10);
const READ_POOL_SIZE = Number.parseInt(
  process.env.DB_READ_POOL_SIZE ?? process.env.DB_POOL_SIZE ?? "10",
  10,
);
const IDLE_TIMEOUT_MS = Number.parseInt(process.env.DB_IDLE_TIMEOUT_MS ?? "30000", 10);
const CONNECTION_TIMEOUT_MS = Number.parseInt(
  process.env.DB_CONNECTION_TIMEOUT_MS ?? "5000",
  10,
);
export const SLOW_QUERY_THRESHOLD_MS = Number.parseInt(
  process.env.DB_SLOW_QUERY_THRESHOLD_MS ?? "200",
  10,
);
/**
 * Statement timeout for Postgres sessions (30s default).
 *
 * Pairing with Fastify server request timeout (issue #474):
 * Fastify's `requestTimeout` closes the HTTP connection when a client is slow.
 * Server-side timeouts alone do not cancel an in-flight query; the database connection
 * stays busy until the query finishes or its own `statement_timeout` fires.
 * This pairs with `queryWithCancel` (which cancels queries on client disconnect)
 * and `STATEMENT_TIMEOUT_MS` below (which acts as the hard safety net on the database side
 * preventing runaway queries from exhausting the connection pool).
 */
const STATEMENT_TIMEOUT_MS = Number.parseInt(
  process.env.DB_STATEMENT_TIMEOUT_MS ?? "30000",
  10,
);
const IDLE_IN_TRANSACTION_TIMEOUT_MS = Number.parseInt(
  process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS ?? "60000",
  10,
);

/**
 * How long a process-wide read-after-write guard keeps reads on the primary.
 *
 * Session-scoped writes are stricter: once a session has written, *every*
 * subsequent read in that session goes to the primary for the rest of the
 * session (which is a request in the HTTP layer). The window below only
 * applies to writes performed outside an explicit read session, where there
 * is no session boundary to know about.
 */
export const READ_AFTER_WRITE_WINDOW_MS = Number.parseInt(
  process.env.READ_AFTER_WRITE_WINDOW_MS ??
    process.env.READ_AFTER_WRITE_MS ??
    "2000",
  10,
);

/**
 * Maximum acceptable replica replay lag. Above this, tolerant reads are sent
 * to the primary until the replica catches up. A read served from a replica
 * that is minutes behind is worse than a slightly slower read from the primary.
 */
export const REPLICA_MAX_LAG_MS = Number.parseInt(
  process.env.REPLICA_MAX_LAG_MS ??
    process.env.REPLICA_LAG_THRESHOLD_MS ??
    "5000",
  10,
);

/** How often the replica's replay position is sampled for metrics/fallback. */
const REPLICA_LAG_POLL_INTERVAL_MS = Number.parseInt(
  process.env.REPLICA_LAG_POLL_INTERVAL_MS ?? "15000",
  10,
);

/** Backoff after a failed replica check before the replica is tried again. */
const REPLICA_FAILURE_COOLDOWN_MS = Number.parseInt(
  process.env.REPLICA_FAILURE_COOLDOWN_MS ?? "5000",
  10,
);

let _pool: Pool | null = null;
let _readPool: Pool | null = null;
/** URL the current read pool was constructed from, so an env change in tests is honoured. */
let _readPoolUrl: string | null = null;

function createPool(
  connectionString: string,
  max: number,
  label: "primary" | "replica",
): Pool {
  const instance = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });

  instance.on("connect", async (client) => {
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_TIMEOUT_MS}`);
  });

  instance.on("error", (err) => {
    const message = err instanceof Error ? redactDatabaseUrl(err.message) : redactDatabaseUrl(String(err));
    console.error(`Unexpected ${label} pool error:`, message);
  });

  return instance;
}

function getPool(): Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is required");
    }

    _pool = createPool(process.env.DATABASE_URL, DEFAULT_POOL_SIZE, "primary");
  }
  return _pool;
}

/**
 * The configured read-replica connection string, if any.
 *
 * `DATABASE_READ_URL` is the canonical name. The aliases exist because
 * deployment templates in the wild use all three spellings; accepting them
 * means an operator does not have to rename an existing secret just to turn
 * this feature on.
 */
function getReadConnectionString(): string | undefined {
  const candidates = [
    process.env.DATABASE_READ_URL,
    process.env.READ_DATABASE_URL,
    process.env.DATABASE_REPLICA_URL,
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return value;
  }
  return undefined;
}

/** True when a replica URL is configured. No pool is created by this check. */
export function isReplicaConfigured(): boolean {
  return getReadConnectionString() !== undefined;
}

/**
 * Returns the replica pool, constructing it on first use.
 *
 * Throws when no replica is configured. Callers that want the documented
 * "fall back to the primary" behaviour should use {@link getReadPool} or
 * {@link queryRead} instead.
 */
export function getReplicaPool(): Pool {
  const connectionString = getReadConnectionString();
  if (!connectionString) {
    throw new Error(
      "DATABASE_READ_URL environment variable is required to use the read replica",
    );
  }

  if (!_readPool || _readPoolUrl !== connectionString) {
    if (_readPool) {
      // The URL changed (normally only in tests): retire the old pool without
      // blocking the caller on connection teardown.
      void _readPool.end().catch(() => undefined);
    }
    _readPool = createPool(connectionString, READ_POOL_SIZE, "replica");
    _readPoolUrl = connectionString;
    startReplicaLagMonitor();
  }

  return _readPool;
}

/**
 * The read pool with the "no replica configured" fallback applied.
 *
 * When no replica is configured this is the primary pool, so every caller can
 * use it unconditionally and the system behaves exactly as it did before read
 * replica support existed.
 */
export function getReadPool(): Pool {
  return isReplicaConfigured() ? getReplicaPool() : getPool();
}

/** The primary pool, exposed for callers that must assert routing in tests. */
export function getPrimaryPool(): Pool {
  return getPool();
}

// ---------------------------------------------------------------------------
// Read-after-write sessions
// ---------------------------------------------------------------------------
//
// The correctness trap in read replicas is a user writing and immediately
// reading the result back through a replica that has not replayed the write
// yet. A bet placed and then reloaded must never render the pre-bet state.
//
// A "session" is a unit of user work — for HTTP that is one request, but any
// caller can open one around a multi-step operation. Once a session has
// written, every read it performs goes to the primary for the rest of the
// session. Writes made outside a session are guarded for
// READ_AFTER_WRITE_WINDOW_MS instead, because there is no session boundary to
// scope the guard to.
export interface ReadSession {
  /** Number of writes observed in this session. Any value > 0 pins reads to primary. */
  writes: number;
  /** Epoch milliseconds of the last write in this session. */
  lastWriteAt: number;
}

const readSessionStorage = new AsyncLocalStorage<ReadSession>();

/** Last process-wide write timestamp, used when there is no active session. */
let lastGlobalWriteAt = 0;

/**
 * Records that a write has happened.
 *
 * Call this after a successful write when the write does not go through this
 * module's query helpers (for example, a write inside a transaction). The
 * helpers here call it automatically for statements that are not read-only.
 */
export function markWrite(at: number = Date.now()): void {
  const session = readSessionStorage.getStore();
  if (session) {
    session.writes += 1;
    session.lastWriteAt = at;
    return;
  }
  lastGlobalWriteAt = at;
}

/** True when the active (or most recent unscoped) write requires primary reads. */
export function shouldReadFromPrimary(now: number = Date.now()): boolean {
  const session = readSessionStorage.getStore();
  if (session) {
    return session.writes > 0;
  }
  return (
    lastGlobalWriteAt > 0 &&
    now - lastGlobalWriteAt < READ_AFTER_WRITE_WINDOW_MS
  );
}

/**
 * Runs `fn` inside a new read session.
 *
 * Reads issued inside `fn` are replica-eligible until `fn` writes; after that
 * they stay on the primary until `fn` completes. Use this around a request
 * (or any unit of work whose reads must be consistent with its writes).
 */
export function runWithReadSession<T>(fn: () => T): T {
  return readSessionStorage.run({ writes: 0, lastWriteAt: 0 }, fn);
}

/** Alias describing the guarantee, for call sites where that is clearer. */
export const runWithReadAfterWriteSession = runWithReadSession;

/** Returns the active session, or `undefined` outside one. Primarily for tests/diagnostics. */
export function getReadSession(): ReadSession | undefined {
  return readSessionStorage.getStore();
}

/**
 * Resets process-wide read-after-write state. Sessions are owned by their
 * async context and are unaffected. Test-only helper.
 */
export function resetReadAfterWriteState(): void {
  lastGlobalWriteAt = 0;
}

// ---------------------------------------------------------------------------
// Read/write statement classification
// ---------------------------------------------------------------------------

const WRITE_KEYWORD_PATTERN =
  /\b(?:INSERT|UPDATE|DELETE|MERGE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|ANALYZE|REFRESH|CALL|DO|LOCK|NOTIFY|LISTEN|UNLISTEN|SET|RESET)\b/i;
const ROW_LOCK_PATTERN =
  /\bFOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i;
const SELECT_INTO_PATTERN =
  /^\s*SELECT\b[\s\S]*\bINTO\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?[A-Za-z_"]/i;

/**
 * True for statements that are safe to execute on a replica.
 *
 * Deliberately conservative: only a plain SELECT / WITH ... SELECT / SHOW /
 * EXPLAIN is considered read-only, and anything that could write, lock rows,
 * or create a table is excluded. A false negative just sends a read to the
 * primary; a false positive would send a write to a read-only replica and
 * fail the request.
 */
export function isReadOnlyQuery(text: string): boolean {
  const sql = text.trim();
  if (!sql) return false;
  if (!/^(?:SELECT|WITH|SHOW|EXPLAIN)\b/i.test(sql)) return false;
  if (ROW_LOCK_PATTERN.test(sql)) return false;
  if (SELECT_INTO_PATTERN.test(sql)) return false;
  if (WRITE_KEYWORD_PATTERN.test(sql)) return false;
  return true;
}

function markWriteIfNeeded(text: unknown): void {
  if (typeof text === "string" && !isReadOnlyQuery(text)) {
    markWrite();
  }
}

// ---------------------------------------------------------------------------
// Replica health / lag monitoring
// ---------------------------------------------------------------------------

export type ReplicaHealth = "unknown" | "healthy" | "lagging" | "unreachable";

interface ReplicaState {
  lagMs: number | null;
  health: ReplicaHealth;
  lastCheckedAt: number | null;
  lastError: string | null;
  unreachableUntil: number;
}

const replicaState: ReplicaState = {
  lagMs: null,
  health: "unknown",
  lastCheckedAt: null,
  lastError: null,
  unreachableUntil: 0,
};

let lagMonitor: NodeJS.Timeout | null = null;

/**
 * Samples the replica's replay lag.
 *
 * `pg_last_xact_replay_timestamp()` is the commit time of the last
 * transaction replayed on a standby, so the difference from the replica's
 * clock is how far behind it is. A replica with no replayed transaction yet
 * returns NULL; that is reported as zero rather than "infinitely behind".
 *
 * Failures mark the replica unreachable for a cooldown period so a down
 * replica does not add a connection attempt to every request.
 */
export async function checkReplicaLag(): Promise<number | null> {
  if (!isReplicaConfigured()) {
    replicaState.lagMs = null;
    replicaState.health = "unknown";
    replicaState.lastCheckedAt = null;
    replicaState.lastError = null;
    replicaState.unreachableUntil = 0;
    return null;
  }

  try {
    const { rows } = await getReplicaPool().query<{ lag_ms: number | string | null }>(
      `SELECT COALESCE(
         EXTRACT(EPOCH FROM (clock_timestamp() - pg_last_xact_replay_timestamp())) * 1000,
         0
       )::double precision AS lag_ms`,
    );
    const lagMs = Math.max(0, Number(rows[0]?.lag_ms ?? 0));
    replicaState.lagMs = Number.isFinite(lagMs) ? lagMs : null;
    replicaState.health =
      replicaState.lagMs !== null && replicaState.lagMs > REPLICA_MAX_LAG_MS
        ? "lagging"
        : "healthy";
    replicaState.lastCheckedAt = Date.now();
    replicaState.lastError = null;
    replicaState.unreachableUntil = 0;

    if (replicaState.health === "lagging") {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "read replica lag exceeds threshold; routing reads to primary",
          lagMs: replicaState.lagMs,
          thresholdMs: REPLICA_MAX_LAG_MS,
        }),
      );
    }

    return replicaState.lagMs;
  } catch (error) {
    replicaState.health = "unreachable";
    replicaState.lastCheckedAt = Date.now();
    replicaState.lastError = redactDatabaseUrl(
      error instanceof Error ? error.message : String(error),
    );
    replicaState.unreachableUntil = Date.now() + REPLICA_FAILURE_COOLDOWN_MS;
    console.error(
      JSON.stringify({
        level: "error",
        msg: "read replica lag check failed; routing reads to primary",
        error: replicaState.lastError,
      }),
    );
    return null;
  }
}

/** Most recently observed replica lag in milliseconds, or `null` when unknown/not configured. */
export function getReplicaLagMs(): number | null {
  return isReplicaConfigured() ? replicaState.lagMs : null;
}

/** Current replica health, derived from the last lag sample. */
export function getReplicaHealth(): ReplicaHealth {
  if (!isReplicaConfigured()) return "unknown";
  return replicaState.health;
}

/** Whether read-only traffic may use the replica right now. */
export function canUseReplica(now: number = Date.now()): boolean {
  if (!isReplicaConfigured()) return false;
  if (replicaState.unreachableUntil > now) return false;
  if (replicaState.health === "unreachable") return false;
  if (
    replicaState.lagMs !== null &&
    replicaState.lagMs > REPLICA_MAX_LAG_MS
  ) {
    return false;
  }
  return true;
}

function startReplicaLagMonitor(): void {
  if (lagMonitor || !isReplicaConfigured()) return;

  // Prime the gauge immediately so the first reads have a health signal, then
  // refresh on a schedule. `unref()` keeps a short-lived process (tests, CLIs)
  // from being held open by the monitor.
  void checkReplicaLag();
  lagMonitor = setInterval(() => {
    void checkReplicaLag();
  }, REPLICA_LAG_POLL_INTERVAL_MS);
  lagMonitor.unref?.();
}

/** Stops the background replica sampler. Called by {@link shutdown}. */
export function stopReplicaLagMonitor(): void {
  if (lagMonitor) {
    clearInterval(lagMonitor);
    lagMonitor = null;
  }
}

// ---------------------------------------------------------------------------
// Routing counters (monitoring)
// ---------------------------------------------------------------------------

export interface ReadRoutingMetrics {
  primary: number;
  replica: number;
  fallbackNoReplica: number;
  fallbackReadAfterWrite: number;
  fallbackReplicaLag: number;
  fallbackReplicaUnreachable: number;
  primaryForWrite: number;
}

const routingMetrics: ReadRoutingMetrics = {
  primary: 0,
  replica: 0,
  fallbackNoReplica: 0,
  fallbackReadAfterWrite: 0,
  fallbackReplicaLag: 0,
  fallbackReplicaUnreachable: 0,
  primaryForWrite: 0,
};

/** Snapshot of which pool served read traffic and why fallbacks happened. */
export function getReadRoutingMetrics(): ReadRoutingMetrics {
  return { ...routingMetrics };
}

/**
 * Chooses the pool for one statement and records the reason.
 *
 * This is the single routing decision used by `queryRead`, the `readPool`
 * proxy, and cancellable reads, so the policy cannot drift between entry
 * points.
 */
function selectPoolForStatement(text: string): Pool {
  if (!isReadOnlyQuery(text)) {
    // The read pool is never allowed to execute a write. This also protects
    // against a caller accidentally handing write SQL to `queryRead`.
    markWrite();
    routingMetrics.primary += 1;
    routingMetrics.primaryForWrite += 1;
    return getPool();
  }

  if (!isReplicaConfigured()) {
    routingMetrics.primary += 1;
    routingMetrics.fallbackNoReplica += 1;
    return getPool();
  }

  if (shouldReadFromPrimary()) {
    routingMetrics.primary += 1;
    routingMetrics.fallbackReadAfterWrite += 1;
    return getPool();
  }

  if (!canUseReplica()) {
    routingMetrics.primary += 1;
    if (replicaState.health === "unreachable") {
      routingMetrics.fallbackReplicaUnreachable += 1;
    } else {
      routingMetrics.fallbackReplicaLag += 1;
    }
    return getPool();
  }

  routingMetrics.replica += 1;
  return getReplicaPool();
}

async function runQuery<Row extends object>(
  target: Pool,
  text: string,
  params: unknown[],
): Promise<QueryResult<Row>> {
  const startedAt = performance.now();
  try {
    return (await target.query(text, params)) as QueryResult<Row>;
  } finally {
    observeDbQuery(performance.now() - startedAt);
  }
}

/**
 * Executes a read-only statement on the replica when it is configured and
 * healthy, and on the primary otherwise.
 *
 * Use this (or the {@link readPool} proxy) for queries whose result tolerates
 * slight staleness. Anything that must observe its own writes belongs on
 * {@link pool} / {@link query}, or inside a {@link runWithReadSession}.
 */
export async function queryRead<Row extends object>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<Row>> {
  const target = selectPoolForStatement(text);
  const startedAt = performance.now();
  const result = await runQuery<Row>(target, text, params);
  const durationMs = performance.now() - startedAt;

  if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
    logSlowQuery({
      query: text,
      durationMs,
      thresholdMs: SLOW_QUERY_THRESHOLD_MS,
    });
  }

  return result;
}

// Lazy accessor so `import { pool }` call sites keep working unchanged while
// the underlying pool is only constructed on first property access. Every
// property (query, connect, end, on, ...) is forwarded to the lazily-created
// `Pool`.
//
// `query` is also timed: each statement that goes through the shared pool is
// recorded into the `db_query_duration_ms` histogram (`metrics.ts`), which is
// the database-load series the cache/DB dashboard plots against hit rate and
// the `DatabaseSlow` alert evaluates. `queryWithCancel` runs its statement on
// a checked-out client and times it at its own call site instead; only
// statements issued on a client from `getClient()` — i.e. inside
// `withTransaction` — stay out of the histogram. Callers must use the promise
// form of `query`: the callback form is not used anywhere in this codebase and
// would not be timed correctly.
export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop) {
    const instance = getPool();
    const value = Reflect.get(instance, prop);

    if (prop === "query" && typeof value === "function") {
      return async (...args: unknown[]) => {
        markWriteIfNeeded(args[0]);
        const startedAt = performance.now();
        try {
          return await (
            value as (...queryArgs: unknown[]) => Promise<unknown>
          ).apply(instance, args);
        } finally {
          // A statement that rejects still cost the database the round trip.
          observeDbQuery(performance.now() - startedAt);
        }
      };
    }

    return value;
  },
});

/**
 * Read-only pool. Resolves to the replica when one is configured, healthy and
 * not blocked by a read-after-write guard; otherwise to the primary.
 *
 * This is a drop-in `Pool`: pass it to functions typed against the `Queryable`
 * interface (`{ query }`) and they automatically become replica-eligible.
 */
export const readPool: Pool = new Proxy({} as Pool, {
  get(_target, prop) {
    if (prop === "query") {
      return async <Row extends object>(
        text: string,
        params: unknown[] = [],
      ): Promise<QueryResult<Row>> => queryRead<Row>(text, params);
    }

    if (prop === "connect") {
      return async (): Promise<PoolClient> => {
        // A checkout has no SQL to classify, so use the same health/lag/
        // session checks as a read. A caller that needs the primary must use
        // `getClient()` instead.
        const target = shouldReadFromPrimary() || !canUseReplica()
          ? getPool()
          : getReplicaPool();
        return target.connect();
      };
    }

    if (prop === "end") {
      return async (): Promise<void> => shutdown();
    }

    const target = isReplicaConfigured() ? getReplicaPool() : getPool();
    return Reflect.get(target, prop);
  },
});

/**
 * Pool saturation gauges, readable without attaching a debugger.
 *
 * `total` is the number of connections currently held by the pool, `idle` how
 * many are available for immediate reuse, and `waiting` how many requests are
 * queued because all connections are checked out. A rising `waiting` count is
 * the first sign of exhaustion. `max` is the configured ceiling, so `total`
 * can be read as a fraction of capacity.
 */
export interface PoolMetrics {
  total: number;
  idle: number;
  waiting: number;
  max: number;
}

/**
 * Current pool occupancy. Reads the pool only if it already exists: a metrics
 * scrape must not be the thing that constructs a pool, or fails when
 * `DATABASE_URL` is unset. Before the first query the gauges are zero.
 */
export function getPoolMetrics(): PoolMetrics {
  if (!_pool) {
    return { total: 0, idle: 0, waiting: 0, max: DEFAULT_POOL_SIZE };
  }
  return {
    total: _pool.totalCount,
    idle: _pool.idleCount,
    waiting: _pool.waitingCount,
    max: DEFAULT_POOL_SIZE,
  };
}

/** Read-pool occupancy, with `configured` distinguishing "no replica" from "not used yet". */
export interface ReadPoolMetrics extends PoolMetrics {
  configured: boolean;
}

export function getReadPoolMetrics(): ReadPoolMetrics {
  if (!isReplicaConfigured()) {
    return { total: 0, idle: 0, waiting: 0, max: READ_POOL_SIZE, configured: false };
  }
  if (!_readPool) {
    return { total: 0, idle: 0, waiting: 0, max: READ_POOL_SIZE, configured: true };
  }
  return {
    total: _readPool.totalCount,
    idle: _readPool.idleCount,
    waiting: _readPool.waitingCount,
    max: READ_POOL_SIZE,
    configured: true,
  };
}

/** Serialisable replica status for diagnostics/tests. */
export interface ReplicaMetrics {
  configured: boolean;
  health: ReplicaHealth;
  lagMs: number | null;
  maxLagMs: number;
  lastCheckedAt: number | null;
  lastError: string | null;
  readPool: ReadPoolMetrics;
  routing: ReadRoutingMetrics;
}

export function getReplicaMetrics(): ReplicaMetrics {
  return {
    configured: isReplicaConfigured(),
    health: getReplicaHealth(),
    lagMs: getReplicaLagMs(),
    maxLagMs: REPLICA_MAX_LAG_MS,
    lastCheckedAt: replicaState.lastCheckedAt,
    lastError: replicaState.lastError,
    readPool: getReadPoolMetrics(),
    routing: getReadRoutingMetrics(),
  };
}

/** Prometheus text exposition for replica health, lag, occupancy and routing. */
export function serializeReplicaMetrics(): string {
  const metrics = getReplicaMetrics();
  const lines = [
    "# HELP db_replica_configured Whether a read replica connection is configured",
    "# TYPE db_replica_configured gauge",
    `db_replica_configured ${metrics.configured ? 1 : 0}`,
    "# HELP db_replica_healthy Whether the read replica is usable (1) or reads are falling back to the primary (0)",
    "# TYPE db_replica_healthy gauge",
    `db_replica_healthy ${metrics.configured && metrics.health !== "unreachable" ? 1 : 0}`,
    "# HELP db_replica_lag_ms Replication replay lag reported by the read replica, in milliseconds",
    "# TYPE db_replica_lag_ms gauge",
    `db_replica_lag_ms ${metrics.lagMs ?? 0}`,
    "# HELP db_replica_lag_seconds Replication replay lag reported by the read replica, in seconds",
    "# TYPE db_replica_lag_seconds gauge",
    `db_replica_lag_seconds ${((metrics.lagMs ?? 0) / 1000).toFixed(3)}`,
    "# HELP db_replica_max_lag_ms Configured lag threshold above which reads use the primary",
    "# TYPE db_replica_max_lag_ms gauge",
    `db_replica_max_lag_ms ${metrics.maxLagMs}`,
    "# HELP db_read_queries_total Read statements by the pool that served them",
    "# TYPE db_read_queries_total counter",
    `db_read_queries_total{target="primary"} ${metrics.routing.primary}`,
    `db_read_queries_total{target="replica"} ${metrics.routing.replica}`,
    "# HELP db_read_fallbacks_total Read statements routed to the primary instead of the replica, by reason",
    "# TYPE db_read_fallbacks_total counter",
    `db_read_fallbacks_total{reason="no_replica"} ${metrics.routing.fallbackNoReplica}`,
    `db_read_fallbacks_total{reason="read_after_write"} ${metrics.routing.fallbackReadAfterWrite}`,
    `db_read_fallbacks_total{reason="replica_lag"} ${metrics.routing.fallbackReplicaLag}`,
    `db_read_fallbacks_total{reason="replica_unreachable"} ${metrics.routing.fallbackReplicaUnreachable}`,
    `db_read_fallbacks_total{reason="write_statement"} ${metrics.routing.primaryForWrite}`,
  ];

  if (metrics.readPool.configured) {
    lines.push(
      "# HELP db_read_pool_connections Read replica connection pool occupancy",
      "# TYPE db_read_pool_connections gauge",
      `db_read_pool_connections_total ${metrics.readPool.total}`,
      `db_read_pool_connections_idle ${metrics.readPool.idle}`,
      `db_read_pool_connections_waiting ${metrics.readPool.waiting}`,
      "# HELP db_read_pool_connections_max Configured maximum size of the read replica pool",
      "# TYPE db_read_pool_connections_max gauge",
      `db_read_pool_connections_max ${metrics.readPool.max}`,
    );
  }

  return lines.join("\n");
}

export async function query<Row extends object>(
  text: string,
  params: (string | number | boolean | null | Date)[],
): Promise<QueryResult<Row>> {
  markWriteIfNeeded(text);
  const startedAt = performance.now();
  const result = await pool.query(text, params);
  const durationMs = performance.now() - startedAt;

  if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
    logSlowQuery({
      query: text,
      durationMs,
      thresholdMs: SLOW_QUERY_THRESHOLD_MS,
    });
  }

  return result as QueryResult<Row>;
}

export async function getClient(): Promise<PoolClient> {
  // A transaction may write even if its first statement reads. Pinning reads
  // to the primary for the rest of the session is the safe side of that
  // ambiguity.
  markWrite();
  return getPool().connect();
}

export async function shutdown(): Promise<void> {
  stopReplicaLagMonitor();
  // Shutdown must not create a lazy pool (or require configuration) just to close it.
  // Clear the handles before awaiting so a second signal cannot call `end()` twice.
  const primaryPoolToClose = _pool;
  const readPoolToClose = _readPool;
  _pool = null;
  _readPool = null;
  _readPoolUrl = null;
  await Promise.all([
    primaryPoolToClose?.end(),
    readPoolToClose?.end(),
  ]);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ---------------------------------------------------------------------------
// Cancellable queries (#475)
// ---------------------------------------------------------------------------
//
// A client that disconnects mid-request leaves its query running to
// completion with nobody left to read the result — under load (a dashboard
// polling aggressively, a retrying client) that quietly eats into DB
// capacity for work whose output is thrown away.
//
// `pg` (node-postgres) has no `AbortSignal`-based query cancellation and a
// query promise can't simply be "dropped" — the backend process on the
// server keeps executing the statement regardless of whether the Node side
// is still listening. The only way to actually stop it is Postgres's own
// cancellation protocol: a *different* connection asking the server to
// cancel a specific backend process (`pg_cancel_backend(pid)`). That is why
// this needs two connections — one running the query, one issuing the
// cancel — rather than anything on the original connection/promise itself.
//
// IMPORTANT — read-only use only: cancelling a statement that is one leg of
// a multi-statement transaction can leave that transaction aborted on the
// server while the client-side code (see db/tx.ts `withTransaction`) has no
// idea and may still try to run further statements or COMMIT on the same
// connection, which then errors in a confusing way or, worse, silently
// no-ops on an already-aborted transaction. So `queryWithCancel` must only
// ever be used for standalone, single-statement, read-only queries (the GET
// endpoints backing a page a user might navigate away from) — never inside
// `withTransaction`. Writes always run to completion or roll back cleanly.

export interface CancellablePool {
  connect(): Promise<PoolClient>;
  query<Row extends object = never>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<Row>>;
}

/** Error thrown by {@link queryWithCancel} when a query is abandoned. */
export class QueryCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortError";
  }
}

export interface QueryWithCancelOptions {
  /** Aborts (typically because the client disconnected) to cancel the query. */
  signal?: AbortSignal;
  /** Route label used for the abandoned-query metric, e.g. "GET /api/markets". */
  route?: string;
}

/**
 * Run a single read-only query that can be abandoned when `signal` aborts.
 *
 * When the signal fires before the query settles, a second connection is
 * used to ask Postgres to cancel the backend process running the query
 * (`pg_cancel_backend`), and the returned promise rejects with an
 * `AbortError` instead of resolving with a result nothing will consume. If
 * the signal never fires, this behaves exactly like {@link query}.
 *
 * When `targetPool` is this module's primary or read pool, a read-only
 * statement is routed through the same replica decision as {@link queryRead}.
 * That keeps the market GET routes (which wrap their pool for cancellation)
 * replica-eligible without giving them a second routing code path.
 */
export async function queryWithCancel<Row extends object>(
  targetPool: CancellablePool,
  text: string,
  params: unknown[] = [],
  options: QueryWithCancelOptions = {},
): Promise<QueryResult<Row>> {
  const { signal, route } = options;

  const isModulePool =
    targetPool === (pool as unknown as CancellablePool) ||
    targetPool === (readPool as unknown as CancellablePool);
  const effectivePool: CancellablePool = isModulePool
    ? (selectPoolForStatement(text) as unknown as CancellablePool)
    : targetPool;

  if (!signal) {
    const result = await runQuery<Row>(
      effectivePool as unknown as Pool,
      text,
      params,
    );
    return result;
  }

  if (signal.aborted) {
    throw new QueryCancelledError("Query aborted before it started");
  }

  const client = await effectivePool.connect();
  let cancelled = false;
  let onAbort: (() => void) | undefined;

  try {
    // Look up the backend pid for THIS connection before issuing the real
    // query. Once the real query is in flight, `client.query()` calls are
    // serialised on the same connection — a pid lookup issued after the
    // fact would simply queue behind the query we're trying to cancel and
    // never run in time to matter.
    const { rows: pidRows } = await client.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const pid = pidRows[0]?.pid;

    onAbort = () => {
      cancelled = true;
      if (pid !== undefined) {
        // Fire-and-forget on a different connection — see cancelBackend.
        void cancelBackend(effectivePool, pid);
      }
    };

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // Time the statement itself — this is the workload query; the pid lookup
    // above and `pg_cancel_backend` below are bookkeeping and are not part of
    // `db_query_duration_ms`. Recording in a `finally` keeps a cancelled or
    // failed statement counted: it still ran against the database.
    const startedAt = performance.now();
    try {
      const result = await client.query<Row>(text, params);
      return result;
    } finally {
      const durationMs = performance.now() - startedAt;
      observeDbQuery(durationMs);
      if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
        logSlowQuery({ query: text, durationMs, thresholdMs: SLOW_QUERY_THRESHOLD_MS });
      }
    }
  } catch (error) {
    if (cancelled) {
      recordAbandonedQuery(route);
      throw new QueryCancelledError("Query cancelled: client disconnected");
    }
    throw error;
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    client.release();
  }
}

/**
 * Asks Postgres to cancel the backend process `pid` via a separate
 * connection — cancellation cannot be requested over the connection that is
 * itself busy running the query.
 */
async function cancelBackend(
  targetPool: CancellablePool,
  pid: number,
): Promise<void> {
  try {
    await targetPool.query("SELECT pg_cancel_backend($1)", [pid]);
  } catch (err) {
    console.error(`Failed to send pg_cancel_backend(${pid}):`, err);
  }
}

// ---------------------------------------------------------------------------
// Per-query timeout support (#595)
// ---------------------------------------------------------------------------
//
// Allows setting a tighter statement_timeout for individual queries without
// affecting the global pool setting. Uses SET LOCAL statement_timeout inside
// a transaction, which automatically reverts when the transaction ends.
// This prevents timeout leakage onto pooled connections.

export interface QueryTimeoutOptions {
  /** Timeout in milliseconds. Must be positive. */
  timeoutMs: number;
  /** Route label for metrics, e.g. "GET /api/markets/:id". */
  route?: string;
  /** Aborts (typically because the client disconnected) to cancel the query. */
  signal?: AbortSignal;
}

/**
 * Error thrown when a query exceeds its per-query timeout.
 */
export class QueryTimeoutError extends HttpError {
  public readonly timeoutMs: number;
  public readonly route?: string;

  constructor(timeoutMs: number, route?: string) {
    super(504, "QUERY_TIMEOUT", `Query timeout after ${timeoutMs}ms${route ? ` (${route})` : ""}`);
    this.name = "QueryTimeoutError";
    this.timeoutMs = timeoutMs;
    this.route = route;
  }
}

/**
 * Run a query with a local statement timeout.
 *
 * Uses a transaction with SET LOCAL statement_timeout so the timeout
 * only applies to this query and automatically reverts. The global
 * STATEMENT_TIMEOUT_MS remains as a backstop.
 *
 * @param targetPool - Pool or client to run the query on
 * @param text - SQL query text
 * @param params - Query parameters
 * @param options - Timeout options (timeoutMs required)
 * @returns Query result
 * @throws QueryTimeoutError if the query exceeds the timeout
 */
export async function queryWithTimeout<Row extends object>(
  targetPool: CancellablePool,
  text: string,
  params: unknown[] = [],
  options: QueryTimeoutOptions
): Promise<QueryResult<Row>> {
  const { timeoutMs, route, signal } = options;

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive integer");
  }
  if (signal?.aborted) {
    throw new QueryCancelledError("Query aborted before it started");
  }

  const client = await targetPool.connect();
  const startedAt = performance.now();
  let cancelled = false;
  let onAbort: (() => void) | undefined;

  try {
    await client.query("BEGIN");
    // SET LOCAL only affects the current transaction
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);

    if (signal) {
      const { rows } = await client.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const pid = rows[0]?.pid;

      onAbort = () => {
        cancelled = true;
        if (pid !== undefined) void cancelBackend(targetPool, pid);
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (cancelled) {
        throw new QueryCancelledError("Query aborted before it started");
      }
    }

    const result = await client.query<Row>(text, params);
    if (onAbort) {
      signal?.removeEventListener("abort", onAbort);
      onAbort = undefined;
    }
    await client.query("COMMIT");

    const durationMs = performance.now() - startedAt;
    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      logSlowQuery({
        query: text,
        durationMs,
        thresholdMs: SLOW_QUERY_THRESHOLD_MS,
      });
    }
    observeDbQuery(durationMs);

    return result as QueryResult<Row>;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Failed to roll back a timed query:", rollbackError);
    }
    const durationMs = performance.now() - startedAt;
    observeDbQuery(durationMs);

    if (cancelled) {
      recordAbandonedQuery(route);
      throw new QueryCancelledError("Query cancelled: client disconnected");
    }
    // Check if it's a statement_timeout error (SQLSTATE 57014)
    if (isStatementTimeoutError(error)) {
      throw new QueryTimeoutError(timeoutMs, route);
    }
    throw error;
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    client.release();
  }
}

/**
 * Check if an error is a Postgres statement_timeout (SQLSTATE 57014).
 */
function isStatementTimeoutError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code: unknown }).code) === "57014";
  }
  return false;
}

/**
 * Default fast query timeout for read endpoints (2 seconds).
 * Override per endpoint as needed.
 */
export const FAST_QUERY_TIMEOUT_MS = 2000;

/**
 * Default standard query timeout for write endpoints (10 seconds).
 */
export const STANDARD_QUERY_TIMEOUT_MS = 10000;
