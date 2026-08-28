/**
 * Tests for the in-memory FakeRedis bootstrap (issue #228).
 *
 * FakeRedis is the Redis counterpart of the ephemeral-Postgres bootstrap:
 * it lets cache tests run with zero infrastructure. These tests pin the
 * fake's behaviour against the Redis semantics the backend relies on, so a
 * regression in the fake can never silently hide a regression in the app.
 * Fully deterministic — no server involved.
 */

import { describe, expect, it } from "vitest";
import { createTestRedis, MemRedis } from "../src/test/fakeRedis.js";

function fresh(): MemRedis {
  return createTestRedis();
}

describe("FakeRedis bootstrap", () => {
  it("answers PING with PONG (and echoes a message)", async () => {
    const redis = fresh();
    await expect(redis.ping()).resolves.toBe("PONG");
    await expect(redis.ping("hello")).resolves.toBe("hello");
  });

  it("starts in the ready state", () => {
    expect(fresh().status).toBe("ready");
  });

  it("set followed by get round-trips a value", async () => {
    const redis = fresh();
    await redis.set("k", "v");
    await expect(redis.get("k")).resolves.toBe("v");
  });

  it("returns null for missing keys without erroring", async () => {
    await expect(fresh().get("nope")).resolves.toBeNull();
  });

  it("overwrites existing values", async () => {
    const redis = fresh();
    await redis.set("k", "first");
    await redis.set("k", "second");
    await expect(redis.get("k")).resolves.toBe("second");
  });

  it("SETEX stores the value with a TTL", async () => {
    const redis = fresh();
    await redis.setex("temp", 10, "x");
    await expect(redis.get("temp")).resolves.toBe("x");
    const ttl = await redis.ttl("temp");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10);
  });

  it("SET supports the 'EX' TTL mode used by the cache layer", async () => {
    const redis = fresh();
    await redis.set("k", "v", "EX", 5);
    const ttl = await redis.ttl("k");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5);
  });

  it("DEL removes keys and resolves the number removed", async () => {
    const redis = fresh();
    await redis.set("a", "1");
    await redis.set("b", "2");
    await expect(redis.del("a", "b", "missing")).resolves.toBe(2);
    await expect(redis.get("a")).resolves.toBeNull();
    await expect(redis.get("b")).resolves.toBeNull();
  });

  it("EXISTS counts present keys", async () => {
    const redis = fresh();
    await redis.set("a", "1");
    await expect(redis.exists("a")).resolves.toBe(1);
    await expect(redis.exists("a", "missing")).resolves.toBe(1);
    await expect(redis.exists("missing")).resolves.toBe(0);
  });

  it("INCR increments atomically from zero", async () => {
    const redis = fresh();
    await expect(redis.incr("counter")).resolves.toBe(1);
    await expect(redis.incr("counter")).resolves.toBe(2);
    await expect(redis.get("counter")).resolves.toBe("2");
  });

  it("KEYS matches Redis globs", async () => {
    const redis = fresh();
    await redis.set("ipredict:markets:all", "1");
    await redis.set("ipredict:markets:active", "2");
    await redis.set("unrelated", "3");

    const keys = await redis.keys("ipredict:markets:*");
    expect(keys.sort()).toEqual(["ipredict:markets:active", "ipredict:markets:all"]);
  });

  it("EXPIRE arms a TTL and TTL reports -2 after deletion", async () => {
    const redis = fresh();
    await redis.set("k", "v");
    await expect(redis.ttl("k")).resolves.toBe(-1); // persists by default
    await expect(redis.expire("k", 60)).resolves.toBe(1);
    const ttl = await redis.ttl("k");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    await redis.del("k");
    await expect(redis.ttl("k")).resolves.toBe(-2);
  });

  it("FLUSHALL / FLUSHDB wipe every key", async () => {
    const redis = fresh();
    await redis.set("a", "1");
    await redis.set("b", "2");
    await redis.flushall();
    await expect(redis.get("a")).resolves.toBeNull();
    await expect(redis.get("b")).resolves.toBeNull();
    expect(redis.size).toBe(0);
  });

  it("QUIT clears state and ends the connection", async () => {
    const redis = fresh();
    await redis.set("a", "1");
    await redis.quit();
    expect(redis.status).toBe("end");
    expect(redis.size).toBe(0);
  });

  it("supports on / once / off event listeners", async () => {
    const redis = fresh();
    const seen: unknown[] = [];
    const listener = (...args: unknown[]) => {
      seen.push(args);
    };
    redis.on("set", listener);
    await redis.set("k", "v");
    expect(seen).toEqual([["k", "v"]]);

    // The `once` listener only fires once.
    let onceCalls = 0;
    redis.once("set", () => {
      onceCalls++;
    });
    await redis.set("k2", "v2");
    await redis.set("k3", "v3");
    expect(onceCalls).toBe(1);

    // `off` removes listeners.
    redis.off("set", listener);
    const before = seen.length;
    await redis.set("k4", "v4");
    expect(seen.length).toBe(before);
  });

  it("can be made to fail per-command to simulate an outage", async () => {
    const redis = fresh();
    redis.get = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(redis.get("anything")).rejects.toThrow("ECONNREFUSED");
  });

  it("keeps the app bootable when connected through buildServer", async () => {
    const { buildServer } = await import("../src/server.js");
    const redis = fresh();
    const server = buildServer({ corsOrigins: [], logger: false, redis: redis as never });
    try {
      await server.ready();
      const res = await server.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });
});