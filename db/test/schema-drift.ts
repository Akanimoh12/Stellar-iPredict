import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { runMigrations } from "../migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_TEST_DATABASE_URL =
  "postgres://ipredict:ipredict@localhost:5432/ipredict_test";

/** Scratch schema all migrations are applied into for the drift check. */
export const SCRATCH_SCHEMA = "schema_drift_check";

/** Checked-in expected schema snapshot. */
export const SNAPSHOT_PATH = path.resolve(__dirname, "schema_drift.snapshot.sql");

function getTestDbUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    DEFAULT_TEST_DATABASE_URL
  );
}

let availability: Promise<boolean> | undefined;

/**
 * Whether the configured test database is reachable right now. Cached for the
 * process lifetime and used to gate the drift suite with `describe.skipIf`, in
 * line with the backend integration tests — `npm test` must still pass on a
 * machine that never started a local Postgres (no CI is wired up yet).
 */
export function isDbAvailable(): Promise<boolean> {
  availability ??= (async () => {
    const probe = new Client({ connectionString: getTestDbUrl() });
    try {
      await probe.connect();
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

/**
 * Apply every up-migration in order into an isolated scratch schema and return
 * the normalised `pg_dump --schema-only` output for that schema.
 *
 * The migrations are the exact set/order `db/migrate.ts` runs in production
 * (via `runMigrations`), applied against a fresh `CREATE SCHEMA` so the shared
 * test database's `public` objects are never touched. The scratch schema is
 * dropped before and after the run.
 */
export async function dumpMigratedSchema(): Promise<string> {
  const url = getTestDbUrl();

  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    // Start from a clean slate so the scratch schema is never polluted by a
    // previously interrupted run.
    await client.query(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCRATCH_SCHEMA}`);
    await client.query(`SET search_path TO ${SCRATCH_SCHEMA}`);
    await runMigrations(client);
  } finally {
    await client.end();
  }

  // pg_dump runs as a separate process; capture its stdout. It emits no owner
  // or ACL statements, so the dump only reflects the schema's own DDL.
  const result = spawnSync(
    "pg_dump",
    [
      "-d",
      url,
      "--schema-only",
      `--schema=${SCRATCH_SCHEMA}`,
      "--no-owner",
      "--no-acl",
    ],
    { encoding: "utf8" },
  );

  // Always clean up the scratch schema, whether or not pg_dump succeeded.
  const cleanup = new Client({ connectionString: url });
  try {
    await cleanup.connect();
    await cleanup.query(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`);
  } finally {
    await cleanup.end();
  }

  if (result.status !== 0) {
    throw new Error(
      `pg_dump failed: ${result.stderr || result.error?.message || "unknown error"}`,
    );
  }

  return normalizeSchemaDump(result.stdout);
}

/**
 * Normalise a `pg_dump --schema-only` dump so it can be compared across runs:
 * drop the nondeterministic version/date header comments and collapse runs of
 * whitespace. Column lists, indexes, constraints and function bodies are kept
 * verbatim so a drift diff names the exact table/column that changed.
 */
export function normalizeSchemaDump(dump: string): string {
  return dump
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => {
      if (line.includes("PostgreSQL database dump")) return false;
      if (line.includes("Dumped from database version")) return false;
      if (line.includes("Dumped by pg_dump version")) return false;
      if (line.includes("Started on ")) return false;
      if (line.includes("Completed on ")) return false;
      return true;
    })
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .trim()
    .concat("\n");
}

/** Read the checked-in snapshot. */
export function readSnapshot(): string {
  return fs.readFileSync(SNAPSHOT_PATH, "utf8");
}

/** Write the regenerated snapshot from a fresh migrated schema. */
export async function regenerateSnapshot(): Promise<void> {
  const dump = await dumpMigratedSchema();
  fs.writeFileSync(SNAPSHOT_PATH, dump, "utf8");
}
