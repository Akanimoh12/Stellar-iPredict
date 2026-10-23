import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { DataAdapter, Market } from "../src/adapters/index.js";
import {
  FileProvenanceStore,
  InMemoryProvenanceStore,
  computePayloadHash,
  createProvenanceRecord,
} from "../src/adapters/provenance.js";
import { resolveMarket, type ResolutionResult } from "../src/adapters/resolve.js";

const market: Market = { id: "42", category: "crypto", params: {} };

function adapter(raw: unknown): DataAdapter {
  return {
    id: "source-a",
    supports: () => true,
    fetchOutcome: async () => ({ outcome: true, confidence: 0.9, raw }),
  };
}

describe("resolution provenance", () => {
  it("stores and retrieves the sources and decision", async () => {
    const store = new InMemoryProvenanceStore();

    await resolveMarket(market, [adapter({ value: 123 })], {
      provenanceStore: store,
      minAgreement: 1,
    });

    expect(await store.get("42")).toMatchObject({
      marketId: "42",
      sources: [{ adapterId: "source-a", outcome: true, raw: { value: 123 } }],
      decision: { status: "resolved", outcome: true, confidence: 0.9 },
    });
  });

  it("redacts secrets before writing a durable record", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ipredict-provenance-"));
    const store = new FileProvenanceStore(directory);

    await resolveMarket(market, [adapter({
      value: 123,
      apiKey: "secret",
      nested: { token: "secret" },
      sourceUrl: "https://example.test/result?api_key=secret",
    })], {
      provenanceStore: store,
      minAgreement: 1,
    });

    const stored = await store.get("42");
    expect(stored?.sources[0]?.raw).toEqual({
      value: 123,
      apiKey: "[REDACTED]",
      nested: { token: "[REDACTED]" },
      sourceUrl: "https://example.test/result?api_key=[REDACTED]",
    });
    expect(await readFile(path.join(directory, "42.json"), "utf8")).not.toContain("secret");
  });

  describe("Provenance Payload Hashes (Issue #913)", () => {
    it("computes deterministic sha256 hash for raw payloads", () => {
      const payload = { price: 42000, provider: "coingecko" };
      const hash1 = computePayloadHash(payload);
      const hash2 = computePayloadHash(payload);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it("handles string, buffer, and object payloads", () => {
      expect(computePayloadHash("hello")).toBe(computePayloadHash(Buffer.from("hello")));
      expect(computePayloadHash(null)).toBe("");
      expect(computePayloadHash(undefined)).toBe("");
    });

    it("attaches payloadHash to sources and aggregates into payloadHashes dictionary", () => {
      const rawPayload = { symbol: "BTC", price: 50000 };
      const mockResult: ResolutionResult = {
        status: "resolved",
        outcome: true,
        confidence: 0.95,
        sources: [
          {
            adapterId: "crypto-binance",
            provider: "binance",
            outcome: true,
            confidence: 0.95,
            raw: rawPayload,
          },
        ],
      };

      const record = createProvenanceRecord("market-123", mockResult);
      expect(record.payloadHashes).toBeDefined();
      const expectedHash = computePayloadHash(rawPayload);
      expect(record.payloadHashes?.["binance"]).toBe(expectedHash);
      expect(record.sources[0].payloadHash).toBe(expectedHash);
    });
  });
});
