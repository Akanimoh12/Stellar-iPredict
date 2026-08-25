import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadAggregatorConfig } from "../src/aggregator/config.js";
import { optionalEnv } from "../src/config/env.js";
import { loadMonitorConfig } from "../src/monitor/config.js";

describe("optionalEnv", () => {
  const schema = z.object({ HOOK: optionalEnv(z.string().url()) });

  it("treats an empty or whitespace value as unset", () => {
    expect(schema.parse({ HOOK: "" }).HOOK).toBeUndefined();
    expect(schema.parse({ HOOK: "   " }).HOOK).toBeUndefined();
    expect(schema.parse({}).HOOK).toBeUndefined();
  });

  it("still validates a value that is actually present", () => {
    expect(schema.parse({ HOOK: "https://example.com/hook" }).HOOK).toBe("https://example.com/hook");
    expect(() => schema.parse({ HOOK: "not-a-url" })).toThrow();
  });
});

// infra/.env.example ships every optional variable as `NAME=`, and Compose
// passes those through as empty strings. Both services must start on that
// file rather than rejecting it at startup.
describe("a .env file with blank optionals", () => {
  const shared = {
    DATABASE_URL: "postgres://ipredict:ipredict@postgres:5432/ipredict",
    SOROBAN_RPC_URL: "https://mainnet.sorobanrpc.com",
  };

  it("starts the aggregator with no resolver key and no finalize webhook", () => {
    const config = loadAggregatorConfig({ ...shared, RESOLVER_KEY: "", FINALIZE_WEBHOOK_URL: "" });
    expect(config.RESOLVER_KEY).toBeUndefined();
    expect(config.FINALIZE_WEBHOOK_URL).toBeUndefined();
  });

  it("starts the monitor with no alert webhook", () => {
    expect(loadMonitorConfig({ ...shared, ALERT_WEBHOOK_URL: "" }).ALERT_WEBHOOK_URL).toBeUndefined();
  });
});
