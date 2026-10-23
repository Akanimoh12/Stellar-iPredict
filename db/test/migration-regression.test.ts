import fs from "node:fs";
import { LEGACY_MIGRATION_GROUPS, REDUNDANT_MIGRATIONS } from "../migration-names.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TEST_DATABASE_URL, normalizeSchemaDump } from "./schema-drift.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const SCRATCH_SCHEMA = "migration_regression_check";

/**
 * Down migrations that cannot restore the previous schema byte-for-byte.
 *
 * The exact-schema comparison in the suite is still enforced for every other
 * down migration, so a new one that silently fails to revert its up migration
 * is still caught. These are listed explicitly, with the reason, so each
 * exception has to be argued for rather than discovered. Every entry still has
 * to run without error and its up migration still has to re-apply cleanly.
 */
const PARTIAL_DOWN_MIGRATIONS: Readonly<Record<string, string>> = {
  // 0009 declares total_bond as the 8th column. Converting it to a generated
  // column requires DROP + ADD, and a re-added column always lands last, so the
  // original position cannot be restored by any ALTER TABLE. Nothing else about
  // the column differs.
  "0015_oracle_disputes_total_bond_generated":
    "re-adding total_bond moves it to the end of the column order",
  // The file states that the archive_old_events() repair is deliberately not
  // reverted, because restoring the 0013 version would reintroduce its bug.
  "0018_data_retention": "keeps the repaired archive_old_events() on purpose",
  // The file states that the indexes and NOT NULL are deliberately left in
  // place: removing them would be worse than the pre-0026 runtime DDL state.
  "0026_dead_letter_events_timestamptz":
    "intentionally leaves the table, indexes and NOT NULL in place",
};

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

function dumpSchema(url: string, schema: string): string {
  const result = spawnSync(
    "pg_dump",
    ["-d", url, "--schema-only", `--schema=${schema}`, "--no-owner", "--no-acl"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`pg_dump failed: ${result.stderr || result.error?.message || "unknown error"}`);
  }
  return normalizeSchemaDump(result.stdout);
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
    const url = dbUrl();
    for (const file of upMigrations()) {
      // The migration runner skips these on a fresh database (their DDL is
      // already applied by the canonical migration), so replaying them here
      // would test a code path no deployment takes — and their down migrations
      // drop objects the canonical migration created.
      if (REDUNDANT_MIGRATIONS[file]) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      try {
        const downFile = `${file.replace(/\.sql$/, "")}.down.sql`;
        const downPath = path.join(MIGRATIONS_DIR, downFile);
        const before = fs.existsSync(downPath) ? dumpSchema(url, SCRATCH_SCHEMA) : null;
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("COMMIT");

        if (before !== null) {
          await client.query("BEGIN");
          await client.query(fs.readFileSync(downPath, "utf8"));
          await client.query("COMMIT");
          if (!PARTIAL_DOWN_MIGRATIONS[file.replace(/\.sql$/, "")]) {
            expect(dumpSchema(url, SCRATCH_SCHEMA), `${downFile} must restore the schema from before ${file}`).toBe(before);
          }

          await client.query("BEGIN");
          await client.query(sql);
          await client.query("COMMIT");
        }
      } catch (err) {
        await client.query("ROLLBACK");
        failures.push(`${file}: ${(err as Error).message}`);
      }
    }
    expect(failures, `Migrations failed to execute:\n${failures.join("\n")}`).toEqual([]);
    // Applying every migration, each with up to two pg_dump comparisons, does
    // not fit in vitest's 5s default. The time is spent in Postgres, not in a
    // hang, so the budget is explicit rather than silently tripped.
  }, 180_000);

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

  it("rejects invalid bet amounts and oracle submission values", async (ctx) => {
    if (!client) return ctx.skip();

    await client.query(`
      INSERT INTO markets (id, question, category, end_time, creator)
      VALUES (899999, 'constraint fixture', 'other', 2000000000, rpad('G', 56, 'A'))
    `);

    const invalidBets = [
      [899999, "G" + "A".repeat(54) + "1", -1, 1],
      [899999, "G" + "A".repeat(54) + "2", 2, 1],
      [899999, "G" + "A".repeat(54) + "3", 1, -1],
    ] as const;
    for (const [marketId, bettor, netAmount, grossAmount] of invalidBets) {
      await expect(
        client.query(
          `INSERT INTO bets (market_id, bettor, net_amount, gross_amount, is_yes)
           VALUES ($1, $2, $3, $4, TRUE)`,
          [marketId, bettor, netAmount, grossAmount],
        ),
      ).rejects.toThrow();
    }

    const validAddress = "G" + "A".repeat(55);
    await expect(
      client.query(
        `INSERT INTO oracle_submissions (market_id, submitter, outcome, bond_amount)
         VALUES (899999, $1, 'YES', -1)`,
        [validAddress],
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `INSERT INTO oracle_submissions (market_id, submitter, outcome, bond_amount, submitted_at)
         VALUES (899999, $1, 'YES', 0, NULL)`,
        [validAddress],
      ),
    ).rejects.toThrow();
  });

  it("uses the bettor, market, and claimed indexes for realistic selective lookups", async (ctx) => {
    if (!client) return ctx.skip();

    await client.query(`
      INSERT INTO markets (id, question, category, end_time, creator)
      SELECT 900000 + market_no, 'index-plan fixture', 'other', 2000000000,
             rpad('G' || market_no::text, 56, 'A')
      FROM generate_series(1, 100) AS market_no
    `);
    await client.query(`
      INSERT INTO bets (market_id, bettor, net_amount, gross_amount, is_yes, claimed, created_at)
      SELECT 900000 + market_no,
             rpad('G' || lpad(bettor_no::text, 55, 'A'), 56, 'A'),
             1, 1, TRUE, bettor_no % 100 = 0,
             NOW() - (market_no * 500 + bettor_no) * INTERVAL '1 second'
      FROM generate_series(1, 100) AS market_no
      CROSS JOIN generate_series(1, 500) AS bettor_no
    `);
    await client.query("ANALYZE bets");

    const plans = await Promise.all([
      client.query<{ "QUERY PLAN": string }>(
        "EXPLAIN SELECT created_at FROM bets WHERE bettor = $1 ORDER BY created_at DESC",
        ["G" + "A".repeat(54) + "1"],
      ),
      client.query<{ "QUERY PLAN": string }>(
        "EXPLAIN SELECT created_at FROM bets WHERE market_id = $1 ORDER BY created_at DESC",
        [900001],
      ),
      client.query<{ "QUERY PLAN": string }>(
        "EXPLAIN SELECT created_at FROM bets WHERE claimed = TRUE ORDER BY created_at DESC",
      ),
    ]);

    expect(plans[0].rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain("idx_bets_bettor_created_at");
    expect(plans[1].rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain("idx_bets_market_created_at");
    expect(plans[2].rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain("idx_bets_claimed_created_at");
    // Builds a 100 x 500 bets fixture and ANALYZEs it before planning.
  }, 180_000);
});
