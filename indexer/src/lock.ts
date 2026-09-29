/**
 * PostgreSQL session-level advisory lock used to keep the event indexer a
 * singleton. The lock must live on a dedicated client: running these queries
 * through Pool.query() could acquire and release them on different sessions.
 */

export const INDEXER_ADVISORY_LOCK_ID = "7597718141076661108";

export interface AdvisoryLockClient {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

export interface AdvisoryLockPool {
  connect(): Promise<AdvisoryLockClient>;
}

export interface IndexerLock {
  release(): Promise<void>;
}

export class IndexerAlreadyRunningError extends Error {
  constructor() {
    super("another indexer instance already holds the PostgreSQL advisory lock");
    this.name = "IndexerAlreadyRunningError";
  }
}

/**
 * Acquire the process-wide indexer lock and retain its database session until
 * the returned handle is released. PostgreSQL also frees the lock if the
 * process crashes and its connection closes.
 */
export async function acquireIndexerLock(
  pool: AdvisoryLockPool,
  lockId: string = INDEXER_ADVISORY_LOCK_ID,
): Promise<IndexerLock> {
  const client = await pool.connect();

  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [lockId],
    );

    if (result.rows[0]?.acquired !== true) {
      client.release();
      throw new IndexerAlreadyRunningError();
    }
  } catch (error) {
    if (!(error instanceof IndexerAlreadyRunningError)) client.release();
    throw error;
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;

      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]);
      } finally {
        client.release();
      }
    },
  };
}

