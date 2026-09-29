import { describe, expect, it, vi } from "vitest";
import { dispatchEvent } from "../index.js";
import type { DecodedEvent, HandlerContext } from "../types.js";

function createContext(): HandlerContext {
  return {
    db: { query: vi.fn().mockResolvedValue(undefined) },
    redis: { del: vi.fn().mockResolvedValue(undefined) },
    logger: { warn: vi.fn() },
  };
}

describe("dispatchEvent", () => {
  it("routes decoded events to the handler registered for the first topic", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const context = createContext();
    const event: DecodedEvent = {
      ledger: 42,
      txHash: "abc",
      topics: ["sample_event"],
      data: { ok: true },
    };

    await dispatchEvent(event, context, { sample_event: handler });

    expect(handler).toHaveBeenCalledWith(event, context);
    expect(context.logger.warn).not.toHaveBeenCalled();
  });

  it("logs and skips unknown event types without throwing", async () => {
    const context = createContext();
    const event: DecodedEvent = {
      ledger: 43,
      txHash: "def",
      topics: ["unknown_event"],
      data: {},
    };

    await expect(dispatchEvent(event, context, {})).resolves.toBeUndefined();

    expect(context.logger.warn).toHaveBeenCalledWith(
      "Skipping unknown indexer event type",
      expect.objectContaining({ topic: "unknown_event", ledger: 43, txHash: "def" }),
    );
  });
});
