import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { DataAdapter, Market } from "../src/adapters/index.js";
import { FileProvenanceStore, InMemoryProvenanceStore } from "../src/adapters/provenance.js";
import { resolveMarket } from "../src/adapters/resolve.js";

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

    await resolveMarket(market, [adapter({ value: 123 })], { provenanceStore: store });

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
});
