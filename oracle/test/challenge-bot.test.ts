import { Keypair, rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChallengeBot } from "../src/aggregator/challenge-bot.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChallengeBot runtime kill switch", () => {
  it("can be disabled and re-enabled without replacing the bot instance", () => {
    const bot = new ChallengeBot({
      rpcUrl: "https://rpc.example.test",
      contractId: "C".repeat(56),
      adapters: [],
      challengerKeypair: Keypair.random(),
      networkPassphrase: "Test SDF Network ; September 2015",
      enabled: true,
      bondSpendGuard: vi.fn().mockResolvedValue(undefined),
    });

    expect(bot.isEnabled()).toBe(true);
    bot.setEnabled(false);
    expect(bot.isEnabled()).toBe(false);
    bot.setEnabled(true);
    expect(bot.isEnabled()).toBe(true);
    bot.stop();
  });

  it("keeps polling while disabled but does not validate or challenge submissions", async () => {
    const latestLedger = vi.spyOn(rpc.Server.prototype, "getLatestLedger")
      .mockResolvedValue({ sequence: 100 } as never);
    const getEvents = vi.spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValue({ events: [{}] } as never);
    const supports = vi.fn().mockReturnValue(true);
    const bot = new ChallengeBot({
      rpcUrl: "https://rpc.example.test",
      contractId: "C".repeat(56),
      adapters: [{ id: "test-adapter", supports, fetchOutcome: vi.fn() } as never],
      challengerKeypair: Keypair.random(),
      networkPassphrase: "Test SDF Network ; September 2015",
      enabled: false,
      pollIntervalMs: 60_000,
      bondSpendGuard: vi.fn().mockResolvedValue(undefined),
    });

    const start = bot.start();
    await vi.waitFor(() => expect(getEvents).toHaveBeenCalledOnce());
    bot.stop();
    await start;

    expect(latestLedger).toHaveBeenCalledOnce();
    expect(supports).not.toHaveBeenCalled();
  });
});
