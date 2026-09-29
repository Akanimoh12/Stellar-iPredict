import type { Pool, PoolClient } from "pg";

/**
 * Creates a minimal mock PostgreSQL Pool for unit tests where buildServer requires a pool (issue #471).
 */
export function createFakePool(
  queryFn: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> = async () => ({ rows: [] }),
): Pool {
  const fakeClient = {
    query: queryFn,
    release: () => {},
  } as unknown as PoolClient;

  return {
    query: queryFn,
    connect: async () => fakeClient,
    on: () => {},
    end: async () => {},
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
  } as unknown as Pool;
}
