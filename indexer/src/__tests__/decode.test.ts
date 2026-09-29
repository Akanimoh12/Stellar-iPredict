import { describe, expect, it } from "vitest";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { decodeTopics, decodeValue, decodeEvent } from "../decode.js";
import type { DecodedEvent, DecodedTopics } from "../decode.js";

describe("decodeTopics", () => {
  it("decodes a single symbol topic into type", () => {
    const topics = [nativeToScVal("heartbeat", { type: "symbol" })];
    const result = decodeTopics(topics);
    expect(result).toEqual<DecodedTopics>({
      type: "heartbeat",
      subtype: undefined,
      args: [],
    });
  });

  it("decodes type and subtype from two symbol topics", () => {
    const topics = [
      nativeToScVal("mkt", { type: "symbol" }),
      nativeToScVal("created", { type: "symbol" }),
    ];
    const result = decodeTopics(topics);
    expect(result).toEqual<DecodedTopics>({
      type: "mkt",
      subtype: "created",
      args: [],
    });
  });

  it("decodes additional topic args beyond type and subtype", () => {
    const topics = [
      nativeToScVal("bet", { type: "symbol" }),
      nativeToScVal("placed", { type: "symbol" }),
      nativeToScVal(42n),
      nativeToScVal(true),
    ];
    const result = decodeTopics(topics);
    expect(result.type).toBe("bet");
    expect(result.subtype).toBe("placed");
    expect(result.args).toHaveLength(2);
  });

  it("handles empty topics array gracefully", () => {
    const result = decodeTopics([]);
    expect(result.type).toBe("");
    expect(result.subtype).toBeUndefined();
    expect(result.args).toEqual([]);
  });
});

describe("decodeValue", () => {
  it("decodes an address value", () => {
    const address = "GAY2QWU3KZ3OR6QNCSTW5BOTSMOM7SVRQWR3OFPV7A24TO7MTM56EIDN";
    const value = nativeToScVal(address, { type: "address" });
    expect(decodeValue(value)).toBe(address);
  });

  it("decodes an i128 value", () => {
    const value = nativeToScVal(1000000000n, { type: "i128" });
    expect(decodeValue(value)).toBe(1000000000n);
  });

  it("decodes a negative i128 value", () => {
    const value = nativeToScVal(-42n, { type: "i128" });
    expect(decodeValue(value)).toBe(-42n);
  });

  it("decodes a bool value", () => {
    expect(decodeValue(nativeToScVal(true))).toBe(true);
    expect(decodeValue(nativeToScVal(false))).toBe(false);
  });

  it("decodes a symbol value", () => {
    const value = nativeToScVal("active", { type: "symbol" });
    expect(decodeValue(value)).toBe("active");
  });

  it("decodes a map value with symbol keys", () => {
    const mapVal = nativeToScVal({
      market_id: 1n,
      outcome: true,
      category: "Crypto",
    });
    const result = decodeValue(mapVal) as Record<string, unknown>;
    expect(result).toHaveProperty("market_id");
    expect(result).toHaveProperty("outcome");
    expect(result).toHaveProperty("category");
  });

  it("decodes a vec value", () => {
    const vecVal = nativeToScVal(["a", "b", "c"]);
    const result = decodeValue(vecVal) as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
  });

  it("decodes void (null) value", () => {
    const voidVal = xdr.ScVal.scvVoid();
    expect(decodeValue(voidVal)).toBeNull();
  });
});

describe("decodeEvent", () => {
  it("decodes a full event with type, subtype, and data", () => {
    const topics = [
      nativeToScVal("mkt", { type: "symbol" }),
      nativeToScVal("resolved", { type: "symbol" }),
      nativeToScVal(1n),
    ];
    const value = nativeToScVal({
      market_id: 1n,
      outcome: true,
    });
    const result = decodeEvent(topics, value);
    expect(result).toEqual<DecodedEvent>({
      type: "mkt",
      subtype: "resolved",
      data: { market_id: 1n, outcome: true },
    });
  });

  it("decodes an event with only a type (no subtype)", () => {
    const topics = [nativeToScVal("heartbeat", { type: "symbol" })];
    const value = xdr.ScVal.scvVoid();
    const result = decodeEvent(topics, value);
    expect(result).toEqual<DecodedEvent>({
      type: "heartbeat",
      subtype: undefined,
      data: null,
    });
  });
});
