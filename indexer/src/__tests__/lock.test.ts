import { describe, expect, it, vi } from "vitest";

import {
  acquireIndexerLock,
  INDEXER_ADVISORY_LOCK_ID,
  IndexerAlreadyRunningError,
  IndexerLockLostError,
  type AdvisoryLockClient,
} from "../lock.js";

function clientReturning(acquired: boolean): AdvisoryLockClient {
  return {
    query: vi.fn().mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes("pg_try_advisory_lock")
          ? { rows: [{ acquired }] }
          : { rows: [{ pg_advisory_unlock: true }] },
      ),
    ),
    release: vi.fn(),
  };
}

describe("acquireIndexerLock", () => {
  it("keeps a dedicated connection until the lock is released", async () => {
    const client = clientReturning(true);
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    const lock = await acquireIndexerLock(pool);

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [INDEXER_ADVISORY_LOCK_ID],
    );
    expect(client.release).not.toHaveBeenCalled();

    await lock.release();

    expect(client.query).toHaveBeenNthCalledWith(
      3,
      "SELECT pg_advisory_unlock($1::bigint)",
      [INDEXER_ADVISORY_LOCK_ID],
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("fails fast and returns the connection when another indexer holds the lock", async () => {
    const client = clientReturning(false);

    await expect(acquireIndexerLock({ connect: vi.fn().mockResolvedValue(client) })).rejects.toBeInstanceOf(
      IndexerAlreadyRunningError,
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns the connection when the acquisition query fails", async () => {
    const error = new Error("database unavailable");
    const client: AdvisoryLockClient = {
      query: vi.fn().mockImplementation((sql: string) =>
        sql.includes("pg_try_advisory_lock")
          ? Promise.reject(error)
          : Promise.resolve({ rows: [] }),
      ),
      release: vi.fn(),
    };

    await expect(acquireIndexerLock({ connect: vi.fn().mockResolvedValue(client) })).rejects.toBe(error);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("releases the advisory lock only once", async () => {
    const client = clientReturning(true);
    const lock = await acquireIndexerLock({ connect: vi.fn().mockResolvedValue(client) });

    await lock.release();
    await lock.release();

    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("verifies and renews the session lock on a heartbeat", async () => {
    vi.useFakeTimers();
    const client: AdvisoryLockClient = {
      query: vi.fn().mockImplementation((sql: string) =>
        Promise.resolve({
          rows: sql.includes("pg_try_advisory_lock")
            ? [{ acquired: true }]
            : [{ pg_advisory_unlock: true }],
        }),
      ),
      release: vi.fn(),
    };
    const lock = await acquireIndexerLock(
      { connect: vi.fn().mockResolvedValue(client) },
      INDEXER_ADVISORY_LOCK_ID,
      { heartbeatIntervalMs: 100 },
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(client.query).toHaveBeenCalledTimes(4);
    expect(lock.isHeld()).toBe(true);
    await lock.release();
    expect(client.release).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("marks the lock lost and destroys its connection when verification fails", async () => {
    vi.useFakeTimers();
    let tryCount = 0;
    const client: AdvisoryLockClient = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) {
          tryCount += 1;
          return Promise.resolve({ rows: [{ acquired: tryCount === 1 }] });
        }
        return Promise.resolve({ rows: [{ pg_advisory_unlock: true }] });
      }),
      release: vi.fn(),
    };
    const onLost = vi.fn();
    const lock = await acquireIndexerLock(
      { connect: vi.fn().mockResolvedValue(client) },
      INDEXER_ADVISORY_LOCK_ID,
      { heartbeatIntervalMs: 100, onLost },
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(lock.isHeld()).toBe(false);
    expect(onLost).toHaveBeenCalledWith(expect.any(IndexerLockLostError));
    expect(client.release).toHaveBeenCalledWith(true);
    await lock.release();
    expect(client.release).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
