import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import {
  isDbAvailable,
  dumpMigratedSchema,
  readSnapshot,
} from "./schema-drift.js";

// Resolved once at collection time so `describe.skipIf` can gate the suite on
// a reachable Postgres — see schema-drift.ts for why this must skip, not throw,
// when no local database is running (no CI is wired up yet).
const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)("Integration: schema drift check", () => {
  it("applies every migration and matches the checked-in schema snapshot", async () => {
    const expected = readSnapshot().trim();

    // Apply every migration to a fresh scratch schema and dump it.
    const actual = (await dumpMigratedSchema()).trim();

    if (expected === actual) {
      return;
    }

    // Produce a readable table/column-level diff like `git diff`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-drift-"));
    const expectedPath = path.join(dir, "expected.sql");
    const actualPath = path.join(dir, "actual.sql");
    fs.writeFileSync(expectedPath, `${expected}\n`);
    fs.writeFileSync(actualPath, `${actual}\n`);

    const diff = spawnSync("diff", ["-u", expectedPath, actualPath], {
      encoding: "utf8",
    });
    fs.rmSync(dir, { recursive: true, force: true });

    const diffBody =
      diff.status === 0 || diff.error
        ? ""
        : `\n${diff.stdout || diff.stderr}`;

    throw new Error(
      [
        "Schema drift detected: the migrated schema no longer matches the",
        "checked-in snapshot (test/schema_drift.snapshot.sql).",
        "",
        "Did you add or edit a migration? Regenerate the snapshot with:",
        "  cd db && npm run schema:dump",
        "",
        `Diff of expected vs actual (normalised pg_dump --schema-only):`,
        diffBody,
      ].join("\n"),
    );
  });
});
