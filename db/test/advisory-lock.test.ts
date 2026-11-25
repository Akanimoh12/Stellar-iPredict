import { describe, expect, it, vi } from 'vitest';
import { runMigrations, MIGRATION_ADVISORY_LOCK_KEY } from '../migrate.js';
import type { Client } from 'pg';

describe('Migration Advisory Lock & Concurrent Runners', () => {
  it('acquires and releases advisory lock during runMigrations', async () => {
    const executedQueries: string[] = [];

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        executedQueries.push(sql);
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ pg_try_advisory_lock: true }] };
        }
        if (sql.includes('schema_migrations')) {
          return { rowCount: 1, rows: [{ filename: '0001_create_markets.sql' }] };
        }
        return { rowCount: 0, rows: [] };
      }),
    } as unknown as Client;

    await runMigrations(mockClient);

    expect(mockClient.query).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_lock($1::bigint)',
      [MIGRATION_ADVISORY_LOCK_KEY]
    );

    expect(mockClient.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1::bigint)',
      [MIGRATION_ADVISORY_LOCK_KEY]
    );
  });

  it('logs waiting message when advisory lock is held by another process', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let tryLockCalls = 0;

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) {
          tryLockCalls++;
          return { rows: [{ pg_try_advisory_lock: false }] };
        }
        if (sql.includes('pg_advisory_lock')) {
          return { rows: [] };
        }
        if (sql.includes('schema_migrations')) {
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }),
    } as unknown as Client;

    await runMigrations(mockClient);

    expect(tryLockCalls).toBe(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Migration lock is currently held by another process. Waiting for lock release...'
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_lock($1::bigint)',
      [MIGRATION_ADVISORY_LOCK_KEY]
    );

    consoleLogSpy.mockRestore();
  });
});
