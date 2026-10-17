import fs from "node:fs";
import { LEGACY_MIGRATION_GROUPS } from "./migration-names.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TEST_DATABASE_URL } from "./schema-drift.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const SCRATCH_SCHEMA = "migration_regression_check";

function dbUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    DEFAULT_TEST_DATABASE_URL
  );
}

function upMigrations(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort();
}

function prefixOf(file: string): string {
  const match = file.match(/^(\d{4})_/);
  if (!match) throw new Error(`"${file}" must start with a four digit prefix (NNNN_name.sql)`);
  return match[1];
}

/** Migrations whose comments explicitly claim to be safe to run repeatedly. */
function claimsIdempotency(file: string): boolean {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
  return sql
    .split("\n")
    .filter((line) => line.trim().startsWith("--"))
    .some((line) => /\bidempotent\b/i.test(line) && !/\bnot\s+idempotent\b/i.test(line));
}

describe("migration numbering (static)", () => {
  const files = upMigrations();

  it("every migration has a four digit prefix", () => {
    for (const f of files) expect(() => prefixOf(f)).not.toThrow();
  });

  it("does not introduce new duplicate numbers beyond the frozen legacy set", () => {
    const byPrefix = new Map<string, string[]>();
    for (const f of files) {
      const p = prefixOf(f);
      byPrefix.set(p, [...(byPrefix.get(p) ?? []), f]);
    }
    const newDuplicates = [...byPrefix.entries()]
      .filter(([p, list]) => list.length > 1 && JSON.stringify([...list].sort()) !== JSON.stringify(LEGACY_MIGRATION_GROUPS[p] ?? []))
      .map(([p, list]) => `${p}: ${list.join(", ")}`);
    expect(newDuplicates, `Duplicate migration number(s):\n${newDuplicates.join("\n")}`).toEqual([]);
  });

  it("numbers are sequential with no gaps", () => {
    const numbers = [...new Set(files.map((f) => Number(prefixOf(f))))].sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < numbers.length; i++) {
      for (let n = numbers[i - 1] + 1; n < numbers[i]; n++) gaps.push(n);
    }
    expect(numbers[0]).toBe(1);
    expect(gaps, `Missing migration number(s): ${gaps.join(", ")}`).toEqual([]);
  });

  it("every down migration has a matching up migration", () => {
    const ups = new Set(files.map((f) => f.replace(/\.sql$/, "")));
    const orphans = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".down.sql"))
      .filter((f) => !ups.has(f.replace(/\.down\.sql$/, "")));
    expect(orphans).toEqual([]);
  });

  it("never uses IF NOT EXISTS on statements PostgreSQL does not support it for", () => {
    // Plausible-looking but invalid: parsers that only check shape accept
    // these, so guard the known offenders textually as a fast first line.
    const invalid = [
      /CREATE\s+TYPE\s+IF\s+NOT\s+EXISTS/i,
      /ADD\s+CONSTRAINT\s+IF\s+NOT\s+EXISTS/i,
      /CREATE\s+POLICY\s+IF\s+NOT\s+EXISTS/i,
      /CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS/i,
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      // Ignore commentary that merely mentions the pattern.
      const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      if (invalid.some((re) => re.test(code))) offenders.push(f);
    }
    expect(offenders, `Invalid IF NOT EXISTS usage in: ${offenders.join(", ")}`).toEqual([]);
  });
});

// In CI the database is mandatory: a skipped suite must not read as a pass.
const requireDb = process.env.REQUIRE_DB === "1" || process.env.CI === "true";

let client: Client | undefined;
let dbReachable = false;

beforeAll(async () => {
  const probe = new Client({ connectionString: dbUrl() });
  try {
    await probe.connect();
    await probe.query("SELECT 1");
    client = probe;
    dbReachable = true;
    await client.query(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCRATCH_SCHEMA}`);
    await client.query(`SET search_path TO ${SCRATCH_SCHEMA}, public`);
  } catch {
    await probe.end().catch(() => undefined);
    client = undefined;
  }
});

afterAll(async () => {
  if (client) {
    await client.query(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`);
    await client.end();
  }
});

describe("migrations executed against real Postgres", () => {
  it("has a reachable database when one is required", () => {
    if (requireDb) expect(dbReachable, "Postgres is required in CI but unreachable").toBe(true);
  });

  it("applies every migration in order without SQL errors", async (ctx) => {
    if (!client) return ctx.skip();
    const failures: string[] = [];
    for (const file of upMigrations()) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        failures.push(`${file}: ${(err as Error).message}`);
      }
    }
    expect(failures, `Migrations failed to execute:\n${failures.join("\n")}`).toEqual([]);
  });

  it("migrations that claim idempotency can be applied a second time", async (ctx) => {
    if (!client) return ctx.skip();
    const claimed = upMigrations().filter(claimsIdempotency);
    expect(claimed.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const file of claimed) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        failures.push(`${file}: ${(err as Error).message}`);
      }
    }
    expect(failures, `Claimed-idempotent migrations failed on re-run:\n${failures.join("\n")}`).toEqual([]);
  });
});
