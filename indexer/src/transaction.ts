import type { Queryable } from "./handlers/types.js";

const activeTransactions = new WeakSet<object>();

/** Run on one connection. Pools must expose connect(); query-only clients must
 * be dedicated connections. Nested work in withTransaction uses a savepoint. */
export async function inTransaction<T extends Queryable, R>(
  db: T,
  action: (client: T) => Promise<R>,
): Promise<R> {
  const source = db as T & { connect?: () => Promise<T & { release(): void }> };
  const lease = Boolean(source.connect) && !("release" in db) && !("connection" in db);
  const client = lease ? await source.connect!() : db;
  const nested = activeTransactions.has(client);
  try {
    await client.query(nested ? "SAVEPOINT handler_event" : "BEGIN");
    activeTransactions.add(client);
    try {
      const result = await action(client);
      await client.query(nested ? "RELEASE SAVEPOINT handler_event" : "COMMIT");
      return result;
    } catch (error) {
      await client.query(nested ? "ROLLBACK TO SAVEPOINT handler_event" : "ROLLBACK").catch(() => {});
      if (nested) await client.query("RELEASE SAVEPOINT handler_event").catch(() => {});
      throw error;
    } finally {
      if (!nested) activeTransactions.delete(client);
    }
  } finally {
    if (lease) (client as T & { release(): void }).release();
  }
}
