import { describe, expect, it } from "vitest";
import { withHealthTimeout } from "./health.js";

describe("withHealthTimeout", () => {
  it("resolves with the check's result when it finishes before the timeout", async () => {
    const result = await withHealthTimeout(Promise.resolve({ ok: true, latencyMs: 1 }), 50);
    expect(result).toEqual({ ok: true, latencyMs: 1 });
  });

  it("resolves unhealthy once the timeout elapses, without waiting on the hung check", async () => {
    const hung = new Promise<{ ok: boolean }>(() => {});
    const result = await withHealthTimeout(hung as Promise<any>, 20);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
  });
});
