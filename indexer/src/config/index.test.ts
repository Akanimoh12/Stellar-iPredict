import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Configuration Validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Clear indexer env vars to start from clean state
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    delete process.env.SOROBAN_RPC_URL;
    delete process.env.NETWORK_PASSPHRASE;
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.TOKEN_CONTRACT_ID;
    delete process.env.REFERRAL_CONTRACT_ID;
    delete process.env.LEADERBOARD_CONTRACT_ID;
    delete process.env.POLL_INTERVAL_MS;
    delete process.env.EVENTS_PER_PAGE;
    delete process.env.START_LEDGER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  const setValidEnv = () => {
    process.env.DATABASE_URL = "postgres://localhost:5432/db";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
    process.env.NETWORK_PASSPHRASE = "Test passphrase";
    process.env.MARKET_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    process.env.TOKEN_CONTRACT_ID = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    process.env.REFERRAL_CONTRACT_ID = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    process.env.LEADERBOARD_CONTRACT_ID = "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
    process.env.START_LEDGER = "100";
  };

  it("1. Config: Validates correct config successfully", async () => {
    setValidEnv();
    const { config } = await import("./index.js");
    expect(config.DATABASE_URL).toBe("postgres://localhost:5432/db");
    expect(config.SOROBAN_RPC_URL).toBe("https://soroban-testnet.stellar.org");
    expect(config.START_LEDGER).toBe(100);
  });

  it("2. Config: Fails fast on missing DATABASE_URL", async () => {
    setValidEnv();
    delete process.env.DATABASE_URL;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit(1)");
    }) as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(import("./index.js")).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it("3. Config: Fails fast on invalid DATABASE_URL format", async () => {
    setValidEnv();
    process.env.DATABASE_URL = "invalid-url";

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit(1)");
    }) as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(import("./index.js")).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it("4. Config: Fails fast on missing SOROBAN_RPC_URL", async () => {
    setValidEnv();
    delete process.env.SOROBAN_RPC_URL;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit(1)");
    }) as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(import("./index.js")).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("5. Config: Fails fast on missing START_LEDGER", async () => {
    setValidEnv();
    delete process.env.START_LEDGER;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit(1)");
    }) as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(import("./index.js")).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("6. Config: Fails fast on negative START_LEDGER", async () => {
    setValidEnv();
    process.env.START_LEDGER = "-5";

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit(1)");
    }) as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(import("./index.js")).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("7. Config: Coerces numeric inputs properly", async () => {
    setValidEnv();
    process.env.START_LEDGER = "12345";
    process.env.POLL_INTERVAL_MS = "3000";
    process.env.EVENTS_PER_PAGE = "50";

    const { config } = await import("./index.js");
    expect(config.START_LEDGER).toBe(12345);
    expect(config.POLL_INTERVAL_MS).toBe(3000);
    expect(config.EVENTS_PER_PAGE).toBe(50);
  });

  it("8. Config: Uses default values for optional settings", async () => {
    setValidEnv();
    const { config } = await import("./index.js");
    expect(config.POLL_INTERVAL_MS).toBe(5000);
    expect(config.EVENTS_PER_PAGE).toBe(200);
    expect(config.REDIS_URL).toBe("redis://localhost:6379");
  });
});
