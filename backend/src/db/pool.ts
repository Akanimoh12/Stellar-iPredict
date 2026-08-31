import { Pool, type PoolClient, type QueryResult } from "pg";
import { logSlowQuery } from "../lib/log.js";

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
const STATEMENT_TIMEOUT_MS = Number.parseInt(
  process.env.DB_STATEMENT_TIMEOUT_MS ?? "30000",
  10,
);
const IDLE_IN_TRANSACTION_TIMEOUT_MS = Number.parseInt(
  process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS ?? "60000",
  10,
);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
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

pool.on("connect", async (client) => {
  await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
  await client.query(`SET idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_TIMEOUT_MS}`);
});

pool.on("error", (err) => {
  console.error("Unexpected pool error:", err);
});

export { pool };

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
