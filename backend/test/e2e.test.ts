import { describe, expect, it, vi } from "vitest";

const { sharedPool, sharedRedis, pingDbMock, pingRedisMock } = vi.hoisted(() => {
  const marketRow = {
    id: 1,
    question: "Will XLM close above $1?",
    image_url: null,
    category: "Crypto",
    end_time: "1735689600",
    total_yes: "100.0000000",
    total_no: "50.0000000",
    resolved: false,
    outcome: null,
    cancelled: false,
    creator: "G" + "A".repeat(55),
    bet_count: 3,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };
  const betRow = {
    market_id: "1",
    bettor: "G" + "B".repeat(55),
    net_amount: "25.0000000",
    gross_amount: "25.5000000",
    is_yes: true,
    claimed: false,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  };
  const leaderboardRow = {
    address: "G" + "C".repeat(55),
    display_name: "Alice",
    points: "900",
    won_bets: 9,
    lost_bets: 3,
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };
  const profileBets = [betRow];
  const profileStats = {
    points: "900",
    won_bets: 9,
    lost_bets: 3,
  };
  const oracleSubmission = {
    id: 12,
    market_id: 1,
    submitter: "G" + "D".repeat(55),
    outcome: "true",
    bond_amount: "1000",
    submitted_at: new Date("2026-01-01T00:00:00.000Z"),
    status: "submitted",
  };

  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("AS total_markets")) {
      return {
        rows: [
          {
            total_markets: "1",
            total_volume: "150.0000000",
            total_users: "1",
            total_bets: "1",
          },
        ],
      };
    }

    if (sql.includes("INSERT INTO oracle_submissions")) {
      return { rows: [oracleSubmission] };
    }

    if (sql.includes("COUNT(*)::text AS count") && sql.includes("FROM oracle_submissions")) {
      return { rows: [{ count: "1" }] };
    }

    if (sql.includes("COUNT(*)::INT AS total FROM markets")) {
      return { rows: [{ total: 1 }] };
    }

    if (sql.includes("FROM markets") && sql.includes("WHERE id = $1")) {
      return values?.[0] === 1 ? { rows: [marketRow] } : { rows: [] };
    }

    if (sql.includes("FROM markets") && sql.includes("ORDER BY")) {
      return { rows: [marketRow] };
    }

    if (sql.includes("COUNT(*)::INT AS total FROM bets")) {
      return { rows: [{ total: 1 }] };
    }

    if (sql.includes("FROM bets") && sql.includes("WHERE market_id = $1")) {
      return { rows: [betRow] };
    }

    if (sql.includes("FROM bets") && sql.includes("WHERE bettor = $1")) {
      return { rows: profileBets };
    }

    if (sql.includes("COUNT(*)::text AS total FROM leaderboard")) {
      return { rows: [{ total: "1" }] };
    }

    if (sql.includes("SELECT points, won_bets, lost_bets") && sql.includes("FROM leaderboard")) {
      return { rows: [profileStats] };
    }

    if (sql.includes("FROM leaderboard") && sql.includes("ORDER BY")) {
      return { rows: [leaderboardRow] };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const redisStore = new Map<string, string>();
  const redis = {
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      redisStore.set(key, value);
      return "OK" as const;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let deleted = 0;
      for (const key of keys) {
        if (redisStore.delete(key)) {
          deleted++;
        }
      }
      return deleted;
    }),
    ping: vi.fn(async () => "PONG"),
  };

  return {
    sharedPool: { query },
    sharedRedis: redis,
    pingDbMock: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
    pingRedisMock: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
  };
});

vi.mock("../src/db/pool.js", () => ({ pool: sharedPool }));
vi.mock("../src/db/health.js", () => ({ pingDb: pingDbMock }));
vi.mock("../src/db/redis.js", () => ({ pingRedis: pingRedisMock }));

import { buildServer } from "../src/server.js";

describe("backend smoke test", () => {
  it("boots the API and serves every live endpoint once", async () => {
    const server = buildServer({
      corsOrigins: [],
      pool: sharedPool as never,
      redis: sharedRedis as never,
      logger: false,
    });

    await server.ready();

    try {
      const address = "G" + "Z".repeat(55);

      const responses = await Promise.all([
        server.inject({ method: "GET", url: "/healthz" }),
        server.inject({ method: "GET", url: "/readyz" }),
        server.inject({ method: "GET", url: "/metrics" }),
        server.inject({ method: "GET", url: "/api/docs" }),
        server.inject({ method: "GET", url: "/api/markets" }),
        server.inject({ method: "GET", url: "/api/markets/1" }),
        server.inject({ method: "GET", url: "/api/markets/1/odds" }),
        server.inject({ method: "GET", url: "/api/markets/1/bets" }),
        server.inject({ method: "GET", url: "/api/leaderboard" }),
        server.inject({ method: "GET", url: "/api/stats" }),
        server.inject({ method: "GET", url: `/api/v1/profile/${address}` }),
        server.inject({
          method: "POST",
          url: "/api/oracle/submit",
          headers: { authorization: "Bearer test-oracle-api-key" },
          payload: {
            marketId: 1,
            outcome: true,
            signature: "signed-payload",
            provider: "G" + "D".repeat(55),
          },
        }),
      ]);

      expect(responses.map((response) => response.statusCode)).toEqual([
        200,
        200,
        200,
        200,
        200,
        200,
        200,
        200,
        200,
        200,
        200,
        200,
      ]);

      expect(responses[2].headers["content-type"]).toContain("text/plain");
      expect(responses[3].json()).toHaveProperty("openapi");
      expect(responses[11].json()).toEqual({
        accepted: true,
        submissionsNeeded: 2,
      });
    } finally {
      await server.close();
    }
  });
});
