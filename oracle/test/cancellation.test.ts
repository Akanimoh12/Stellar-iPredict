import { describe, expect, it, vi } from "vitest";
import { CancellationAwareFinalizer } from "../src/aggregator/cancellation.js";
import { createLogger } from "../src/log.js";

describe("CancellationAwareFinalizer", () => {
  it("skips a market that is already cancelled", async () => {
    const finalizer = new CancellationAwareFinalizer();
    const outcome = vi.fn(async () => true);
    const submit = vi.fn(async () => undefined);
    const result = await finalizer.finalize(
      "42", async () => ({ cancelled: true, resolved: false }), outcome, submit,
    );
    expect(result).toBe("cancelled");
    expect(outcome).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not finalize when cancellation occurs during aggregation", async () => {
    const finalizer = new CancellationAwareFinalizer();
    const getState = vi.fn()
      .mockResolvedValueOnce({ cancelled: false, resolved: false })
      .mockResolvedValueOnce({ cancelled: true, resolved: false });
    const submit = vi.fn(async () => undefined);
    expect(await finalizer.finalize("42", getState, async () => true, submit)).toBe("cancelled");
    expect(getState).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
  });

  it("skips an already resolved market", async () => {
    const finalizer = new CancellationAwareFinalizer();
    const submit = vi.fn(async () => undefined);
    expect(await finalizer.finalize(
      "42", async () => ({ cancelled: false, resolved: true }), async () => true, submit,
    )).toBe("already-resolved");
    expect(submit).not.toHaveBeenCalled();
  });

  it("returns below-threshold without submitting", async () => {
    const finalizer = new CancellationAwareFinalizer();
    const submit = vi.fn(async () => undefined);
    expect(await finalizer.finalize(
      "42", async () => ({ cancelled: false, resolved: false }), async () => null, submit,
    )).toBe("below-threshold");
    expect(submit).not.toHaveBeenCalled();
  });

  it("finalizes an eligible market exactly once", async () => {
    const finalizer = new CancellationAwareFinalizer();
    const submit = vi.fn(async () => undefined);
    const state = async () => ({ cancelled: false, resolved: false });
    expect(await finalizer.finalize("42", state, async () => false, submit)).toBe("finalized");
    expect(await finalizer.finalize("42", state, async () => false, submit)).toBe("already-resolved");
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith("42", false);
  });

  it("logs each finalization decision as structured JSON", async () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });
    const finalizer = new CancellationAwareFinalizer(logger);
    const submit = vi.fn(async () => undefined);
    const state = async () => ({ cancelled: false, resolved: false });

    await finalizer.finalize("42", state, async () => true, submit);

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(record).toMatchObject({
      message: "finalization decision",
      marketId: "42",
      decision: "finalized",
      outcome: true,
    });
  });
});
