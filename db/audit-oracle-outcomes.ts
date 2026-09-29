/**
 * Audit `oracle_submissions.outcome` for non-canonical values (issue #650).
 *
 *   DATABASE_URL=postgres://... tsx db/audit-oracle-outcomes.ts
 *
 * Reports, without changing anything:
 *   - the distribution of every distinct raw `outcome` value,
 *   - which values migration 0017 will auto-map to 'YES' / 'NO',
 *   - which values it CANNOT map (these block the CHECK constraint and must
 *     be corrected or deleted by an operator first).
 *
 * Exits non-zero when an un-mappable value exists, so it can gate CI / a
 * pre-migration check.
 */
import { Client } from "pg";

const CANONICAL = new Set(["YES", "NO"]);
const YES_ALIASES = new Set(["yes", "y", "true", "1"]);
const NO_ALIASES = new Set(["no", "n", "false", "0"]);

function classify(raw: string | null): "canonical" | "maps-to-YES" | "maps-to-NO" | "UNMAPPABLE" {
  if (raw !== null && CANONICAL.has(raw)) return "canonical";
  const k = (raw ?? "").trim().toLowerCase();
  if (YES_ALIASES.has(k)) return "maps-to-YES";
  if (NO_ALIASES.has(k)) return "maps-to-NO";
  return "UNMAPPABLE";
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exit(2);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ outcome: string | null; n: string }>(
      `SELECT outcome, count(*)::text AS n
         FROM oracle_submissions
        GROUP BY outcome
        ORDER BY count(*) DESC`,
    );

    let total = 0;
    let unmappable = 0;
    const unmappableValues: Array<{ value: string | null; n: number }> = [];

    console.log("outcome value            | rows   | classification");
    console.log("-------------------------|--------|----------------");
    for (const r of rows) {
      const n = Number(r.n);
      total += n;
      const cls = classify(r.outcome);
      if (cls === "UNMAPPABLE") {
        unmappable += n;
        unmappableValues.push({ value: r.outcome, n });
      }
      const shown = r.outcome === null ? "<NULL>" : JSON.stringify(r.outcome);
      console.log(`${shown.padEnd(24)} | ${String(n).padStart(6)} | ${cls}`);
    }

    console.log(`\n${total} row(s) total; ${unmappable} row(s) with an un-mappable outcome.`);

    if (unmappable > 0) {
      console.error(
        "\nMigration 0017 will FAIL until these are resolved:\n" +
          unmappableValues
            .map((u) => `  ${JSON.stringify(u.value)} — ${u.n} row(s)`)
            .join("\n") +
          "\n\nFix each row (UPDATE to 'YES'/'NO') or delete the invalid submission, then re-run.",
      );
      process.exit(1);
    }
    console.log("OK — every existing outcome is canonical or auto-mappable.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("audit failed:", err);
  process.exit(1);
});
