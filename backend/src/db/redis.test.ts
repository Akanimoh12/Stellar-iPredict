import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import * as cacheRedis from "../cache/redis.js";
import { closeRedis, getRedisClient, pingRedis } from "./redis.js";
import { createTestRedis } from "../test/fakeRedis.js";

// The connection is owned by cache/redis.ts. These tests pin that db/redis
// hands out the same instance, so the server holds one Redis connection and
// shutdown closes that one connection.

function installFake() {
  const fake = createTestRedis();
  cacheRedis.setRedisClient(fake as unknown as Redis);
  return fake;
}

describe("db/redis shares the cache module's client", () => {
  it("hands out the same instance from both modules", () => {
    const fake = installFake();

    expect(getRedisClient()).toBe(fake);
    expect(cacheRedis.getRedisClient()).toBe(fake);
  });

  it("closeRedis quits the shared client", async () => {
    const fake = installFake();

    await closeRedis();

    expect(fake.status).toBe("end");
  });

  it("closeRedis forgets the client so the next caller gets a fresh one", async () => {
    const fake = installFake();

    await closeRedis();
    const next = getRedisClient();

    expect(next).not.toBe(fake);
    // Lazy connect: nothing was opened, so there is no socket to tidy up.
    next.disconnect();
  });

  it("cache.close() closes the same shared client", async () => {
    const fake = installFake();

    await cacheRedis.cache.close();

    expect(fake.status).toBe("end");
  });

  it("pingRedis reports PONG through the shared client", async () => {
    installFake();

    const result = await pingRedis();

    expect(result.ok).toBe(true);
  });
});
