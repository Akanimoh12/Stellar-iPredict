import { Pool, type PoolClient, type QueryResult } from "pg";
import { config } from "../config/index.js";

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_SIZE,
  idleTimeoutMillis: config.DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
});

pool.on("error", (err) => {
  console.error("Unexpected pool error:", err);
});

export { pool };

export async function query<Row extends object>(
  text: string,
  params: (string | number | boolean | null | Date)[]
): Promise<QueryResult<Row>> {
  const result = await pool.query(text, params);
  return result as QueryResult<Row>;
}

export async function getClient(): Promise<PoolClient> {
  return pool.connect();
}

export async function shutdown(): Promise<void> {
  await pool.end();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
