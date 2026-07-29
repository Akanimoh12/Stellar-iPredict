import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

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
  return res.rowCount > 0;
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

async function run() {
  const dbUrl = getDatabaseUrl();
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await ensureMigrationsTable(client);

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
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
    await client.end();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
