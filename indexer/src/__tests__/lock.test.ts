import { describe, expect, it, vi } from "vitest";

import {
  acquireIndexerLock,
  INDEXER_ADVISORY_LOCK_ID,
  IndexerAlreadyRunningError,
  type AdvisoryLockClient,
} from "../lock.js";

function clientReturning(acquired: boolean): AdvisoryLockClient {
  return {
    query: vi.fn().mockResolvedValueOnce({ rows: [{ acquired }] }).mockResolvedValue({ rows: [{ pg_advisory_unlock: true }] }),
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
      1,
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [INDEXER_ADVISORY_LOCK_ID],
    );
    expect(client.release).not.toHaveBeenCalled();

    await lock.release();

    expect(client.query).toHaveBeenNthCalledWith(
      2,
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
    const client: AdvisoryLockClient = { query: vi.fn().mockRejectedValue(error), release: vi.fn() };

    await expect(acquireIndexerLock({ connect: vi.fn().mockResolvedValue(client) })).rejects.toBe(error);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("releases the advisory lock only once", async () => {
    const client = clientReturning(true);
    const lock = await acquireIndexerLock({ connect: vi.fn().mockResolvedValue(client) });

    await lock.release();
    await lock.release();

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledOnce();
  });
});

