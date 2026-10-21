import { describe, expect, it } from "vitest";
import {
  eventPayloadSchemas,
  parseEventPayload,
  ZodValidationError,
} from "../schemas.js";

const ADDRESS = "G" + "A".repeat(55);

describe("authoritative event payload schemas", () => {
  it("parses a valid payload through the shared registry", () => {
    expect(
      parseEventPayload("market_created", {
        market_id: "7",
        question: "Will the market settle?",
        category: "Crypto",
        end_time: 1_800_000_000n,
        creator: ADDRESS,
      }),
    ).toEqual({
      market_id: 7,
      question: "Will the market settle?",
      category: "Crypto",
      end_time: 1_800_000_000,
      creator: ADDRESS,
      image_url: undefined,
    });
  });

  it("reports a missing required field consistently", () => {
    expect(() =>
      parseEventPayload("market_resolved", { outcome: true }),
    ).toThrowError(new ZodValidationError("market_id is required"));
  });

  it("rejects an invalid field value", () => {
    const result = eventPayloadSchemas.bet_placed.safeParse({
      market_id: 7,
      bettor: ADDRESS,
      is_yes: true,
      amount: "10",
      net_amount: "11",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodValidationError);
      expect(result.error.message).toBe("net_amount must not exceed amount");
    }
  });

  it("rejects malformed non-object events without throwing from safeParse", () => {
    const result = eventPayloadSchemas.referral_registered.safeParse("malformed");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.name).toBe("ZodValidationError");
      expect(result.error.message).toContain("object or tuple");
    }
  });

  it("keeps named schemas and the registry on the same schema instances", async () => {
    const { marketCancelledPayloadSchema } = await import("../schemas.js");
    expect(eventPayloadSchemas.market_cancelled).toBe(marketCancelledPayloadSchema);
  });
});
