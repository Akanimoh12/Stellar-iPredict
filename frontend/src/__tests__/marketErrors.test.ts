import { describe, it, expect } from "vitest";
import {
  MARKET_ERROR_MESSAGES,
  friendlyContractError,
  parseContractErrorCode,
} from "@/services/soroban";

describe("parseContractErrorCode", () => {
  it("reads the code from a host error string", () => {
    expect(parseContractErrorCode("HostError: Error(Contract, #5)")).toBe(5);
    expect(parseContractErrorCode("Error(Contract,#16)")).toBe(16);
  });

  it("returns null when the text names no contract error", () => {
    expect(parseContractErrorCode("network timeout")).toBeNull();
  });
});

describe("friendlyContractError", () => {
  it("translates a known market error code", () => {
    expect(friendlyContractError("Error(Contract, #5)")).toBe(
      "This market has closed for betting."
    );
  });

  it("returns null for unknown codes so the raw text is kept", () => {
    expect(friendlyContractError("Error(Contract, #999)")).toBeNull();
  });

  it("covers every MarketError code from 1 to 32", () => {
    for (let code = 1; code <= 32; code++) {
      expect(MARKET_ERROR_MESSAGES[code], `code ${code}`).toBeTruthy();
    }
  });

  it("never shows a raw host string for a mapped code", () => {
    const message = friendlyContractError("HostError: Error(Contract, #7)");
    expect(message).not.toMatch(/HostError|Error\(/);
  });
});
