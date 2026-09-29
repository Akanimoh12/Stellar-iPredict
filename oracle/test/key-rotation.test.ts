import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EnvironmentResolverKeyProvider,
  MountedSecretResolverKeyProvider,
  ResolverKeyManager,
  ResolverRotationScheduler,
} from "../src/aggregator/key-rotation.js";

describe("ResolverKeyManager", () => {
  it("starts with the initial key as active", () => {
    const manager = new ResolverKeyManager("KEY_A");
    expect(manager.getActiveKey()).toBe("KEY_A");
    expect(manager.isAuthorized("KEY_A")).toBe(true);
  });

  it("rotates to a new key while keeping the old key authorized", () => {
    const manager = new ResolverKeyManager("KEY_A");
    manager.rotate("KEY_B");
    expect(manager.getActiveKey()).toBe("KEY_B");
    expect(manager.isAuthorized("KEY_A")).toBe(true);
    expect(manager.isAuthorized("KEY_B")).toBe(true);
  });

  it("lists both active and pending keys", () => {
    const manager = new ResolverKeyManager("KEY_A");
    manager.rotate("KEY_B");
    expect(manager.getAuthorizedKeys()).toEqual(["KEY_B", "KEY_A"]);
  });

  it("revokes all pending keys on demand", () => {
    const manager = new ResolverKeyManager("KEY_A");
    manager.rotate("KEY_B");
    manager.rotate("KEY_C");
    const revoked = manager.revokePending();
    expect(revoked).toContain("KEY_A");
    expect(revoked).toContain("KEY_B");
    expect(manager.isAuthorized("KEY_A")).toBe(false);
    expect(manager.isAuthorized("KEY_B")).toBe(false);
    expect(manager.isAuthorized("KEY_C")).toBe(true);
  });

  it("revokes a specific pending key", () => {
    const manager = new ResolverKeyManager("KEY_A");
    manager.rotate("KEY_B");
    expect(manager.revokePendingKey("KEY_A")).toBe(true);
    expect(manager.isAuthorized("KEY_A")).toBe(false);
    expect(manager.isAuthorized("KEY_B")).toBe(true);
  });

  it("refuses to revoke the active key", () => {
    const manager = new ResolverKeyManager("KEY_A");
    expect(() => manager.revokePendingKey("KEY_A")).toThrow("Cannot revoke the active key");
  });

  it("treats rotating to the same key as a no-op", () => {
    const manager = new ResolverKeyManager("KEY_A");
    manager.rotate("KEY_A");
    expect(manager.getActiveKey()).toBe("KEY_A");
    expect(manager.getAuthorizedKeys()).toEqual(["KEY_A"]);
  });

  it("supports multiple sequential rotations", () => {
    const manager = new ResolverKeyManager("KEY_A");
    manager.rotate("KEY_B");
    manager.rotate("KEY_C");
    manager.rotate("KEY_D");
    expect(manager.getActiveKey()).toBe("KEY_D");
    expect(manager.isAuthorized("KEY_A")).toBe(true);
    expect(manager.isAuthorized("KEY_B")).toBe(true);
    expect(manager.isAuthorized("KEY_C")).toBe(true);
  });

  it("rejects an empty initial key", () => {
    expect(() => new ResolverKeyManager("")).toThrow("initialKey is required");
    expect(() => new ResolverKeyManager("   ")).toThrow("initialKey is required");
  });

  it("rejects an empty rotation key", () => {
    const manager = new ResolverKeyManager("KEY_A");
    expect(() => manager.rotate("")).toThrow("newKey is required");
  });

  it("returns false when revoking a key that is not pending", () => {
    const manager = new ResolverKeyManager("KEY_A");
    expect(manager.revokePendingKey("UNKNOWN")).toBe(false);
  });
});


describe("resolver key providers", () => {
  it("loads the local-development environment fallback", async () => {
    const provider = new EnvironmentResolverKeyProvider({ RESOLVER_KEY: "  SLOCAL  " });
    await expect(provider.getKey()).resolves.toBe("SLOCAL");
  });

  it("loads a mounted secret without exposing its contents on failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resolver-key-"));
    const path = join(dir, "resolver");
    await writeFile(path, "  SMOUNTED\n", "utf8");
    const provider = new MountedSecretResolverKeyProvider(path);
    await expect(provider.getKey()).resolves.toBe("SMOUNTED");

    const missing = new MountedSecretResolverKeyProvider(join(dir, "missing"));
    await expect(missing.getKey()).rejects.toThrow("could not be loaded from mounted-secret");
  });
});

describe("ResolverRotationScheduler", () => {
  it("registers and verifies the incoming key before retiring the outgoing key", async () => {
    const manager = new ResolverKeyManager("KEY_A");
    const events: string[] = [];
    const scheduler = new ResolverRotationScheduler(manager, {
      provider: { source: "test", getKey: async () => "KEY_B" },
      overlapMs: 25,
      intervalMs: 60_000,
      sleep: async (ms) => {
        expect(ms).toBe(25);
        events.push("overlap");
      },
      hooks: {
        registerIncomingKey: async (key) => events.push(`register:${key}`),
        verifyIncomingKey: async (key) => {
          expect(manager.isAuthorized("KEY_A")).toBe(true);
          expect(manager.isAuthorized("KEY_B")).toBe(true);
          events.push(`verify:${key}`);
        },
        retireOutgoingKey: async (key) => events.push(`retire:${key}`),
      },
    });

    await expect(scheduler.runOnce()).resolves.toBe(true);
    expect(events).toEqual(["register:KEY_B", "verify:KEY_B", "overlap", "retire:KEY_A"]);
    expect(manager.getActiveKey()).toBe("KEY_B");
    expect(manager.isAuthorized("KEY_A")).toBe(false);
  });

  it("rolls back to the previous key when verification fails", async () => {
    const manager = new ResolverKeyManager("KEY_A");
    const retired: string[] = [];
    const scheduler = new ResolverRotationScheduler(manager, {
      provider: { source: "test", getKey: async () => "KEY_B" },
      overlapMs: 0,
      intervalMs: 60_000,
      hooks: {
        registerIncomingKey: async () => undefined,
        verifyIncomingKey: async () => {
          throw new Error("probe failed");
        },
        retireOutgoingKey: async (key) => retired.push(key),
      },
    });

    await expect(scheduler.runOnce()).rejects.toThrow("previous key restored");
    expect(manager.getActiveKey()).toBe("KEY_A");
    expect(manager.isAuthorized("KEY_B")).toBe(false);
    expect(retired).toEqual([]);
  });
});