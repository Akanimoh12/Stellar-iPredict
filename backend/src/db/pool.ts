import { Pool, type PoolClient, type QueryResult } from "pg";

const DEFAULT_POOL_SIZE = Number.parseInt(process.env.DB_POOL_SIZE ?? "10", 10);
const IDLE_TIMEOUT_MS = Number.parseInt(process.env.DB_IDLE_TIMEOUT_MS ?? "30000", 10);
const CONNECTION_TIMEOUT_MS = Number.parseInt(
  process.env.DB_CONNECTION_TIMEOUT_MS ?? "5000",
  10
);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: DEFAULT_POOL_SIZE,
  idleTimeoutMillis: IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
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
