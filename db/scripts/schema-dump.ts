import { regenerateSnapshot } from "../test/schema-drift.js";

/**
 * Regenerate the checked-in schema drift snapshot.
 *
 * Applies every migration to an isolated scratch schema, dumps it with
 * `pg_dump --schema-only`, normalises it, and writes the result to
 * `test/schema_drift.snapshot.sql`.
 *
 * Usage: `cd db && npm run schema:dump`
 *
 * Requires a reachable Postgres (uses TEST_DATABASE_URL / DATABASE_URL,
 * defaulting to the conventional local test database).
 */
async function main(): Promise<void> {
  await regenerateSnapshot();
  console.log("Schema snapshot regenerated.");
}

main().catch((err) => {
  console.error("Failed to regenerate schema snapshot:", err);
  process.exit(1);
});
