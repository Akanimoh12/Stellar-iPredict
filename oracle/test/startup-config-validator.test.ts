import { describe, it, expect } from "vitest";
import { validateOracleStartupConfig, OracleConfigurationError } from "../src/config/env.js";

describe("Oracle Startup Configuration Validator (#1010)", () => {
  it("fails fast when SOROBAN_RPC_URL is missing", () => {
    expect(() => {
      validateOracleStartupConfig({});
    }).toThrow(OracleConfigurationError);

    try {
      validateOracleStartupConfig({});
    } catch (e: any) {
      expect(e.missingFields).toContain("SOROBAN_RPC_URL");
    }
  });

  it("fails fast when SOROBAN_RPC_URL has an invalid URL format", () => {
    expect(() => {
      validateOracleStartupConfig({ SOROBAN_RPC_URL: "invalid-not-a-url" });
    }).toThrow(OracleConfigurationError);
  });

  it("fails fast when required signing keys are requested but absent", () => {
    expect(() => {
      validateOracleStartupConfig(
        { SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org" },
        { requireSigningKeys: true }
      );
    }).toThrow(OracleConfigurationError);
  });

  it("fails fast when COUNCIL_QUORUM is less than COUNCIL_THRESHOLD", () => {
    expect(() => {
      validateOracleStartupConfig({
        SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        COUNCIL_THRESHOLD: "5",
        COUNCIL_QUORUM: "3", // Inconsistent: quorum < threshold
      });
    }).toThrow(OracleConfigurationError);
  });

  it("succeeds when all required configurations and thresholds are consistent", () => {
    const result = validateOracleStartupConfig({
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      RESOLVER_SECRET_KEY: "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      COUNCIL_THRESHOLD: "4",
      COUNCIL_QUORUM: "5",
    }, { requireSigningKeys: true, requireContract: true });

    expect(result.valid).toBe(true);
  });
});
