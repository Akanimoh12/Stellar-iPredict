import { describe, expect, it, vi } from "vitest";
import { decodeTokenMint, handleTokenMint, TOKEN_MINT_TOPIC } from "../token_mint.js";
import type { DecodedEvent, HandlerContext } from "../types.js";

const ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function createEvent(data: unknown): DecodedEvent {
  return {
    ledger: 100n,
    txHash: "0".repeat(64),
    topics: [TOKEN_MINT_TOPIC],
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

describe("decodeTokenMint", () => {
  it("decodes a token_mint payload", () => {
    expect(decodeTokenMint(createEvent({ to: ADDRESS, amount: 1250n }))).toEqual({
      to: ADDRESS,
      amount: "1250",
    });
  });

  it("rejects invalid payloads", () => {
    expect(() => decodeTokenMint(createEvent({ to: "bad", amount: "10" }))).toThrow(
      "valid Stellar public key",
    );
    expect(() => decodeTokenMint(createEvent({ to: ADDRESS, amount: -1 }))).toThrow(
      "non-negative numeric value",
    );
  });
});

describe("handleTokenMint", () => {
  it("upserts token balances, records the raw event, and invalidates affected cache keys", async () => {
    const context = createContext();
    const event = createEvent({ to: ADDRESS, amount: "99.5" });

    await handleTokenMint(event, context);

    expect(context.db.query).toHaveBeenCalledTimes(2);
    expect(context.db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO events"),
      [event.ledger, event.txHash, 0, TOKEN_MINT_TOPIC, null, ADDRESS, { to: ADDRESS, amount: "99.5" }],
    );
    expect(context.db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO token_balances"),
      [ADDRESS, "99.5"],
    );
    expect(context.redis?.del).toHaveBeenCalledWith(`token_balance:${ADDRESS}`, "stats:global");
  });
});
