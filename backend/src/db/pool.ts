import { Pool, types, type PoolClient, type QueryResult } from "pg";
import { logSlowQuery } from "../lib/log.js";
import { recordAbandonedQuery } from "../metrics.js";

// Ensure the pg driver returns NUMERIC as a string rather than parsing it as a lossy JS number
types.setTypeParser(types.builtins.NUMERIC, (val: string) => val);

const DEFAULT_POOL_SIZE = Number.parseInt(process.env.DB_POOL_SIZE ?? "10", 10);
const IDLE_TIMEOUT_MS = Number.parseInt(process.env.DB_IDLE_TIMEOUT_MS ?? "30000", 10);
const CONNECTION_TIMEOUT_MS = Number.parseInt(
  process.env.DB_CONNECTION_TIMEOUT_MS ?? "5000",
  10,
);
const SLOW_QUERY_THRESHOLD_MS = Number.parseInt(
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

let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is required");
    }

    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: DEFAULT_POOL_SIZE,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    });

    _pool.on("connect", async (client) => {
      await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      await client.query(`SET idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_TIMEOUT_MS}`);
    });

    _pool.on("error", (err) => {
      console.error("Unexpected pool error:", err);
    });
  }
  return _pool;
}

// Lazy accessor so `import { pool }` call sites keep working unchanged while
// the underlying pool is only constructed on first property access. Every
// property (query, connect, end, on, ...) is forwarded to the lazily-created
// `Pool`.
export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop) {
    return Reflect.get(getPool(), prop);
  },
});


/**
 * Pool saturation gauges, readable without attaching a debugger.
 *
 * `total` is the number of connections currently held by the pool, `idle` how
 * many are available for immediate reuse, and `waiting` how many requests are
 * queued because all connections are checked out. A rising `waiting` count is
 * the first sign of exhaustion.
 */
export interface PoolMetrics {
  total: number;
  idle: number;
  waiting: number;
}

export function getPoolMetrics(): PoolMetrics {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

export async function query<Row extends object>(
  text: string,
  params: (string | number | boolean | null | Date)[],
): Promise<QueryResult<Row>> {
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
  return getPool().connect();
}

export async function shutdown(): Promise<void> {
  await getPool().end();
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
 */
export async function queryWithCancel<Row extends object>(
  targetPool: CancellablePool,
  text: string,
  params: unknown[] = [],
  options: QueryWithCancelOptions = {},
): Promise<QueryResult<Row>> {
  const { signal, route } = options;

  if (!signal) {
    const result = await targetPool.query<Row>(text, params);
    return result;
  }

  if (signal.aborted) {
    throw new QueryCancelledError("Query aborted before it started");
  }

  const client = await targetPool.connect();
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
        void cancelBackend(targetPool, pid);
      }
    };

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const result = await client.query<Row>(text, params);
    return result;
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
