import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Client } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

/**
 * Constant key for session-level PostgreSQL advisory locking.
 * Prevents concurrent migration runners from applying DDL simultaneously.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = "8574639201";

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set. Set it to your Postgres connection string.');
    process.exit(1);
  }
  return url;
}

async function ensureMigrationsTable(client: Client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum TEXT
    )
  `);
  // A deployment that created this table before the checksum column existed
  // upgrades in place here, rather than needing its own numbered migration
  // for the runner's own bookkeeping table.
  await client.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`);
}

/**
 * SHA-256 of the raw migration file bytes, hex-encoded (#406).
 */
function computeChecksum(sql: string): string {
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

async function getAppliedRecord(
  client: Client,
  filename: string,
): Promise<{ checksum: string | null } | null> {
  const res = await client.query<{ checksum: string | null }>(
    'SELECT checksum FROM schema_migrations WHERE filename = $1',
    [filename],
  );
  return res.rows[0] ?? null;
}

async function recordChecksum(client: Client, filename: string, checksum: string) {
  await client.query('UPDATE schema_migrations SET checksum = $1 WHERE filename = $2', [checksum, filename]);
}

async function applyMigration(client: Client, filename: string, sql: string, checksum: string) {
  console.log(`Applying ${filename}...`);
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(filename, checksum) VALUES($1, $2)', [filename, checksum]);
    await client.query('COMMIT');
    console.log(`Applied ${filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export interface RunMigrationsOptions {
  /**
   * Accept and record a changed checksum for an already-applied migration
   * instead of failing (#406) -- the escape hatch for an intentional edit
   * (e.g. a comment-only fix that doesn't change the deployed schema).
   * Requires the caller to explicitly opt in; never pass this reflexively
   * just to make a checksum-mismatch failure go away, since that's exactly
   * the case the check exists to catch.
   */
  allowChecksumUpdate?: boolean;
}

export async function runMigrations(
  client: Client,
  options: RunMigrationsOptions = {},
): Promise<void> {
  let lockAcquired = false;

  try {
    // Attempt non-blocking lock first to log if another process holds it
    const tryLockRes = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint)',
      [MIGRATION_ADVISORY_LOCK_KEY]
    );

    lockAcquired = tryLockRes.rows[0]?.pg_try_advisory_lock ?? false;

    if (!lockAcquired) {
      console.log('Migration lock is currently held by another process. Waiting for lock release...');
      await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
      lockAcquired = true;
    }

    console.log('Acquired migration advisory lock.');

    await ensureMigrationsTable(client);

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort();

    for (const file of files) {
      const fullPath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(fullPath, 'utf8');
      const checksum = computeChecksum(sql);

      const applied = await getAppliedRecord(client, file);
      if (applied) {
        if (applied.checksum == null) {
          // Pre-checksum row (#406): trust it once and backfill the
          // checksum now, rather than failing on every row that predates
          // this feature. Drift is caught from this run onward.
          await recordChecksum(client, file, checksum);
          console.log(`Skipping ${file} (already applied; backfilling checksum)`);
        } else if (applied.checksum !== checksum) {
          if (options.allowChecksumUpdate) {
            console.warn(
              `Checksum for ${file} changed since it was applied; accepting the new checksum ` +
              `(--allow-checksum-update).`
            );
            await recordChecksum(client, file, checksum);
          } else {
            throw new Error(
              `Migration checksum mismatch for ${file}: its contents have changed since it was ` +
              `applied, so this file no longer describes the deployed schema. If the edit was ` +
              `intentional (e.g. a comment-only change with no effect on already-migrated ` +
              `databases), rerun with --allow-checksum-update to accept the new checksum. ` +
              `Otherwise, restore the file's original contents.`
            );
          }
        } else {
          console.log(`Skipping ${file} (already applied)`);
        }
        continue;
      }

      await applyMigration(client, file, sql, checksum);
    }

    console.log('Migrations complete');
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
        console.log('Released migration advisory lock.');
      } catch {
        // Ignored if connection was already closed
      }
    }
  }
}

async function run() {
  const dbUrl = getDatabaseUrl();
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const allowChecksumUpdate = process.argv.includes('--allow-checksum-update');
  try {
    await runMigrations(client, { allowChecksumUpdate });
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith('migrate.ts')) {
  run().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
