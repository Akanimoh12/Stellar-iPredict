import { describe, expect, it } from "vitest";
import { ResolverKeyManager } from "../src/aggregator/key-rotation.js";

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
