import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Falls back to the conventional local test database so `npm test` works
 * out of the box against the Postgres started by `infra/docker-compose.dev.yml`
 * — override with `TEST_DATABASE_URL` (or `DATABASE_URL`) to point elsewhere.
 */
const DEFAULT_TEST_DATABASE_URL =
  "postgres://ipredict:ipredict@localhost:5432/ipredict_test";

/** Same migrations the indexer and production DB run, applied in-place from disk. */
const MIGRATIONS_DIR = path.resolve(__dirname, "../../db/migrations");

/** Tables managed by db/migrations, ordered so TRUNCATE ... CASCADE never fights a FK. */
const MANAGED_TABLES = [
  "oracle_submissions",
  "events",
  "bets",
  "leaderboard",
  "markets",
] as const;

export function getTestDatabaseUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    DEFAULT_TEST_DATABASE_URL
  );
}

let availability: Promise<boolean> | undefined;

/**
 * Whether the configured test database is reachable right now. Cached for the
 * process lifetime so every integration file's `describe.skipIf` shares one
 * probe instead of opening a connection per suite.
 *
 * Integration suites gate on this instead of assuming Postgres is running —
 * there is no CI wired up yet (see CONTRIBUTING.md), so `npm test` must still
 * pass on a machine that never started `infra/docker-compose.dev.yml`.
 */
export function isTestDatabaseAvailable(): Promise<boolean> {
  availability ??= (async () => {
    const probe = new Pool({
      connectionString: getTestDatabaseUrl(),
      connectionTimeoutMillis: 1000,
      max: 1,
    });

    try {
      await probe.query("SELECT 1");
      return true;
    } catch {
      return false;
    } finally {
      await probe.end();
    }
  })();

  return availability;
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Applies every `db/migrations/*.sql` file not yet recorded in
 * `schema_migrations`, mirroring `db/migrate.ts` so the test DB ends up on
 * the exact same schema as dev/production.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  await ensureMigrationsTable(pool);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const { rows } = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [file]
    );
    if (rows.length > 0) {
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Empties every managed table so each test starts from a clean slate. */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE ${MANAGED_TABLES.join(", ")} RESTART IDENTITY CASCADE`
  );
}

/**
 * A client running inside a single PostgreSQL transaction that is rolled back
 * at the end of the test.
 *
 * The route code only ever calls `.query()`, so a wrapper with that one method is
 * enough to stand in for the real `Pool` — the integration tests exercise the
 * real schema, real migrations and real constraint enforcement without ever
 * committing a write. Rolling back one transaction per test is faster than
 * truncating five tables and guarantees no state leaks regardless of test order.
 */
export class TestTxn {
  private readonly client: PoolClient;
  private readonly release: () => void;
  private rolledBack = false;
  private savepointSeq = 0;

  private constructor(client: PoolClient, release: () => void) {
    this.client = client;
    this.release = release;
  }

  static async create(pool: Pool): Promise<TestTxn> {
    const client = await pool.connect();
    await client.query("BEGIN");
    return new TestTxn(client, () => client.release());
  }

  /**
   * Runs a query inside a nested SAVEPOINT so that expected failures — e.g. a
   * UNIQUE constraint violation exercised by the duplicate-submission test —
   * roll back to the savepoint instead of aborting the whole transaction.
   * Without this, Postgres poisons the transaction after any error and every
   * subsequent assertion query fails with "transaction is aborted".
   */
  async query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    const sp = `test_txn_sp_${this.savepointSeq++}`;
    await this.client.query(`SAVEPOINT ${sp}`);
    try {
      const result = await this.client.query(text, values);
      await this.client.query(`RELEASE SAVEPOINT ${sp}`);
      return { rows: result.rows as T[] };
    } catch (err) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      await this.client.query(`RELEASE SAVEPOINT ${sp}`);
      throw err;
    }
  }

  /** Ends the test by rolling back the transaction so nothing is persisted. */
  async rollback(): Promise<void> {
    if (this.rolledBack) return;
    this.rolledBack = true;
    try {
      await this.client.query("ROLLBACK");
    } finally {
      this.release();
    }
  }
}

export interface TxnTestApp {
  server: FastifyInstance;
  pool: Pool;
  txn: TestTxn;
}

/**
 * Boots the real app and wraps every request in a fresh transaction that is
 * rolled back on {@link closeTxnTestApp}. Mirrors {@link createTestApp} but with
 * transactional rollback instead of truncation — the recommended approach for
 * integration tests that must run in any order without manual cleanup.
 */
export async function createTxnTestApp(): Promise<TxnTestApp> {
  const pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await runMigrations(pool);
  const txn = await TestTxn.create(pool);

  const server = buildServer({ pool: txn as unknown as Pool, corsOrigins: [] });
  await server.ready();

  return { server, pool, txn };
}

export async function closeTxnTestApp(app: TxnTestApp): Promise<void> {
  await app.server.close();
  await app.txn.rollback();
  await app.pool.end();
}

export interface TestApp {
  server: FastifyInstance;
  pool: Pool;
}

/**
 * Boots the real app — the same `buildServer` the production entrypoint
 * uses, wired to a real `pg.Pool` — against the migrated test database. No
 * mocked query layer: this is what makes these integration tests instead of
 * the unit tests already covering each route with a stubbed `Queryable`.
 */
export async function createTestApp(): Promise<TestApp> {
  const pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await runMigrations(pool);

  const server = buildServer({ pool, corsOrigins: [] });
  await server.ready();

  return { server, pool };
}

export async function closeTestApp({ server, pool }: TestApp): Promise<void> {
  await server.close();
  await pool.end();
}
