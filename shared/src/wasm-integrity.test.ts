/** Tests for the contract WASM integrity check (issue #610). Runs under `node:test`. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseExpectedWasmHashes, verifyContractWasm } from "./wasm-integrity.js";

const wasm = new Uint8Array([0, 97, 115, 109]);
const hash = createHash("sha256").update(wasm).digest("hex");

test("parseExpectedWasmHashes reads pairs and lowercases hashes", () => {
  const parsed = parseExpectedWasmHashes(` CA=${hash.toUpperCase()} , CB=${hash}`);
  assert.equal(parsed.get("CA"), hash);
  assert.equal(parsed.get("CB"), hash);
  assert.equal(parseExpectedWasmHashes(undefined).size, 0);
});

test("parseExpectedWasmHashes rejects malformed entries", () => {
  assert.throws(() => parseExpectedWasmHashes("CA"), /malformed/);
  assert.throws(() => parseExpectedWasmHashes("CA=abc"), /malformed/);
});

test("verifyContractWasm classifies match, mismatch, unpinned and error", async () => {
  const results = await verifyContractWasm({
    contractIds: ["OK", "BAD", "NEW", "DOWN", "OK"],
    expected: new Map([["OK", hash], ["BAD", "0".repeat(64)], ["DOWN", hash]]),
    fetchWasm: async (id) => {
      if (id === "DOWN") throw new Error("rpc unavailable");
      return wasm;
    },
  });
  assert.deepEqual(
    results.map((r) => [r.contractId, r.status]),
    [["OK", "match"], ["BAD", "mismatch"], ["NEW", "unpinned"], ["DOWN", "error"]],
  );
  assert.equal(results[1].actual, hash);
});
