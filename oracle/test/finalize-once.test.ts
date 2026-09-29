import { describe, expect, it, vi } from "vitest";
import { FinalizationGuard } from "../src/aggregator/finalize-once.js";

describe("FinalizationGuard", () => {
  it("submits a market only once across repeated calls", async () => {
    const guard = new FinalizationGuard();
    const lookup = vi.fn(async () => false);
    const submit = vi.fn(async () => undefined);

    expect(await guard.runOnce("42", lookup, submit)).toBe(true);
    expect(await guard.runOnce("42", lookup, submit)).toBe(false);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("blocks a concurrent duplicate before the first submission completes", async () => {
    const guard = new FinalizationGuard();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const submit = vi.fn(async () => pending);

    const first = guard.runOnce("42", async () => false, submit);
    const duplicate = await guard.runOnce("42", async () => false, submit);
    release();

    expect(duplicate).toBe(false);
    expect(await first).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("does not submit a market already finalized in durable state", async () => {
    const guard = new FinalizationGuard();
    const submit = vi.fn(async () => undefined);
    expect(await guard.runOnce("42", async () => true, submit)).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it("releases a failed claim so the market can be retried", async () => {
    const guard = new FinalizationGuard();
    const submit = vi.fn()
      .mockRejectedValueOnce(new Error("RPC unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(guard.runOnce("42", async () => false, submit)).rejects.toThrow("RPC unavailable");
    expect(await guard.runOnce("42", async () => false, submit)).toBe(true);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("allows different markets to finalize independently", async () => {
    const guard = new FinalizationGuard();
    const submit = vi.fn(async () => undefined);
    await Promise.all([
      guard.runOnce("one", async () => false, submit),
      guard.runOnce("two", async () => false, submit),
    ]);
    expect(submit).toHaveBeenCalledTimes(2);
  });
});
