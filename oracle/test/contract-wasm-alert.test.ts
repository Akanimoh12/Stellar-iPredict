import { describe, expect, it, vi } from "vitest";
import { alertContractWasmResults } from "../src/aggregator/wasm-integrity.js";
import type { Logger } from "../src/log.js";

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

describe("alertContractWasmResults (#610)", () => {
  it("logs a SEV1 error on mismatch and stays quiet on match", () => {
    const logger = fakeLogger();
    alertContractWasmResults(
      [
        { contractId: "COK", status: "match", expected: "a", actual: "a" },
        { contractId: "CBAD", status: "mismatch", expected: "a", actual: "b" },
      ],
      undefined,
      logger,
    );
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toMatchObject({
      type: "oracle.aggregator.contract_wasm_mismatch",
      severity: "SEV1",
      contractId: "CBAD",
    });
  });

  it("warns when a contract is unpinned or unverifiable", () => {
    const logger = fakeLogger();
    alertContractWasmResults(
      [
        { contractId: "CNEW", status: "unpinned" },
        { contractId: "CDOWN", status: "error", error: "rpc down" },
      ],
      undefined,
      logger,
    );
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("posts mismatches to the alert webhook", () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    alertContractWasmResults(
      [{ contractId: "CBAD", status: "mismatch", expected: "a", actual: "b" }],
      "https://alerts.example/hook",
      fakeLogger(),
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ severity: "SEV1", contractId: "CBAD" });
  });
});
