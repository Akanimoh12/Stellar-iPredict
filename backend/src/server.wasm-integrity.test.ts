import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { verifyDeployedWasm } from "@/server";
import { envSchema } from "@/config";

const wasm = new Uint8Array([0, 97, 115, 109]);
const hash = createHash("sha256").update(wasm).digest("hex");

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyInstance["log"] & {
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
}

describe("verifyDeployedWasm (#610)", () => {
  it("logs a SEV1 error when the deployed hash differs", async () => {
    const log = fakeLog();
    const results = await verifyDeployedWasm(log, {
      contractIds: ["CMARKET"],
      expectedHashes: `CMARKET=${"0".repeat(64)}`,
      fetchWasm: async () => wasm,
    });
    expect(results[0].status).toBe("mismatch");
    expect(log.error.mock.calls[0][0]).toMatchObject({ severity: "SEV1", contractId: "CMARKET", actual: hash });
  });

  it("logs info when the deployed hash matches", async () => {
    const log = fakeLog();
    const results = await verifyDeployedWasm(log, {
      contractIds: ["CMARKET"],
      expectedHashes: `CMARKET=${hash}`,
      fetchWasm: async () => wasm,
    });
    expect(results[0].status).toBe("match");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("treats blank contract ids from .env.example as unset", () => {
    const result = envSchema.safeParse({
      DATABASE_URL: "postgres://localhost/x",
      ORACLE_API_KEY: "k",
      MARKET_CONTRACT_ID: "",
      SOROBAN_RPC_URL: "",
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.MARKET_CONTRACT_ID).toBeUndefined();
  });

  it("rejects a malformed EXPECTED_WASM_HASHES at config load", () => {
    const result = envSchema.safeParse({
      DATABASE_URL: "postgres://localhost/x",
      ORACLE_API_KEY: "k",
      EXPECTED_WASM_HASHES: "CMARKET=nothex",
    });
    expect(result.success).toBe(false);
  });
});
