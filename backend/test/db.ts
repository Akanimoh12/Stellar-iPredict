/**
 * Ephemeral Postgres bootstrap for integration tests (issue #227).
 *
 * Instead of requiring a hand-created `ipredict_test` database, this helper
 * creates a throwaway database on whatever Postgres the test URL points at,
 * applies the same `db/migrations` the indexer and production use, and drops
 * the database again on teardown. Nothing persists — a fresh database per
 * bootstrap, deterministic and safe to run in parallel.
 *
 * If the Postgres server is not reachable the suite must gate itself on
 * {@link isPostgresServerAvailable} (mirroring `isTestDatabaseAvailable` in
 * setup.ts) so `npm test` still passes on a machine with no Postgres running.
 */

import { randomBytes } from "node:crypto";
import { Pool, type PoolConfig } from "pg";

import { getTestDatabaseUrl, runMigrations } from "./setup.js";

/** Maintenance database every server ships with, used to CREATE/DROP test DBs. */
const MAINTENANCE_DATABASE = "postgres";

export interface DatabaseServerInfo {
  host: string;
  port: number;
  user: string | undefined;
  password: string | undefined;
}

function parseDatabaseUrl(url: string): DatabaseServerInfo & { database: string } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  };
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function buildConnectionString(
  server: DatabaseServerInfo,
  database: string
): string {
  const auth = server.user
    ? `${encodeURIComponent(server.user)}:${encodeURIComponent(server.password ?? "")}`
    : "";
  return `postgres://${auth}@${server.host}:${server.port}/${database}`;
}

/** One-off admin pool on the maintenance database of the test server. */
function connectToServer(config: Partial<PoolConfig> = {}): Pool {
  const { host, port, user, password } = parseDatabaseUrl(getTestDatabaseUrl());
  return new Pool({
    host,
    port,
    user,
    password,
    database: MAINTENANCE_DATABASE,
    connectionTimeoutMillis: 2000,
    max: 1,
    ...config,
  });
}

let serverAvailability: Promise<boolean> | undefined;

/**
 * Whether the Postgres *server* the test URL points at is reachable right now.
 * Probes the `postgres` maintenance database (not the test database), so an
 * ephemeral bootstrap works even before `ipredict_test` has ever been created.
 *
 * Cached for the process lifetime; every `describe.skipIf` shares one probe.
 */
export function isPostgresServerAvailable(): Promise<boolean> {
  serverAvailability ??= (async () => {
    const admin = connectToServer();
    try {
      await admin.query("SELECT 1");
      return true;
    } catch {
      return false;
    } finally {
      await admin.end();
    }
  })();

  return serverAvailability;
}

/** A running ephemeral database, ready for queries and safe to close exactly once. */
export interface EphemeralPostgres {
  /** Pool connected to the ephemeral database. */
  pool: Pool;
  /** Fully-qualified connection string for the ephemeral database. */
  connectionString: string;
  /** Databases are named `ipredict_test_<hex>`, unique per bootstrap. */
  databaseName: string;
  /**
   * Ends the pool and drops the database. Idempotent — the database is only
   * ever dropped once.
   */
  close(): Promise<void>;
}

async function dropDatabase(databaseName: string): Promise<void> {
  const admin = connectToServer();
  try {
    // WITH (FORCE) terminates any lingering connections (pg >= 13); the compose
    // stack pins postgres:16. See infra/docker-compose.dev.yml.
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/**
 * Creates a uniquely-named ephemeral database, applies every migration, and
 * hands back a live pool. Call {@link EphemeralPostgres.close} to drop it.
 *
 * @throws If the server is unreachable or migrations fail; the database is
 *         still cleaned up so a failed bootstrap never leaves litter behind.
 */
export async function createEphemeralPostgres(): Promise<EphemeralPostgres> {
  const server = parseDatabaseUrl(getTestDatabaseUrl());
  const databaseName = `ipredict_test_${randomBytes(6).toString("hex")}`;

  const admin = connectToServer();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } finally {
    await admin.end();
  }

  const pool = new Pool({
    host: server.host,
    port: server.port,
    user: server.user,
    password: server.password,
    database: databaseName,
    max: 10,
  });

  try {
    await runMigrations(pool);
  } catch (error) {
    await pool.end();
    await dropDatabase(databaseName);
    throw error;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await pool.end();
    await dropDatabase(databaseName);
  };

  return {
    pool,
    connectionString: buildConnectionString(server, databaseName),
    databaseName,
    close,
  };
}