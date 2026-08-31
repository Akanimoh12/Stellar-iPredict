import { Pool, type PoolClient, type QueryResult } from "pg";
import { config } from "../config/index.js";

let poolInstance: Pool | null = null;

/**
 * Builds the shared Postgres pool on first use.
 *
 * The pool (and its connection string) is sourced from the validated `config`
 * module (backend/src/config/index.ts) rather than reading `process.env`
 * again, so pool tuning values come from exactly one place. Pool construction
 * and the connection-string read are deferred until first use so that
 * importing this module — and anything that transitively imports it — does not
 * throw (or exit) when `DATABASE_URL` is unset. The error surfaces clearly on
 * the first actual query instead.
 */
export function getPool(): Pool {
  if (!poolInstance) {
    poolInstance = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_SIZE,
      idleTimeoutMillis: config.DB_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    });
    poolInstance.on("error", (err) => {
      console.error("Unexpected pool error:", err);
    });
  }
  return poolInstance;
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

export async function query<Row extends object>(
  text: string,
  params: (string | number | boolean | null | Date)[],
): Promise<QueryResult<Row>> {
  const result = await getPool().query(text, params);
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
