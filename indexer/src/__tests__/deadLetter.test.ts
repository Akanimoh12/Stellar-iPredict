import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

describe("deadLetter", () => {
  it("dead_letter_events table is defined in a migration, not in application code", () => {
    // Issue #495: the table must be owned by the migration runner.
    // This test fails if the migration file is removed or renamed,
    // keeping the schema visible and auditable.
    const __dirname = fileURLToPath(new URL(".", import.meta.url));
    const migrationPath = resolve(
      __dirname,
      "../../../../db/migrations/0026_dead_letter_events_timestamptz.sql"
    );
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS dead_letter_events");
    expect(sql).toContain("TIMESTAMPTZ");
    expect(sql).toContain("idx_dead_letter_events_ledger");
    expect(sql).toContain("idx_dead_letter_events_created_at");
  });
});
