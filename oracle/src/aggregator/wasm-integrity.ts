import type { WasmCheckResult } from "@ipredict/shared";
import type { Logger } from "../log.js";

/**
 * Reports the startup WASM integrity check (issue #610). A mismatch is SEV1 —
 * the oracle would otherwise keep submitting resolutions to unaudited code —
 * but deliberately does not stop startup; see docs/DEPLOYMENT-GUIDE.md.
 */
export function alertContractWasmResults(
  results: readonly WasmCheckResult[],
  webhookUrl?: string,
  logger?: Logger,
  fetchImpl: typeof fetch = fetch,
): void {
  for (const result of results) {
    if (result.status === "match") {
      logger?.info("contract wasm hash verified", { ...result });
    } else if (result.status === "unpinned") {
      logger?.warn("contract wasm hash not pinned; set EXPECTED_WASM_HASHES", { ...result });
    } else if (result.status === "error") {
      logger?.warn("contract wasm hash could not be verified", { ...result });
    } else {
      const payload = { type: "oracle.aggregator.contract_wasm_mismatch", severity: "SEV1", ...result };
      logger?.error("CONTRACT WASM HASH MISMATCH: deployed code differs from the pinned audited build", payload);
      // ponytail: single attempt; the startup log line is the primary signal.
      if (webhookUrl) {
        fetchImpl(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "ipredict-oracle-monitoring-alerts/1.0" },
          body: JSON.stringify(payload),
        }).catch((error) => {
          logger?.error("failed to deliver contract wasm mismatch alert webhook", {
            contractId: result.contractId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  }
}
