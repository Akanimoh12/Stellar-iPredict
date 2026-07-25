import { describe, expect, it, vi } from "vitest";
import { decodeFeeWithdrawn, handleFeeWithdrawn, FEES_WITHDRAWN_TOPIC } from "../fee_withdrawn.js";
import type { DecodedEvent, HandlerContext } from "../types.js";

const ADMIN = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function createEvent(data: unknown): DecodedEvent {
  return {
    ledger: 100n,
    txHash: "0".repeat(64),
    topics: [FEES_WITHDRAWN_TOPIC],
    data,
  };
}

function createContext(): HandlerContext {
  return {
    db: { query: vi.fn().mockResolvedValue(undefined) },
    redis: { del: vi.fn().mockResolvedValue(undefined) },
    logger: { warn: vi.fn() },
  };
}

describe("decodeFeeWithdrawn", () => {
  it("decodes a fees_withdrawn payload", () => {
    expect(decodeFeeWithdrawn(createEvent({ admin: ADMIN, amount: 150000000n }))).toEqual({
      admin: ADMIN,
      amount: "150000000",
    });
  });

  it("decodes amount as string", () => {
    expect(decodeFeeWithdrawn(createEvent({ admin: ADMIN, amount: "150000000" }))).toEqual({
      admin: ADMIN,
      amount: "150000000",
    });
  });

  it("rejects invalid admin address", () => {
    expect(() => decodeFeeWithdrawn(createEvent({ admin: "bad", amount: 100n }))).toThrow(
      "valid Stellar public key",
    );
  });

  it("rejects missing amount", () => {
    expect(() => decodeFeeWithdrawn(createEvent({ admin: ADMIN }))).toThrow(
      "fee_withdrawn amount is required",
    );
  });

  it("rejects invalid amount (negative)", () => {
    expect(() => decodeFeeWithdrawn(createEvent({ admin: ADMIN, amount: -1 }))).toThrow(
      "non-negative numeric value",
    );
  });

  it("rejects non-object payload", () => {
    expect(() => decodeFeeWithdrawn(createEvent("string"))).toThrow("must be an object");
    expect(() => decodeFeeWithdrawn(createEvent(null))).toThrow("must be an object");
    expect(() => decodeFeeWithdrawn(createEvent([ADMIN, 100n]))).toThrow("must be an object");
  });
});

describe("handleFeeWithdrawn", () => {
  it("records the event and invalidates stats:global cache key", async () => {
    const context = createContext();
    const event = createEvent({ admin: ADMIN, amount: "150000000" });

    await handleFeeWithdrawn(event, context);

    expect(context.db.query).toHaveBeenCalledTimes(1);
    expect(context.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO events"),
      [event.ledger, event.txHash, FEES_WITHDRAWN_TOPIC, ADMIN, { admin: ADMIN, amount: "150000000" }],
    );
    expect(context.redis?.del).toHaveBeenCalledWith("stats:global");
  });
});