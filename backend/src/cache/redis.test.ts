import { describe, it, expect, beforeEach } from "vitest";
import type { Redis } from "ioredis";
import { cache, getRedisClient, setRedisClient } from "./redis";
import { createTestRedis, MemRedis } from "../test/fakeRedis.js";

// Runs entirely against the in-memory FakeRedis bootstrap (src/test/fakeRedis.ts) —
// no real Redis server required, so the suite is deterministic everywhere.

function installTestClient(): MemRedis {
  const fake = createTestRedis();
  setRedisClient(fake as unknown as Redis);
  return fake;
}

function installedClient(): MemRedis {
  return getRedisClient() as unknown as MemRedis;
}

describe("Redis Cache Client", () => {
  beforeEach(() => {
    installTestClient();
  });

  it("should set and get typed JSON data", async () => {
    interface TestData {
      id: number;
      name: string;
    }
    const data: TestData = { id: 1, name: 'Test' };

    await cache.set('test_key', data);
    const retrieved = await cache.get<TestData>('test_key');

    expect(retrieved).toEqual(data);
  });

  it('should return null for non-existent keys', async () => {
    const retrieved = await cache.get('missing_key');
    expect(retrieved).toBeNull();
  });

  it('should return null when reading invalid JSON', async () => {
    await installedClient().set('bad_json', '{ bad json');

    const retrieved = await cache.get('bad_json');
    expect(retrieved).toBeNull();
  });

  it('should set data with TTL', async () => {
    const data = { temp: true };
    await cache.set('temp_key', data, 10);

    // Check if TTL is roughly 10 seconds
    const ttl = await installedClient().ttl('temp_key');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10);
  });

  it('should delete keys', async () => {
    await cache.set('to_del', { a: 1 });
    await cache.del('to_del');

    const retrieved = await cache.get('to_del');
    expect(retrieved).toBeNull();
  });
});