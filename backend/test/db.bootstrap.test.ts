/**
 * Deterministic tests for the ephemeral Postgres bootstrap (issue #227).
 *
 * Gates on physical server availability so `npm test` stays deterministic on a
 * machine with no Postgres running — the whole suite skips rather than flakes.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import {
  createEphemeralPostgres,
  isPostgresServerAvailable,
  type EphemeralPostgres,
} from "./db.js";

const serverAvailable = await isPostgresServerAvailable();

describe.skipIf(!serverAvailable)("ephemeral Postgres bootstrap", () => {
  let db: EphemeralPostgres;

  beforeAll(async () => {
    db = await createEphemeralPostgres();
  });

  afterAll(async () => {
    await db.close();
  });

  it("probes server availability without throwing", () => {
    expect(typeof serverAvailable).toBe("boolean");
  });

  it("boots a uniquely-named ephemeral database", () => {
    expect(db.databaseName).toMatch(/^ipredict_test_[a-f0-9]{12}$/);
    // Falls back to the same server as the test-tagged URL, never a live DB.
    expect(db.connectionString).toContain(db.databaseName);
  });

  it("applies every migration from db/migrations", async () => {
    const { rows } = await db.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    const tables = rows.map((row) => row.tablename).sort();

    for (const expected of [
      "markets",
      "bets",
      "leaderboard",
      "events",
      "oracle_submissions",
      "council_votes",
      "oracle_disputes",
      "dead_letter_events",
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it("records every applied migration in schema_migrations", async () => {
    const { rows } = await db.pool.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename"
    );
    const applied = rows.map((row) => row.filename);

    for (const file of [
      "0001_create_markets.sql",
      "0006_oracle_submissions.sql",
      "0007_add_event_index_dedupe.sql",
      "0008_council_votes.sql",
      "0010_dead_letter_events.sql",
    ]) {
      expect(applied).toContain(file);
    }
  });

  it("supports inserts and reads through the pool", async () => {
    const creator = "G" + "A".repeat(55);

    await db.pool.query(
      `INSERT INTO markets (id, question, category, end_time, creator)
       VALUES ($1, $2, $3, $4, $5)`,
      [1, "Will XLM close above $1?", "Crypto", "1735689600", creator]
    );

    const { rows } = await db.pool.query<{ question: string }>(
      "SELECT question FROM markets WHERE id = $1",
      [1]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.question).toBe("Will XLM close above $1?");
  });

  it("produces an independent, empty database on each bootstrap", async () => {
    const second = await createEphemeralPostgres();
    try {
      expect(second.databaseName).not.toBe(db.databaseName);
      const { rows } = await second.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM markets"
      );
      expect(Number(rows[0]?.count ?? 0)).toBe(0);
    } finally {
      await second.close();
    }
  });

  it("is safe to re-run migrations against an already migrated database", async () => {
    // Imported lazily inside the describe block so the top-level doesn't pull
    // the full app in when the suite is skipped.
    const { runMigrations } = await import("./setup.js");
    await expect(runMigrations(db.pool)).resolves.toBeUndefined();

    const { rows } = await db.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM schema_migrations"
    );
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  it("drops the database when closed", async () => {
    const tmp = await createEphemeralPostgres();
    const name = tmp.databaseName;
    await tmp.close();

    const { rows } = await db.pool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [name]
    );
    expect(rows).toHaveLength(0);
  });
});