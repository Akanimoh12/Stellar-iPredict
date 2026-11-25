import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set. Set it to your Postgres connection string.');
    process.exit(1);
  }
  return url;
}

/**
 * The most recently applied migration — the one whose row we'll revert.
 */
async function getLastAppliedMigration(client: Client): Promise<string | null> {
  const res = await client.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations ORDER BY applied_at DESC LIMIT 1',
  );
  return res.rows.length > 0 ? res.rows[0].filename : null;
}

/**
 * Find the down-script for a given up-migration filename.
 * Convention: for `NNNN_name.sql` the down script is `NNNN_name.down.sql`.
 *
 * Returns the SQL text, or null if no down-script exists.
 */
function readDownMigration(filename: string): string | null {
  // e.g. "0006_oracle_submissions.sql" -> "0006_oracle_submissions.down.sql"
  const baseName = filename.replace(/\.sql$/, '');
  const downFile = `${baseName}.down.sql`;
  const fullPath = path.join(MIGRATIONS_DIR, downFile);

  if (!fs.existsSync(fullPath)) {
    return null;
  }

  return fs.readFileSync(fullPath, 'utf8');
}

async function run() {
  const dbUrl = getDatabaseUrl();
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    // 1. Determine the migration to revert
    const lastMigration = await getLastAppliedMigration(client);
    if (!lastMigration) {
      console.log('No migrations have been applied — nothing to revert.');
      return;
    }

    console.log(`Reverting ${lastMigration}...`);

    // 2. Locate the down-script
    const downSql = readDownMigration(lastMigration);
    if (downSql === null) {
      console.error(
        `Cannot revert ${lastMigration}: no down-migration script found. ` +
        `Expected a file named ${lastMigration.replace(/\.sql$/, '')}.down.sql ` +
        `in ${MIGRATIONS_DIR}.`,
      );
      process.exit(1);
    }

    // 3. Run the down-migration inside a single transaction
    try {
      await client.query('BEGIN');
      await client.query(downSql);
      await client.query('DELETE FROM schema_migrations WHERE filename = $1', [lastMigration]);
      await client.query('COMMIT');
      console.log(`Reverted ${lastMigration}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`Failed to revert ${lastMigration}:`, err);
      process.exit(1);
    }
  } finally {
    await client.end();
  }
}

run().catch(err => {
  console.error('Migration rollback failed:', err);
  process.exit(1);
});