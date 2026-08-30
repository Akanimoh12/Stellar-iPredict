import fs from 'fs';
import path from 'path';
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
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function alreadyApplied(client: Client, filename: string): Promise<boolean> {
  const res = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename]);
  return (res.rowCount ?? 0) > 0;
}

async function applyMigration(client: Client, filename: string, sql: string) {
  console.log(`Applying ${filename}...`);
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [filename]);
    await client.query('COMMIT');
    console.log(`Applied ${filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export async function runMigrations(client: Client): Promise<void> {
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
      const applied = await alreadyApplied(client, file);
      if (applied) {
        console.log(`Skipping ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(fullPath, 'utf8');
      await applyMigration(client, file, sql);
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
  try {
    await runMigrations(client);
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
