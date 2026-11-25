import { describe, expect, it, vi } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { assertValidEventAmounts, decodeEvent, MAX_EVENT_AMOUNT, setDeadLetterHandler } from "../decode.js";

describe("decoded monetary event amount constraints (#943)", () => {
  it("rejects negative, malformed, fractional and over-i128 values", () => {
    for (const bad of [-1n, "-10", "1.5", 1.2, "oops", MAX_EVENT_AMOUNT + 1n]) {
      expect(() => assertValidEventAmounts("bet_placed", undefined, { amount: bad }))
        .toThrow(/Invalid event amount/);
    }
  });

  it("accepts zero, max i128 and unrelated signed fields", () => {
    expect(() => assertValidEventAmounts("oracle", "finalized", {
      payout: MAX_EVENT_AMOUNT, fee: 0n, signed_delta: -10n,
    })).not.toThrow();
  });

  it("validates nested amounts and historical bet tuples", () => {
    expect(() => assertValidEventAmounts("bet", "placed", [1n, "wallet", true, -1n, 0n, 0n, false]))
      .toThrow("data[3]");
    expect(() => assertValidEventAmounts("oracle", "finalized", {
      nested: { submitter_bond: -2n },
    })).toThrow("submitter_bond");
  });

  it("routes invalid monetary payloads into the dead-letter handler", () => {
    const spy = vi.fn();
    setDeadLetterHandler(spy);
    const topics = [nativeToScVal("bet_placed", { type: "symbol" })];
    const payload = nativeToScVal({ amount: -1n });
    expect(() => decodeEvent(topics, payload)).toThrow(/Invalid event amount/);
    expect(spy).toHaveBeenCalledTimes(1);
    // Restore the default output sink for the other decoder tests.
    setDeadLetterHandler(() => {});
  });
});
