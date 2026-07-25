import { type PoolClient } from "pg";
import { getClient } from "./pool.js";

/**
 * Helper to run a callback inside a PostgreSQL transaction.
 * Begins the transaction, executes the callback, and commits on success.
 * If the callback throws an error, the transaction is rolled back.
 *
 * @param fn The callback function to execute within the transaction
 * @returns The result of the callback
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
