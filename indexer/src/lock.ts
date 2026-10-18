/**
 * PostgreSQL session-level advisory lock used to keep the event indexer a
 * singleton. The lock must live on a dedicated client: running these queries
 * through Pool.query() could acquire and release them on different sessions.
 */

export const INDEXER_ADVISORY_LOCK_ID = "7597718141076661108";

export interface AdvisoryLockClient {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
  release(error?: boolean): void;
}

export interface AdvisoryLockPool {
  connect(): Promise<AdvisoryLockClient>;
}

export interface IndexerLock {
  isHeld(): boolean;
  release(): Promise<void>;
}

export interface IndexerLockOptions {
  heartbeatIntervalMs?: number;
  onLost?: (error: IndexerLockLostError) => void;
}

export class IndexerAlreadyRunningError extends Error {
  constructor() {
    super("another indexer instance already holds the PostgreSQL advisory lock");
    this.name = "IndexerAlreadyRunningError";
  }
}

export class IndexerLockLostError extends Error {
  constructor(cause: unknown) {
    super("indexer lost its PostgreSQL advisory lock", { cause });
    this.name = "IndexerLockLostError";
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
  options: IndexerLockOptions = {},
): Promise<IndexerLock> {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new RangeError("heartbeatIntervalMs must be a positive integer");
  }

  const client = await pool.connect();

  try {
    // Let PostgreSQL release the session lock if the process stops sending heartbeats.
    await client.query("SET idle_session_timeout = '30s'");
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
  let held = true;
  let clientReleased = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTask: Promise<void> | undefined;

  const releaseClient = (destroy = false): void => {
    if (clientReleased) return;
    clientReleased = true;
    client.release(destroy);
  };

  const markLost = (cause: unknown): void => {
    if (!held) return;
    held = false;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    const error = cause instanceof IndexerLockLostError ? cause : new IndexerLockLostError(cause);
    releaseClient(true);
    options.onLost?.(error);
  };

  const scheduleHeartbeat = (): void => {
    if (released || !held) return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTask = (async () => {
        try {
          const result = await client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
            [lockId],
          );
          if (result.rows[0]?.acquired !== true) {
            throw new Error("advisory lock is held by another session");
          }

          const unlock = await client.query<{ pg_advisory_unlock: boolean }>(
            "SELECT pg_advisory_unlock($1::bigint)",
            [lockId],
          );
          if (unlock.rows[0]?.pg_advisory_unlock !== true) {
            throw new Error("advisory lock heartbeat could not release its verification lock");
          }
        } catch (error) {
          markLost(error);
        }
      })().finally(() => {
        heartbeatTask = undefined;
        scheduleHeartbeat();
      });
      heartbeatTimer.unref?.();
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  };

  scheduleHeartbeat();

  return {
    isHeld(): boolean {
      return held && !released;
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      await heartbeatTask;
      if (!held) return;
      held = false;

      try {
        const result = await client.query<{ pg_advisory_unlock: boolean }>(
          "SELECT pg_advisory_unlock($1::bigint)",
          [lockId],
        );
        if (result.rows[0]?.pg_advisory_unlock !== true) {
          throw new IndexerLockLostError(new Error("advisory lock was not held during release"));
        }
        releaseClient();
      } catch (error) {
        releaseClient(true);
        throw error;
      }
    },
  };
}
