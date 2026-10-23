import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getReadPool,
  getPrimaryPool,
  isReadOnlyQuery,
  isReplicaConfigured,
  markWrite,
  resetReadAfterWriteState,
  runWithReadSession,
  shouldReadFromPrimary,
  shutdown,
} from "./pool.js";

const READ_URL_ENV_VARS = [
  "DATABASE_READ_URL",
  "READ_DATABASE_URL",
  "DATABASE_REPLICA_URL",
] as const;

const originalEnv = Object.fromEntries(
  READ_URL_ENV_VARS.map((name) => [name, process.env[name]]),
) as Record<(typeof READ_URL_ENV_VARS)[number], string | undefined>;

function clearReadUrlEnv(): void {
  for (const name of READ_URL_ENV_VARS) {
    delete process.env[name];
  }
}

beforeEach(() => {
  clearReadUrlEnv();
  resetReadAfterWriteState();
});

afterEach(() => {
  for (const name of READ_URL_ENV_VARS) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetReadAfterWriteState();
});

afterAll(async () => {
  await shutdown();
});

describe("read replica configuration", () => {
  it("is disabled when no read URL is configured", () => {
    expect(isReplicaConfigured()).toBe(false);
  });

  it("falls back to the primary pool when no replica is configured", () => {
    expect(getReadPool()).toBe(getPrimaryPool());
  });

  it.each(READ_URL_ENV_VARS)("recognises the %s alias", (name) => {
    process.env[name] = "postgres://replica.example:5432/ipredict";
    expect(isReplicaConfigured()).toBe(true);
  });

  it("treats a blank read URL as unconfigured", () => {
    process.env.DATABASE_READ_URL = "   ";
    expect(isReplicaConfigured()).toBe(false);
    expect(getReadPool()).toBe(getPrimaryPool());
  });
});

describe("read-after-write routing", () => {
  it("uses replicas before a session has written", () => {
    runWithReadSession(() => {
      expect(shouldReadFromPrimary()).toBe(false);
    });
  });

  it("pins every read in a session to the primary after a write", () => {
    runWithReadSession(() => {
      markWrite();
      expect(shouldReadFromPrimary()).toBe(true);
      // A later clock tick must not release the guard: the session wrote.
      expect(shouldReadFromPrimary(Date.now() + 60 * 60 * 1000)).toBe(true);
    });
  });

  it("does not leak a session's write guard into another session", () => {
    runWithReadSession(() => markWrite());
    runWithReadSession(() => {
      expect(shouldReadFromPrimary()).toBe(false);
    });
  });

  it("guards unscoped writes for the configured window", () => {
    const now = Date.now();
    markWrite(now);
    expect(shouldReadFromPrimary(now + 1)).toBe(true);
    expect(shouldReadFromPrimary(now + 60 * 60 * 1000)).toBe(false);
  });
});

describe("isReadOnlyQuery", () => {
  it.each([
    "SELECT * FROM markets",
    "  select id from leaderboard limit 1",
    "WITH recent AS (SELECT id FROM markets) SELECT * FROM recent",
    "SHOW statement_timeout",
    "EXPLAIN SELECT * FROM markets",
  ])("accepts read-only statement %s", (sql) => {
    expect(isReadOnlyQuery(sql)).toBe(true);
  });

  it.each([
    "INSERT INTO markets (question) VALUES ('x')",
    "UPDATE markets SET resolved = true",
    "DELETE FROM markets",
    "WITH removed AS (DELETE FROM markets RETURNING *) SELECT * FROM removed",
    "SELECT * FROM markets FOR UPDATE",
    "SELECT * INTO archived_markets FROM markets",
    "CREATE TABLE scratch (id int)",
    "SET statement_timeout = 1000",
    "BEGIN",
    "",
  ])("rejects non-read-only statement %s", (sql) => {
    expect(isReadOnlyQuery(sql)).toBe(false);
  });
});
