import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { runMigrations } from '../migrate.js';
import type { Client } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

// A small, stable, already-existing migration to exercise the checksum
// paths against real file bytes rather than a hardcoded hash.
const TARGET_FILE = '0001_create_markets.sql';

function checksumOf(filename: string): string {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * A mock pg Client whose `schema_migrations` row for TARGET_FILE carries
 * `storedChecksum`, and which records every query for assertions. Every
 * other migration file is reported as already-applied with a matching
 * checksum, so only TARGET_FILE's path is exercised.
 */
function createMockClient(storedChecksum: string | null) {
  const queries: { sql: string; params?: unknown[] }[] = [];

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });

      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ pg_try_advisory_lock: true }] };
      }
      if (sql.includes('SELECT checksum FROM schema_migrations')) {
        const filename = params?.[0];
        if (filename === TARGET_FILE) {
          return { rowCount: 1, rows: [{ checksum: storedChecksum }] };
        }
        // Every other file: already applied with a checksum that will
        // match whatever is computed for it, so only TARGET_FILE's
        // handling is under test.
        return { rowCount: 1, rows: [{ checksum: checksumOf(filename as string) }] };
      }
      return { rowCount: 0, rows: [] };
    }),
  } as unknown as Client;

  return { client, queries };
}

describe('migration checksums (#406)', () => {
  it('fails with the filename in the message when an applied migration was edited', async () => {
    const { client } = createMockClient('0'.repeat(64)); // deliberately wrong

    await expect(runMigrations(client)).rejects.toThrow(TARGET_FILE);
    await expect(runMigrations(client)).rejects.toThrow(/checksum mismatch/i);
  });

  it('skips an unmodified migration with no warning', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { client } = createMockClient(checksumOf(TARGET_FILE));

    await runMigrations(client);

    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(`Skipping ${TARGET_FILE} (already applied)`);

    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it('backfills a NULL checksum on an existing row without crashing', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { client, queries } = createMockClient(null);

    await expect(runMigrations(client)).resolves.toBeUndefined();

    const backfill = queries.find(
      (q) => q.sql.includes('UPDATE schema_migrations SET checksum') && q.params?.[1] === TARGET_FILE,
    );
    expect(backfill).toBeDefined();
    expect(backfill?.params?.[0]).toBe(checksumOf(TARGET_FILE));
    expect(consoleLogSpy).toHaveBeenCalledWith(`Skipping ${TARGET_FILE} (already applied; backfilling checksum)`);

    consoleLogSpy.mockRestore();
  });

  it('requires the escape hatch to be explicit — a mismatch still fails without it', async () => {
    const { client } = createMockClient('0'.repeat(64));

    // No options passed at all: must behave the same as options.allowChecksumUpdate === false.
    await expect(runMigrations(client)).rejects.toThrow(TARGET_FILE);
  });

  it('accepts an edited migration only when --allow-checksum-update is passed explicitly', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, queries } = createMockClient('0'.repeat(64));

    await expect(
      runMigrations(client, { allowChecksumUpdate: true }),
    ).resolves.toBeUndefined();

    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining(TARGET_FILE));

    const update = queries.find(
      (q) => q.sql.includes('UPDATE schema_migrations SET checksum') && q.params?.[1] === TARGET_FILE,
    );
    expect(update?.params?.[0]).toBe(checksumOf(TARGET_FILE));

    consoleWarnSpy.mockRestore();
  });
});
