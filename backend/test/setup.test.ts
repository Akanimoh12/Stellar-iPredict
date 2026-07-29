import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeTestApp,
  createTestApp,
  isTestDatabaseAvailable,
  truncateAll,
  type TestApp,
} from "./setup.js";

// Resolved once at collection time so `describe.skipIf` can gate every
// integration test below on it — see setup.ts for why this must not throw
// (and instead just skip) when no local Postgres is running.
const dbAvailable = await isTestDatabaseAvailable();

it("resolves database availability without throwing", () => {
  expect(typeof dbAvailable).toBe("boolean");
});

describe.skipIf(!dbAvailable)(
  "Integration: real app booted against a migrated test database",
  () => {
    let app: TestApp;

    beforeAll(async () => {
      app = await createTestApp();
    });

    afterAll(async () => {
      await closeTestApp(app);
    });

    beforeEach(async () => {
      await truncateAll(app.pool);
    });

    it("answers the liveness probe", async () => {
      const response = await app.server.inject({
        method: "GET",
        url: "/healthz",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
    });

    it("serves an empty leaderboard once migrations have run", async () => {
      const response = await app.server.inject({
        method: "GET",
        url: "/api/leaderboard",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ players: [], total: 0 });
    });

    it("serves a row inserted directly through the pool", async () => {
      await app.pool.query(
        `INSERT INTO leaderboard (address, display_name, points, won_bets, lost_bets)
         VALUES ($1, $2, $3, $4, $5)`,
        ["G" + "A".repeat(55), "Alice", 100, 5, 2]
      );

      const response = await app.server.inject({
        method: "GET",
        url: "/api/leaderboard",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.players[0]).toMatchObject({
        address: "G" + "A".repeat(55),
        display_name: "Alice",
      });
    });

    it("starts each test from an empty table", async () => {
      const response = await app.server.inject({
        method: "GET",
        url: "/api/leaderboard",
      });

      expect(response.json().total).toBe(0);
    });
  }
);
