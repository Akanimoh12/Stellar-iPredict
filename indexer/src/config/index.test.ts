/**
 * Indexer configuration (issues #631 and #632).
 *
 * `loadConfig` is pure: it throws a shared `ConfigError` and never exits.
 * Importing the module validates nothing; `initConfig` is the explicit step.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Loaded after `vi.resetModules()` so the classes match the ones the config
 * module throws (a static import would be a stale copy of the module).
 */
const shared = () => import("@ipredict/shared");

const validEnv = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: "postgres://localhost:5432/db",
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test passphrase",
  MARKET_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  TOKEN_CONTRACT_ID: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  REFERRAL_CONTRACT_ID: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  LEADERBOARD_CONTRACT_ID: "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  START_LEDGER: "100",
});

/** Asserts `loadConfig(env)` throws a ConfigError naming `key`. */
async function expectInvalid(env: NodeJS.ProcessEnv, key: string) {
  const { ConfigError } = await shared();
  const { loadConfig } = await import("./index.js");
  let caught: unknown;
  try {
    loadConfig(env);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  expect((caught as ConfigError).service).toBe("ipredict-indexer");
  expect((caught as ConfigError).issues.map((i) => i.path.join("."))).toContain(key);
}

describe("indexer configuration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("1. validates a correct environment", async () => {
    const { loadConfig } = await import("./index.js");
    const config = loadConfig(validEnv());
    expect(config.DATABASE_URL).toBe("postgres://localhost:5432/db");
    expect(config.SOROBAN_RPC_URL).toBe("https://soroban-testnet.stellar.org");
    expect(config.START_LEDGER).toBe(100);
  });

  it("2. rejects a missing DATABASE_URL", async () => {
    const env = validEnv();
    delete env.DATABASE_URL;
    await expectInvalid(env, "DATABASE_URL");
  });

  it("3. rejects an invalid DATABASE_URL format", async () => {
    await expectInvalid({ ...validEnv(), DATABASE_URL: "invalid-url" }, "DATABASE_URL");
  });

  it("4. rejects a missing SOROBAN_RPC_URL", async () => {
    const env = validEnv();
    delete env.SOROBAN_RPC_URL;
    await expectInvalid(env, "SOROBAN_RPC_URL");
  });

  it("5. rejects a missing START_LEDGER", async () => {
    const env = validEnv();
    delete env.START_LEDGER;
    await expectInvalid(env, "START_LEDGER");
  });

  it("6. rejects a negative START_LEDGER", async () => {
    await expectInvalid({ ...validEnv(), START_LEDGER: "-5" }, "START_LEDGER");
  });

  it("7. coerces numeric inputs", async () => {
    const { loadConfig } = await import("./index.js");
    const config = loadConfig({
      ...validEnv(),
      START_LEDGER: "12345",
      POLL_INTERVAL_MS: "3000",
      EVENTS_PER_PAGE: "50",
    });
    expect(config.START_LEDGER).toBe(12345);
    expect(config.POLL_INTERVAL_MS).toBe(3000);
    expect(config.EVENTS_PER_PAGE).toBe(50);
  });

  it("8. applies defaults for optional settings", async () => {
    const { loadConfig } = await import("./index.js");
    const config = loadConfig(validEnv());
    expect(config.POLL_INTERVAL_MS).toBe(5000);
    expect(config.EVENTS_PER_PAGE).toBe(200);
    expect(config.REDIS_URL).toBe("redis://localhost:6379");
  });

  it("9. accepts EVENTS_PER_PAGE at the upper bound", async () => {
    const { loadConfig, MAX_EVENTS_PER_PAGE } = await import("./index.js");
    const config = loadConfig({ ...validEnv(), EVENTS_PER_PAGE: String(MAX_EVENTS_PER_PAGE) });
    expect(config.EVENTS_PER_PAGE).toBe(1000);
  });

  it("10. rejects EVENTS_PER_PAGE above the upper bound", async () => {
    await expectInvalid({ ...validEnv(), EVENTS_PER_PAGE: "1001" }, "EVENTS_PER_PAGE");
  });

  it("11. rejects an unreasonably large EVENTS_PER_PAGE", async () => {
    await expectInvalid({ ...validEnv(), EVENTS_PER_PAGE: "10000" }, "EVENTS_PER_PAGE");
  });

  it("12. importing the module neither validates nor exits", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit must not run on import");
    }) as never);
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(import("./index.js")).resolves.toBeTruthy();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) process.env.DATABASE_URL = previous;
      exit.mockRestore();
    }
  });

  it("13. reading config before initConfig is a programming error", async () => {
    const { ProgrammingError } = await shared();
    const { getConfig } = await import("./index.js");
    expect(() => getConfig()).toThrow(ProgrammingError);
  });

  it("14. initConfig stores the validated config for the config view", async () => {
    const { initConfig, config } = await import("./index.js");
    initConfig({ ...validEnv(), START_LEDGER: "777" });
    expect(config.START_LEDGER).toBe(777);
  });

  it("15. initConfig throws on invalid input instead of exiting", async () => {
    const { ConfigError } = await shared();
    const { initConfig } = await import("./index.js");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit must not run from library code");
    }) as never);
    try {
      expect(() => initConfig({})).toThrow(ConfigError);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it("9. Config: SOROBAN_RPC_URLS takes precedence over SOROBAN_RPC_URL", async () => {
    setValidEnv();
    process.env.SOROBAN_RPC_URL = "https://old.stellar.org";
    process.env.SOROBAN_RPC_URLS = "https://primary.stellar.org , https://secondary.stellar.org";

    const { config } = await import("./index.js");
    expect(config.SOROBAN_RPC_ENDPOINTS).toEqual([
      "https://primary.stellar.org",
      "https://secondary.stellar.org",
    ]);
  });

  it("10. Config: Single SOROBAN_RPC_URL produces one-element endpoints list", async () => {
    setValidEnv();
    delete process.env.SOROBAN_RPC_URLS;

    const { config } = await import("./index.js");
    expect(config.SOROBAN_RPC_ENDPOINTS).toEqual([
      "https://soroban-testnet.stellar.org",
    ]);
  });

  it("11. Config: Whitespace in SOROBAN_RPC_URLS is trimmed, duplicates removed", async () => {
    setValidEnv();
    process.env.SOROBAN_RPC_URLS =
      " https://a.stellar.org , https://b.stellar.org , https://a.stellar.org ";

    const { config } = await import("./index.js");
    expect(config.SOROBAN_RPC_ENDPOINTS).toEqual([
      "https://a.stellar.org",
      "https://b.stellar.org",
    ]);
  });
});
