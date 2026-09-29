import { describe, expect, it } from "vitest";
import {
  loadAdapterApiKeys,
  requireAdapterApiKey,
} from "../src/adapters/config.js";

describe("adapter API-key configuration", () => {
  it("loads all configured provider keys and trims whitespace", () => {
    const keys = loadAdapterApiKeys({
      COINGECKO_API_KEY: " gecko-key ",
      COINMARKETCAP_API_KEY: "cmc-key",
      SPORTDATA_API_KEY: "sport-key",
      THE_ODDS_API_KEY: "odds-key",
      METACULUS_API_KEY: "metaculus-key",
    });

    expect(keys).toEqual({
      coinGecko: "gecko-key",
      coinMarketCap: "cmc-key",
      sportData: "sport-key",
      theOdds: "odds-key",
      metaculus: "metaculus-key",
    });
  });

  it("supports documented aliases", () => {
    expect(
      loadAdapterApiKeys({
        CMC_API_KEY: "cmc-key",
        SPORTDATAAPI_API_KEY: "sport-key",
        THEODDS_API_KEY: "odds-key",
      }),
    ).toEqual({
      coinMarketCap: "cmc-key",
      sportData: "sport-key",
      theOdds: "odds-key",
    });
  });

  it("rejects blank credentials", () => {
    expect(() => loadAdapterApiKeys({ COINMARKETCAP_API_KEY: "   " })).toThrow(
      "COINMARKETCAP_API_KEY must not be blank",
    );
  });

  it("rejects conflicting canonical and alias values", () => {
    expect(() =>
      loadAdapterApiKeys({
        COINMARKETCAP_API_KEY: "one",
        CMC_API_KEY: "two",
      }),
    ).toThrow(/Conflicting environment variables for coinMarketCap/);
  });

  it("requires a key only when an adapter needs one", () => {
    expect(requireAdapterApiKey("coinMarketCap", { CMC_API_KEY: "cmc-key" })).toBe("cmc-key");
    expect(() => requireAdapterApiKey("coinMarketCap", {})).toThrow(
      "Missing API key for coinMarketCap; set COINMARKETCAP_API_KEY",
    );
  });

  it("does not include unset providers", () => {
    expect(loadAdapterApiKeys({})).toEqual({});
  });
});
