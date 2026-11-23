/**
 * Deployed contract WASM integrity check — issue #610.
 *
 * Off-chain services address contracts by id and trust that the code behind
 * the id is the audited build. An upgrade swaps the code without changing the
 * id, so each service compares the SHA-256 of the deployed WASM against a
 * pinned value at startup. A mismatch is reported, not fatal: blocking would
 * turn a forgotten hash update after a legitimate upgrade into an outage. See
 * docs/DEPLOYMENT-GUIDE.md § "Contract WASM integrity".
 *
 * Takes the WASM fetcher as a parameter so this package stays free of the
 * Stellar SDK; callers pass `rpc.Server#getContractWasmByContractId`.
 */

import { createHash } from "node:crypto";

export type WasmCheckStatus = "match" | "mismatch" | "unpinned" | "error";

export interface WasmCheckResult {
  contractId: string;
  status: WasmCheckStatus;
  expected?: string;
  actual?: string;
  error?: string;
}

/** Parses `EXPECTED_WASM_HASHES` — `contractId=sha256hex` pairs, comma-separated. */
export function parseExpectedWasmHashes(raw: string | undefined): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [id, hash, ...rest] = trimmed.split("=").map((s) => s.trim());
    if (!id || !hash || rest.length > 0 || !/^[0-9a-fA-F]{64}$/.test(hash)) {
      throw new Error(`EXPECTED_WASM_HASHES: malformed entry "${trimmed}" (want contractId=<64 hex chars>)`);
    }
    hashes.set(id, hash.toLowerCase());
  }
  return hashes;
}

/**
 * Checks every contract in `contractIds`. A contract with no pinned hash is
 * `unpinned` rather than skipped, so a missing pin is as visible as a mismatch.
 */
export async function verifyContractWasm(options: {
  contractIds: readonly string[];
  expected: ReadonlyMap<string, string>;
  fetchWasm: (contractId: string) => Promise<Uint8Array>;
}): Promise<WasmCheckResult[]> {
  return Promise.all(
    [...new Set(options.contractIds)].map(async (contractId): Promise<WasmCheckResult> => {
      const expected = options.expected.get(contractId);
      if (!expected) return { contractId, status: "unpinned" };
      try {
        const actual = createHash("sha256").update(await options.fetchWasm(contractId)).digest("hex");
        return { contractId, status: actual === expected ? "match" : "mismatch", expected, actual };
      } catch (error) {
        return { contractId, status: "error", expected, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}
